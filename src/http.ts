import { discardBody } from './discard-body.js';
// Access 境界の判定とヘッダーの解決は `oauth-upstream.ts` にある実装を使う。
// `/register`・`/token` と同じ規則をここで書き直すと、片方だけ直った状態が
// 生まれる (PRJ-3-1580)。
import { accessAuthHeadersForUrl } from './oauth-upstream.js';
import {
  errorClassOf,
  recordUpstreamFailure,
  recordUpstreamRequest,
} from './telemetry/upstream.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * content-service のエラー本文 `details[]` の 1 項目 (PRJ-3-2017)。
 * `field` は `params.amount` / `contents.0.fileName` のような入力の場所。
 */
export type ApiErrorDetail = {
  field?: string;
  expected?: string;
  code?: string;
  message: string;
};

/**
 * エラー本文から読めた機械可読の情報 (PRJ-3-2017)。
 *
 * content-service は `{ statusCode, code, message, error, details, docsUrl }`
 * (429 / 409 FILE_NOT_READY は `retryAfter` も) を返す。旧形式の本文や JSON で
 * ない本文では `code` 等は無く、`details` は空配列になる。
 */
export type ApiErrorInfo = {
  code?: string;
  details: ApiErrorDetail[];
  docsUrl?: string;
  /** 再試行までの秒数 (本文 `retryAfter`、無ければ `Retry-After` ヘッダーの秒数) */
  retryAfter?: number;
};

export class HttpError extends Error {
  public readonly code?: string;
  public readonly details: ApiErrorDetail[];
  public readonly docsUrl?: string;
  public readonly retryAfter?: number;

  constructor(
    public readonly status: number,
    message: string,
    info: Partial<ApiErrorInfo> = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.code = info.code;
    this.details = info.details ?? [];
    this.docsUrl = info.docsUrl;
    this.retryAfter = info.retryAfter;
  }
}

/**
 * 「サーバーが要求を拒否しており、**書き込みは起きていない**」と確定できる
 * ステータス。これ以外 (5xx / 未知のステータス / 通信断) は、origin が commit の
 * 後で落ちる・プロキシが応答経路で 502 を返す等があるため確定できない。
 *
 * `copy-gallery-template.ts` はこれらへ個別の文言を返すので分岐を持っているが、
 * 「確定か否か」の判断はここを唯一の根拠にする。
 */
export const WRITE_REJECTED_STATUSES: ReadonlySet<number> = new Set([
  401, 403, 404, 412, 429,
]);

/** エラー文言に並べる `details` の上限 (多すぎると LLM への文脈を圧迫する)。 */
const MAX_DETAILS_IN_MESSAGE = 3;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const toApiErrorDetails = (raw: unknown): ApiErrorDetail[] => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): ApiErrorDetail[] => {
    if (typeof item !== 'object' || item === null) return [];
    const rec = item as Record<string, unknown>;
    const message = nonEmptyString(rec.message);
    if (message === undefined) return [];
    const field = nonEmptyString(rec.field);
    const expected = nonEmptyString(rec.expected);
    const code = nonEmptyString(rec.code);
    return [
      {
        ...(field !== undefined ? { field } : {}),
        ...(expected !== undefined ? { expected } : {}),
        ...(code !== undefined ? { code } : {}),
        message,
      },
    ];
  });
};

/**
 * 再試行までの秒数。本文の `retryAfter` を優先し、無ければ `Retry-After`
 * ヘッダーを読む。HTTP-date 形式など秒数として読めない値は捨てる (推測しない)。
 */
const parseRetryAfter = (
  bodyValue: unknown,
  header: string | null | undefined,
): number | undefined => {
  if (
    typeof bodyValue === 'number' &&
    Number.isFinite(bodyValue) &&
    bodyValue >= 0
  ) {
    return bodyValue;
  }
  if (header == null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim());
};

/**
 * 上流のエラー応答を `[status] CODE: message` + 補足行の文言にまとめる (PRJ-3-2017)。
 *
 * この文言は各ツールの catch 節で `エラー: ${err.message}` としてそのまま LLM に
 * 渡る。LLM が次の一手 (入力の修正 / 待って再試行 / プランの案内) を選べるよう、
 * `code`・入力の場所 (`details[].field`)・再試行秒数・ドキュメント URL を載せる。
 * 旧形式・非 JSON の本文では従来どおり `[status] message` だけになる。
 */
export const formatHttpErrorMessage = (
  status: number,
  message: string,
  info: ApiErrorInfo,
): string => {
  const lines = [
    `[${status}] ${info.code !== undefined ? `${info.code}: ` : ''}${message}`,
  ];
  if (info.details.length > 0) {
    const shown = info.details
      .slice(0, MAX_DETAILS_IN_MESSAGE)
      .map(
        (d) =>
          `${d.field !== undefined ? `${d.field}: ` : ''}${d.message}${
            d.expected !== undefined ? ` (expected: ${d.expected})` : ''
          }`,
      );
    const rest = info.details.length - shown.length;
    lines.push(
      `Details: ${shown.join('; ')}${rest > 0 ? ` (+${rest} more)` : ''}`,
    );
  }
  if (info.retryAfter !== undefined) {
    lines.push(`Retry after: ${info.retryAfter} seconds`);
  }
  if (info.docsUrl !== undefined) {
    lines.push(`Docs: ${info.docsUrl}`);
  }
  return lines.join('\n');
};

async function parseErrorBody(
  res: Response,
): Promise<{ message: string; info: ApiErrorInfo }> {
  // ヘッダーを持たない応答 (テストの簡易モック等) でも落ちないようにする。
  const retryAfterHeader = res.headers?.get('Retry-After');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // 非 JSON の本文 (プロキシの HTML 等) は従来どおり statusText だけを使う。
    return {
      message: res.statusText,
      info: {
        details: [],
        retryAfter: parseRetryAfter(undefined, retryAfterHeader),
      },
    };
  }
  const rec =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  // バリデーションエラー (VALIDATION_FAILED) だけは `message` が配列で返る。
  const rawMessage = Array.isArray(rec.message)
    ? rec.message.filter((m): m is string => typeof m === 'string').join('; ')
    : rec.message;
  const message =
    nonEmptyString(rawMessage) ??
    nonEmptyString(rec.error_description) ??
    res.statusText;
  const docsUrl = nonEmptyString(rec.docsUrl);
  return {
    message,
    info: {
      code: nonEmptyString(rec.code),
      details: toApiErrorDetails(rec.details),
      // 文言へ載せる URL は https のものだけ (想定外の本文を LLM に踏ませない)。
      docsUrl: docsUrl?.startsWith('https://') ? docsUrl : undefined,
      retryAfter: parseRetryAfter(rec.retryAfter, retryAfterHeader),
    },
  };
}

function withTimeout(
  signal: AbortSignal | null | undefined,
  ms: number,
): [AbortSignal, () => void] {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${ms}ms`)),
    ms,
  );

  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort);
    }
  }

  const clear = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
  return [controller.signal, clear];
}

/**
 * 呼び出し側のヘッダーへ Access の資格情報を重ねる (PRJ-3-1580)。
 *
 * `Headers` へ積み替えるのは、`HeadersInit` が `Record` / `Headers` /
 * `string[][]` の 3 形態を取るため。オブジェクトのスプレッドで足すと、
 * `Headers` インスタンスや配列を渡された場合に**呼び出し側のヘッダーが丸ごと
 * 消える**（この repo の呼び出し側は今は全部 `Record` だが、消え方が静かなので
 * 形に依存しない足し方にしておく）。
 *
 * Access の 2 つは **`set` で最後に**入れる。呼び出し側が同名のヘッダーを
 * 渡してきても、解決済みの値が勝つ。
 */
function withAccessAuth(
  headers: HeadersInit | undefined,
  accessHeaders: Record<string, string>,
): Headers {
  const merged = new Headers(headers);
  for (const [name, value] of Object.entries(accessHeaders)) {
    merged.set(name, value);
  }
  return merged;
}

/**
 * 外向き HTTP の**唯一の実行経路**。タイムアウト・ステータス検査・
 * テレメトリへの失敗記録をここ 1 箇所に集める。
 *
 * 公開ヘルパー (`fetchJson` / `fetchBinary*` / `fetchHeadersOnly`) は本文の
 * 読み方 (`readBody`) だけが違う。以前は 3 つが同じ「タイムアウト → fetch →
 * `!ok` なら HttpError」を各自に持っていたので、**上流失敗の記録を足すと
 * 記録漏れの箇所が 3 つ生まれる**（ヘルパーが増えれば増えるほど増える）。
 * 分岐ではなく経路を 1 本にして、漏れようが無い形にする。
 *
 * `clearTimer` はここの `finally` にあり、本文の読み取り (`readBody`) はその
 * **内側**で行う。従来どおり本文の読み取りもタイムアウトの保護下に置くため
 * （`Response` を返して呼び出し側に読ませる形にすると、この保護が外れる）。
 *
 * 記録するのはいずれも**観測できた事実**で、推測を含まない。リクエストを出した
 * ことそのもの (`recordUpstreamRequest`) と、次の 3 つの失敗:
 * - 応答が返らなかった → ステータス無し（DNS / 接続 / タイムアウト / 中断）
 * - 応答が `!ok` → そのステータス
 * - 応答は `ok` だが本文を読めなかった → ステータス + 読み取り側のクラス名
 *   （CDN が API 応答を SPA の HTML に差し替える経路がこれに当たる。
 *   `gallery-client.ts` の `getGalleryTemplateBySlug` 参照）
 */
async function request<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  readBody: (res: Response) => Promise<T>,
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, headers, ...rest } = init;

  // **fetch を出す前に解決する。** 2 値が片方だけ設定されているときは
  // `accessAuthHeadersForUrl` が投げるので、要求を出さずに落ちる。ここより後ろ
  // (タイマー作成・件数記録の後) に置くと、出していない要求を 1 本数えてしまう。
  const accessHeaders = accessAuthHeadersForUrl(url);
  // 「身元を載せた」= 要求先が Access 境界のホストで、かつ 2 値が揃っていた。
  // production (2 値未設定) と content-service へはこれが false のままなので、
  // 下の redirect の扱いも従来どおりになる。
  const usingAccessAuth = Object.keys(accessHeaders).length > 0;

  const [timeoutSignal, clearTimer] = withTimeout(signal, timeoutMs);
  // 失敗件数 0 を読めるようにするため、本数も数える（`upstream.ts` の
  // `buildUpstreamProperties` 参照）。
  recordUpstreamRequest();
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        ...rest,
        // Access ヘッダーを載せないときは、呼び出し側の `headers` を**そのまま**
        // 渡す（`Headers` へ正規化すると、従来この経路を通っていた全要求の
        // ヘッダー表現が変わる）。載せるときだけ `Headers` に積み替え、Access の
        // 2 つを **`set` で最後に**上書きする——呼び出し側が `CF-Access-*` を
        // 渡してきても、解決済みの値が勝つ（`oauth-upstream.ts` と同じ順序）。
        headers: usingAccessAuth
          ? withAccessAuth(headers, accessHeaders)
          : headers,
        // 身元を載せた要求だけ redirect を追従しない。Access は身元の無い要求を
        // 302 でログイン画面へ送り、既定の 'follow' はそれを追従して**ログイン
        // HTML を 200 の成功応答として**返す（PRJ-3-1573 の直接原因）。
        // 載せていない経路 (content-service / production) は従来どおり 'follow'
        // のままにする——この経路は署名 URL 等のリダイレクトを使う可能性があり、
        // 実挙動を確認できていないので変えない。
        ...(usingAccessAuth ? { redirect: 'manual' as const } : {}),
        signal: timeoutSignal,
      });
    } catch (err) {
      // 応答が返っていないのでステータスは観測できていない。
      recordUpstreamFailure({ errorClass: errorClassOf(err) });
      throw err;
    }
    if (usingAccessAuth && res.status >= 300 && res.status < 400) {
      // `redirect: 'manual'` を指定したこの経路でしか 3xx の応答は返らない
      // ('follow' では fetch が追従し切ってから返す)。
      //
      // **本文も `Location` も読まない・エラー文言へ入れない。** 中身は Access の
      // ログイン HTML (約 36.9 KiB) で、読んでも切り分けの役に立たないうえ、
      // 例外メッセージはログへ流れる。読まない本文はストリームを解放する。
      await discardBody(res);
      const redirectError = new HttpError(
        res.status,
        `[${res.status}] upstream redirected instead of answering ` +
          '(Cloudflare Access login? check RF_ACCESS_CLIENT_ID / RF_ACCESS_CLIENT_SECRET)',
      );
      recordUpstreamFailure({
        status: res.status,
        errorClass: errorClassOf(redirectError),
      });
      throw redirectError;
    }
    if (!res.ok) {
      const { message: msg, info } = await parseErrorBody(res);
      // クラス名は**実際に投げる例外から取る**。定数で持つと、`HttpError` の
      // `name` が変わったときに記録側だけ古い名前を送り続ける
      // (`parseErrorBody` は内部で握るので、ここまで来れば必ず throw に届く)。
      const httpError = new HttpError(
        res.status,
        formatHttpErrorMessage(res.status, msg, info),
        info,
      );
      recordUpstreamFailure({
        status: res.status,
        errorClass: errorClassOf(httpError),
      });
      throw httpError;
    }
    try {
      return await readBody(res);
    } catch (err) {
      recordUpstreamFailure({
        status: res.status,
        errorClass: errorClassOf(err),
      });
      throw err;
    }
  } finally {
    clearTimer();
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  return request(url, init, (res) => res.json() as Promise<T>);
}

/**
 * fetchJson の拡張版。レスポンスヘッダーも返す。
 * 生成状態 API (`GET /v1/file/status/{requestId}`) が生成中に返す
 * `Retry-After` を読むために使う (PRJ-3-2018)。
 */
export async function fetchJsonWithHeaders<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ data: T; headers: Headers }> {
  return request(url, init, async (res) => ({
    data: (await res.json()) as T,
    headers: res.headers,
  }));
}

export async function fetchBinary(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<ArrayBuffer> {
  const { data } = await fetchBinaryWithHeaders(url, init);
  return data;
}

/**
 * fetchBinary の拡張版。レスポンスヘッダーも返す。
 * content-service の sync エンドポイントが返す
 * `File-URL` / `Request-Id` / `X-File-Mapping` 等を読むために使う。
 *
 * 参照: developer-docs/openapi/content-service.yaml
 *   /v1/file/sync/single → 200 with headers (File-URL, Request-Id, X-File-Mapping)
 */
export async function fetchBinaryWithHeaders(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; headers: Headers }> {
  return request(url, init, async (res) => ({
    data: await res.arrayBuffer(),
    headers: res.headers,
  }));
}

/**
 * レスポンス本文を読まずにヘッダーだけ取得する。
 * content-service の sync エンドポイントは `File-URL` / `Request-Id` /
 * `X-File-Mapping` をヘッダーで返すため、PDF バイト列が不要なケース (HTTP モードで
 * fileUrl のみ利用する場合) では本文をメモリにバッファせずに済む。
 * 本文ストリームは明示的に cancel してコネクションを解放する。
 */
export async function fetchHeadersOnly(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Headers> {
  return request(url, init, async (res) => {
    // 本文は不要。バッファせずストリームを破棄する。
    //
    // **cancel の失敗をこの呼び出しの失敗にしない** (PRJ-3-1582)。ここまで来た
    // 時点でヘッダーは既に手元にあり、呼び出し側が求めたものは揃っている。
    // 素の `res.body?.cancel()` だと reject が `request` の readBody catch へ
    // 抜け、**取れている応答が上流失敗として記録されて throw される**。
    await discardBody(res);
    return res.headers;
  });
}
