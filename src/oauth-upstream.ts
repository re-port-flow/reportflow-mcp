/**
 * OAuth proxy (`POST /register` / `POST /token`) が上流 reposts-api を叩くときの
 * 共通処理を 1 箇所に集める。
 *
 * ── なぜ要るのか (PRJ-3-1573 / 2026-09-05 実測) ───────────────────────────────
 * staging の上流 `https://stg.re-port-flow.com/api/v1` は Cloudflare Access
 * (`staging_api` application。infra-tool `cloudflare/main.tf`) の裏に居る。
 * policy は「Make.com の IP は bypass」「WARP デバイスは allow」だけで、
 * **サーバー間要求には身元が無い**。Access は身元の無い要求を 302 でログイン画面へ
 * 転送し、`fetch` は既定 (`redirect: 'follow'`) でそれを自動追従して、Access の
 * ログイン HTML (約 36.9 KiB) を **HTTP 200 の成功応答**として claude.ai へ
 * 返していた。claude.ai は RFC 7591 の DCR JSON として解釈できず
 * 「StgReportFlow のサインインサービスに登録できませんでした」で停止する。
 * Workers Logs では `POST /register` が 3 回 200 / 36,936〜36,937 bytes。
 *
 * ── 直し方は 2 つで、両方要る ─────────────────────────────────────────────────
 * 1. **身元を載せる** — Service Auth (`CF-Access-Client-Id` /
 *    `CF-Access-Client-Secret`)。同じ Access 境界に対して send-flow が既に
 *    採っている形 (infra-tool `cloudflare/send-flow-rf-access.tf`)。
 * 2. **fail-closed にする** — 身元が正しくても、token 失効・policy 変更・経路の
 *    都合で redirect や HTML が返ることはある。「2xx なら成功」で透過している
 *    限り同じ壊れ方が再発する。redirect を追従せず、2xx は**期待する JSON で
 *    あることを確かめてから**返す。1 だけでは同じ P1 がもう一度出る。
 *
 * ── production は従来どおり ───────────────────────────────────────────────────
 * production の RF API は Access の裏に居ない。2 値とも未設定なら Access
 * ヘッダーを載せず、既存の経路がそのまま動く (新しい必須 secret を作らない)。
 */

// 「読まない本文を解放する」は telemetry / http.ts とも共通の作法なので、
// 実装は `discard-body.ts` に 1 つだけ置く (PRJ-3-1582)。cancel の失敗で
// `redirect` / `body_too_large` の分類が塗り替わらない性質もそちらの責務。
import { cancelQuietly, discardBody } from './discard-body.js';
// Access 境界の識別子 (= どのホストが Access の裏か) の唯一の根拠。
import { getMainApiBaseUrl } from './config.js';

/**
 * Cloudflare Access Service Token の Client ID / Client Secret を渡す環境変数名。
 *
 * **`CF_ACCESS_*` ではなく `RF_ACCESS_*` にした理由。** 同じ Access 境界
 * (`stg.re-port-flow.com/api/v1`) を通るために send-flow が使っている
 * `SEND_FLOW_RF_ACCESS_CLIENT_ID` / `..._SECRET` と末尾を揃える
 * (infra-tool `services/github/actions-secrets-send-flow.tf`)。片方を設定した
 * 人がもう片方を設定するとき、同じ語で探せるようにする。
 *
 * **既存の `REPORTFLOW_CLIENT_ID` とは別物。** あちらは OAuth2 の `client_id`
 * (認可サーバーに名乗るアプリ ID) で、こちらは Cloudflare Access に名乗る
 * service token の ID。名前空間を分けるために `REPORTFLOW_` 接頭辞は使わない。
 *
 * infra-tool 側の対応 (PRJ-3-1577):
 * - Cloudflare: `reportflow_mcp_staging_rf_access_service_token_name`
 * - GitHub Environment `Staging` の secret 名: この 2 つと同名
 */
export const ACCESS_CLIENT_ID_ENV = 'RF_ACCESS_CLIENT_ID';
export const ACCESS_CLIENT_SECRET_ENV = 'RF_ACCESS_CLIENT_SECRET';

/**
 * 上流 OAuth エンドポイントへの待ち時間上限。
 *
 * 無制限だと、Access や上流が黙って握ったときにクライアント (claude.ai) 側の
 * タイムアウトまで何も返せない。`http.ts` の既定 (30s) より短くするのは、
 * ここが DCR / token 交換という**対話の途中**で、待たせるより早く
 * 「失敗した」と返したほうが再試行が効くため。
 */
export const UPSTREAM_TIMEOUT_MS = 15_000;

export type AccessServiceAuth = {
  readonly clientId: string;
  readonly clientSecret: string;
};

/** 2 値の片方だけが設定されている (= 誰も通れない設定) ときに投げる。 */
export class AccessServiceAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessServiceAuthConfigError';
  }
}

const readTrimmed = (env: NodeJS.ProcessEnv, key: string): string =>
  env[key]?.trim() ?? '';

/**
 * 環境変数から Service Auth の 2 値を解決する。
 *
 * - **両方未設定 (または空白のみ)**: `null`。Access ヘッダーを載せない
 *   (production・ローカル・stdio の従来動作)。
 * - **両方設定**: その組。
 * - **片方だけ**: `AccessServiceAuthConfigError` を投げる (fail-fast)。
 *   片方だけ載せても Access は身元の無い要求として扱うので、**設定したのに
 *   直らない**という一番読み解きにくい壊れ方になる。起動時に落とす。
 *
 * **例外メッセージに値を入れない。** 入るのは環境変数の「名前」だけ。
 * 例外はCloudflare Workers Logsに残る。
 */
export const resolveAccessServiceAuth = (
  env: NodeJS.ProcessEnv = process.env,
): AccessServiceAuth | null => {
  const clientId = readTrimmed(env, ACCESS_CLIENT_ID_ENV);
  const clientSecret = readTrimmed(env, ACCESS_CLIENT_SECRET_ENV);

  if (clientId === '' && clientSecret === '') return null;

  if (clientId === '' || clientSecret === '') {
    const present =
      clientId === '' ? ACCESS_CLIENT_SECRET_ENV : ACCESS_CLIENT_ID_ENV;
    const missing =
      clientId === '' ? ACCESS_CLIENT_ID_ENV : ACCESS_CLIENT_SECRET_ENV;
    throw new AccessServiceAuthConfigError(
      `Cloudflare Access service auth is half-configured: ${present} is set but ${missing} is not. ` +
        'Set both or neither (production leaves both unset).',
    );
  }

  return { clientId, clientSecret };
};

/** 上流 fetch に載せる Access ヘッダー。未設定なら空 (= 従来動作)。 */
export const accessAuthHeaders = (
  auth: AccessServiceAuth | null,
): Record<string, string> =>
  auth === null
    ? {}
    : {
        'CF-Access-Client-Id': auth.clientId,
        'CF-Access-Client-Secret': auth.clientSecret,
      };

/**
 * HTTP(S) URL の origin (`scheme://host[:port]`)。読めない URL と http(s) 以外の
 * スキームは `null`。
 *
 * **host ではなく origin で見る。** `URL.host` は scheme を含まないので、
 * `https://re-port-flow.com` と `http://re-port-flow.com` が**同じ値になる**
 * (既定ポートは省略されるので port でも区別できない)。host で比較すると、
 * 基準が https でも平文 http の要求が境界内と判定され、`CF-Access-Client-Secret`
 * が平文で出る。https へ張り替えるリダイレクトがあっても、**最初の平文要求は
 * もう取り消せない** (PR #136 の CodeRabbit 指摘)。
 *
 * 同じ理由で http(s) 以外のスキームは境界外にする。判定に迷ったときは資格情報を
 * 載せない側へ倒す。
 */
const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
};

/**
 * 要求先が Cloudflare Access 境界の内側か (PRJ-3-1580)。
 *
 * **判定は origin の一致だけで行う。パスで分けない。** 同じホストに
 * `/public/templates` (everyone bypass) と `/{ws}/my/templates/...` (要認証) が
 * 同居しているので、パスで分けても分岐が増えるだけで、新しいエンドポイントが
 * 増えるたびに一覧を更新し忘れる面ができる。bypass のパスへヘッダーを載せても
 * 害は無い (Access は身元を無視して通す)。
 *
 * 基準は `getMainApiBaseUrl()` の origin。`REPORTFLOW_AUTH_URL` で上書きした
 * 環境ではその上書き先が基準になる——「トークンを取りに行く先」と「API を叩く先」は
 * 同じ origin なので、片方だけ Access 境界の判定から外れることがない。基準自体が
 * http の環境 (ローカルの開発サーバー等) では http の要求だけが一致する。
 * **scheme を跨いだ一致は起こらない。**
 *
 * **読めない URL は「境界の外」として扱う。** 判定に迷ったときに資格情報を
 * 送らない側へ倒す (送ってしまうと取り消せない)。
 */
export const isAccessBoundaryUrl = (url: string): boolean => {
  const target = originOf(url);
  if (target === null) return false;
  const boundary = originOf(getMainApiBaseUrl());
  return boundary !== null && target === boundary;
};

/**
 * その URL へ載せる Access ヘッダー。**載せるのは 2 条件が揃ったときだけ**:
 * 要求先が Access 境界のホストで、かつ Service Token の 2 値が設定されている。
 *
 * `http.ts` は content-service (`api.*.re-port-flow.com`) とも共用の経路なので、
 * ホスト判定を外すと **Access と無関係のホストへ資格情報を送る**ことになる。
 * それが起きていないことは `http.spec.ts` の対のテストが固定している。
 *
 * 片方だけ設定されている場合は `resolveAccessServiceAuth` が例外を投げる
 * (fail-fast)。**境界の外のホストではその判定に入らない**ので、半端な設定が
 * content-service への要求を巻き添えで落とすことはない。
 */
export const accessAuthHeadersForUrl = (
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> =>
  isAccessBoundaryUrl(url)
    ? accessAuthHeaders(resolveAccessServiceAuth(env))
    : {};

/** 上流応答を成功として扱わなかった理由。ログの `rejection=` に出る値。 */
export type UpstreamRejection =
  | 'redirect'
  | 'non_json_content_type'
  | 'empty_body'
  | 'invalid_json'
  | 'missing_required_field'
  | 'non_json_error_body'
  | 'body_too_large'
  | 'timeout'
  | 'network_error';

/**
 * 本文を読む上限。DCR / token の応答は数百バイト〜数 KiB で、Access の
 * ログイン HTML でも約 36.9 KiB。**64 KiB にしてあるのは、Access の HTML を
 * 読ませて `non_json_content_type` として分類させたいため**——切り分けの手掛かり
 * になるので、そこは落とさない。上限が効くのはそれより病的に大きい応答だけで、
 * どうせ 502 にする本文を全量メモリへ確保するのを避ける。
 *
 * **上限は「実際に読んだバイト数」で効かせる。** `content-length` の宣言値だけを
 * 見ていると、それは**申告してきた相手にだけ効く上限**でしかない。宣言の無い
 * chunked 応答は `res.text()` が全量をメモリへ積むので、上限を宣言した意味が
 * 無くなる（相手は Access の裏に居る上流だが、`/register` は未認証で叩ける口で、
 * 上流が CDN・WAF・プロキシに差し替わる経路もある）。
 */
const MAX_BODY_BYTES = 64 * 1024;

/** 宣言された本文長。無い・壊れている場合は null（＝宣言値による早期拒否をしない）。 */
const declaredLengthOf = (contentLength: string | null): number | null => {
  if (contentLength === null) return null;
  const parsed = Number.parseInt(contentLength, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

type BodyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly rejection: 'body_too_large' };

/**
 * 本文を `limit` バイトまで読む。超えた時点で読み残しを捨てて `body_too_large`。
 *
 * `res.text()` を使わないのは、それが**全量を読み切ってから**返すため
 * （上限は読み終わった後にしか判定できない）。
 *
 * 数えるのは chunk の**バイト長**で、`String` の長さではない。UTF-8 では
 * 1 文字が 1 バイト以上なので、バイト数を抑えれば文字列も抑えられる。
 * 保持量の最悪値は `limit` + 1 chunk（超過を検出した chunk は既に受信済み）。
 *
 * 途中の読み取り失敗は**投げてそのまま呼び出し側へ返す**。ストリームは既に
 * error 状態なので掴み残しは無く、`network_error` / `timeout` の分類は
 * `rejectionForError` の 1 箇所に集めたままにできる。
 */
const readBodyWithLimit = async (
  res: Response,
  limit: number,
): Promise<BodyRead> => {
  const body = res.body;
  // 本文の無い応答（204 等）では `null`。空文字として扱い、2xx なら
  // `classifyUpstreamBody` が `empty_body` で落とす。
  if (body === null) return { ok: true, text: '' };

  const reader = body.getReader();
  // `stream: true` を付ける。chunk 境界に跨いだ UTF-8 の 1 文字を、
  // chunk ごとに独立して decode すると U+FFFD に化ける。
  const decoder = new TextDecoder('utf-8');
  let readBytes = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    readBytes += value.byteLength;
    if (readBytes > limit) {
      // **cancel の失敗で `body_too_large` を塗り替えない。** 素の
      // `reader.cancel()` を await していると、reject が呼び出し側
      // (`callOAuthUpstream` の catch) へ抜けて `rejectionForError` が
      // `network_error` に分類し直す——「上限を超えた」という確定済みの事実が
      // 「上流に届かなかった」に化ける (PRJ-3-1581 の CodeRabbit 指摘)。
      await cancelQuietly(reader);
      return { ok: false, rejection: 'body_too_large' };
    }
    text += decoder.decode(value, { stream: true });
  }

  // 末尾に不完全なバイト列が残っていた場合をここで確定させる。
  return { ok: true, text: text + decoder.decode() };
};

export type UpstreamProxyResult =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly rejection: UpstreamRejection };

const isJsonContentType = (contentType: string | null): boolean => {
  if (contentType === null) return false;
  const essence = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return essence === 'application/json' || essence.endsWith('+json');
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

type ParsedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

/**
 * **`undefined` を「parse 失敗」の印に使わない。** `JSON.parse('undefined')` は
 * 例外を投げ、`JSON.parse('null')` は `null` を返す。返り値で成否を区別しようと
 * するとどちらかを取り違えるので、成否そのものをタグで持つ。
 */
const tryParseJson = (text: string): ParsedJson => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

/**
 * 上流応答の本文を検査して、そのままクライアントへ返してよいかを決める純関数。
 *
 * **合否の判定は Content-Type ではなく「JSON として読めて必須項目がある」ことで
 * 決める。** Access のログイン HTML は JSON parse で必ず落ちるので、
 * Content-Type を合否に使っても捕まる件数は増えない。一方で Content-Type を
 * 必須にすると、上流や経路が正しい JSON に別の Content-Type を付けただけで
 * **正常な DCR を 502 にしてしまう** (= 直したはずの P1 が別原因で再発する)。
 * Content-Type は**分類とログ**にだけ使い、`non_json_content_type` として
 * 「Access の HTML が返っている」を運用側が一目で切り分けられるようにする。
 *
 * 4xx / 5xx は「JSON として読めれば」status ごと透過する (RFC 6749 §5.2 /
 * RFC 7591 §3.2.2 の正規エラー応答を壊さない)。読めない 4xx / 5xx は Access や
 * 経路が返した HTML なので、本文を転送せず 502 のプロキシエラーにする。
 *
 * **上流の 429 (レート制限) が 502 に化けないことは確認済み。** WAF の
 * `POST /api/v1/oauth/register` レート制限 (5 req / 60s per IP) は
 * `content_type = "application/json"` で
 * `{"error":"rate_limit_exceeded", ...}` を返す
 * (infra-tool `cloudflare/rate-limit-rules-oauth-register.tf` の
 * `action_parameters.response`)。JSON として読めるので **429 と本文がそのまま
 * クライアントへ届く**。ここを「非 2xx は全部 502」にすると、この
 * 「時間を置けば直る」失敗が「壊れている」に見えるようになる。
 */
export const classifyUpstreamBody = (args: {
  readonly status: number;
  readonly contentType: string | null;
  readonly text: string;
  readonly requiredField: string;
}): UpstreamProxyResult => {
  const { status, contentType, text, requiredField } = args;

  // 3xx は呼び出し側 (callOAuthUpstream) で先に落とす。純関数単体でも同じ判定に
  // なるよう、ここでも同じ結論を返す。
  if (status >= 300 && status < 400) {
    return { ok: false, rejection: 'redirect' };
  }

  const parsed = tryParseJson(text);

  if (status >= 400) {
    if (!parsed.ok) return { ok: false, rejection: 'non_json_error_body' };
    return { ok: true, status, body: text };
  }

  if (text.trim() === '') return { ok: false, rejection: 'empty_body' };
  if (!parsed.ok) {
    return {
      ok: false,
      rejection: isJsonContentType(contentType)
        ? 'invalid_json'
        : 'non_json_content_type',
    };
  }

  const record = asRecord(parsed.value);
  if (record === null) return { ok: false, rejection: 'invalid_json' };

  const value = record[requiredField];
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, rejection: 'missing_required_field' };
  }

  return { ok: true, status, body: text };
};

/**
 * 例外から**名前だけ**を取る。`message` は取らない — 上流由来の文字列が
 * message に載る経路 (`HttpError` 等) があり、そこへ本文が混ざるとログに
 * Access の HTML が出る。切り分けに必要なのは種別 (`TimeoutError` /
 * `TypeError` 等) だけ。
 *
 * **`instanceof Error` で絞らない。** `AbortSignal.timeout()` の中断は
 * `DOMException`（`name === 'TimeoutError'`）で届く。素の Node では
 * `DOMException instanceof Error` は true だが、**realm を跨ぐと false になる**
 * ——`fetch` の実装は Node の realm に居るので、別 realm（Jest の vm サンドボックス、
 * `vm`、worker）から見ると `instanceof` が外れ、timeout が `unknown` →
 * `network_error` に化けて**分類だけが静かに間違う**（この形は実測で踏んだ:
 * 実サーバー相手の中断テストが `network_error` を返した）。
 *
 * 判定に要るのは `name` プロパティが文字列であることだけなので、そこだけを見る
 * （プロトタイプ鎖に依存しない）。値は `safeLogValue` で無害化してから出す。
 */
export const errorNameOf = (err: unknown): string => {
  if (typeof err !== 'object' || err === null) return 'unknown';
  const name = (err as { readonly name?: unknown }).name;
  return typeof name === 'string' && name !== '' ? name : 'unknown';
};

/**
 * `AbortSignal.timeout()` の中断は `TimeoutError` (Node v22.22.2 で実測)。
 * undici が別名で伝える経路 (`AbortError`) も timeout として扱う — どちらも
 * 「上流が期限内に返さなかった」であり、運用側の次の手 (上流・Access の疎通
 * 確認) は同じ。
 */
const rejectionForError = (err: unknown): UpstreamRejection => {
  const name = errorNameOf(err);
  return name === 'TimeoutError' || name === 'AbortError'
    ? 'timeout'
    : 'network_error';
};

const LOG_VALUE_MAX = 120;

/** ログ行を壊す / 注入されるのを防ぐ (制御文字を潰して長さを切る)。 */
const safeLogValue = (raw: string): string =>
  // eslint-disable-next-line no-control-regex
  raw.replace(/[\u0000-\u001F\u007F]+/g, ' ').slice(0, LOG_VALUE_MAX);

/**
 * ログに出す上流のパス。**query は落とす** — `/token` 系の URL に将来クエリが
 * 付いたときに、そこへ載った値がログへ流れる経路を作らないため。
 * URL として読めない値でもログを壊さない (ログ処理が例外を投げると、
 * 「なぜ落としたか」の記録ごと失う)。
 */
export const upstreamPathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return '(unparsable)';
  }
};

/**
 * 上流を成功として扱わなかった事実だけを構造化して残す。
 *
 * **出さないもの**: Client ID / Client Secret / Authorization / access token /
 * 上流の本文 (Access のログイン HTML) / `Location` / DCR の request body。
 * 出すのは切り分けに要る最小限 — どのエンドポイントか、上流のどのパスか、
 * どう分類したか、status、Content-Type、例外の名前だけ。
 * (Notion PRJ-3-1573「ログはstatus・content-type・request path・安全な分類だけ」)
 */
const logRejection = (
  endpoint: string,
  url: string,
  rejection: UpstreamRejection,
  detail: {
    readonly status?: number;
    readonly contentType?: string | null;
    readonly errorName?: string;
  },
): void => {
  const parts = [
    '[reportflow-mcp] oauth-proxy upstream rejected',
    `endpoint=${endpoint}`,
    `path=${safeLogValue(upstreamPathOf(url))}`,
    `rejection=${rejection}`,
  ];
  if (detail.status !== undefined) parts.push(`status=${detail.status}`);
  if (detail.contentType !== undefined) {
    parts.push(`content_type=${safeLogValue(detail.contentType ?? '(none)')}`);
  }
  if (detail.errorName !== undefined) {
    parts.push(`error=${safeLogValue(detail.errorName)}`);
  }
  console.error(parts.join(' '));
};

/**
 * OAuth proxy の上流呼び出し。**この 1 箇所が** Access ヘッダーの付与・
 * redirect 不追従・タイムアウト・応答の契約検査・安全なログを持つ。
 *
 * 呼び出し側 (`/register` / `/token`) が個別に持つと、片方だけ直った状態が
 * 生まれる (この不具合がまさにそれ: `/authorize` は 302 を返すだけで無事、
 * `/register` と `/token` が同じ穴を 2 つ持っていた)。
 */
export const callOAuthUpstream = async (args: {
  readonly endpoint: 'register' | 'token';
  readonly url: string;
  readonly body: string;
  /** 2xx を成功と認めるために必須の項目 (`client_id` / `access_token`)。 */
  readonly requiredField: string;
  readonly headers?: Record<string, string>;
  readonly accessAuth: AccessServiceAuth | null;
  /**
   * 待ち時間上限の上書き。既定は `UPSTREAM_TIMEOUT_MS`。
   * **設定の seam であってテスト専用の抜け穴ではない**——`AbortSignal.timeout()`
   * による実際の中断が `timeout` として分類されることを、15 秒待たずに
   * 実サーバー相手に確かめるために要る (oauth-upstream.spec.ts)。
   */
  readonly timeoutMs?: number;
}): Promise<UpstreamProxyResult> => {
  const {
    endpoint,
    url,
    body,
    requiredField,
    headers = {},
    accessAuth,
    timeoutMs = UPSTREAM_TIMEOUT_MS,
  } = args;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        // Access の資格情報は**最後に**載せる。クライアント由来のヘッダー
        // (`Authorization` 等) を先に展開しているので、順序を逆にすると
        // 外から上書きできる形になる。
        ...accessAuthHeaders(accessAuth),
      },
      body,
      // Access は身元の無い要求を 302 でログイン画面へ送る。既定の 'follow' は
      // それを追従して HTML を 200 として返してしまう (この不具合の直接原因)。
      //
      // **Node では `manual` でも実 status が見える** (Node v22.22.2 で実測:
      // status=302 / type=basic / Location と Content-Type が読める)。ブラウザ
      // 仕様の opaqueredirect (status 0) にはならないので、下の 3xx 判定が効く。
      // 仮に将来 status 0 になっても 2xx 側へ落ちて `empty_body` で 502 になる
      // (fail-closed は保たれ、分類名だけがずれる)。
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const rejection = rejectionForError(err);
    logRejection(endpoint, url, rejection, { errorName: errorNameOf(err) });
    return { ok: false, rejection };
  }

  const status = res.status;
  const contentType = res.headers.get('content-type');

  if (status >= 300 && status < 400) {
    // 本文も `Location` も読まない・返さない・記録しない。読まない本文は
    // 掴んだままにせず解放する。
    await discardBody(res);
    logRejection(endpoint, url, 'redirect', { status, contentType });
    return { ok: false, rejection: 'redirect' };
  }

  // 宣言長が上限を超える応答は**1 バイトも読まずに**落とす。どうせ 502 にする
  // 本文を全量メモリへ確保しない (`/register` は WAF のレート制限があるとはいえ
  // 未認証で叩ける口なので、1 要求あたりの確保量を抑える意味がある)。
  //
  // **これは早期拒否であって上限そのものではない。** 宣言しない相手には効かない
  // ので、本当の上限は下の `readBodyWithLimit` が実測で効かせる。
  const declaredLength = declaredLengthOf(res.headers.get('content-length'));
  if (declaredLength !== null && declaredLength > MAX_BODY_BYTES) {
    await discardBody(res);
    logRejection(endpoint, url, 'body_too_large', { status, contentType });
    return { ok: false, rejection: 'body_too_large' };
  }

  let read: BodyRead;
  try {
    read = await readBodyWithLimit(res, MAX_BODY_BYTES);
  } catch (err) {
    const rejection = rejectionForError(err);
    logRejection(endpoint, url, rejection, {
      status,
      contentType,
      errorName: errorNameOf(err),
    });
    return { ok: false, rejection };
  }

  if (!read.ok) {
    logRejection(endpoint, url, read.rejection, { status, contentType });
    return read;
  }

  const result = classifyUpstreamBody({
    status,
    contentType,
    text: read.text,
    requiredField,
  });
  if (!result.ok) {
    logRejection(endpoint, url, result.rejection, { status, contentType });
  }
  return result;
};
