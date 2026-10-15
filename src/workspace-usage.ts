// MCP セッション内から有料プランへ進める導線 (PRJ-3-1375)。
//
// ## なぜ要るか
// 本番実測 (2026-07-18〜08-17): 新規ワークスペース 531 に対し PDF 生成へ到達した
// WS は 9 件、外部からの有料契約は 0 件 (経営会議 2026-08-15)。MCP から使い始めた
// ユーザーは Web UI を開かないため、ツール応答・description・instructions の
// どこにもプラン / 使用量 / アップグレードの導線が無い現状は「支払い経路が存在
// しない」に等しい (`grep -rniE "upgrade|プラン|pricing|料金|billing|有料" src/`
// が 0 件だった)。
//
// ## 設計の 4 原則
// 1. **生成を壊さない**: 使用量の取得は生成が成功した**後**に行い、失敗・タイム
//    アウトは黙って省く (`resolvePlanNotice` は例外を投げない)。生成の失敗へ
//    昇格させない。
// 2. **推測値を書かない**: `limit` が null のとき「上限 X 件」と書かない。取得
//    できなかったときは 0 件と書かず、そもそも `plan` ブロックを付けない。
// 3. **URL を発明しない**: 遷移先は reports-ui の実ルート `/:workspaceId/plan`
//    (`app/src/routes/index.tsx`)。本番配信バンドルにも `path:"/:workspaceId"`
//    → `path:"plan"` が含まれることを実測済み (2026-08-17)。
// 4. **無料プラン以外へ宣伝しない**: 有料プランの WS には煽り文も URL も出さず、
//    使用量の事実だけを返す。
//
// ## 契約
// 応答テキストの構造化 JSON へ `plan` キーとして載せる。テキストの末尾に段落を
// 足す形にしないのは、`generate_pdf_async` / `generate_pdfs_*` の text が
// **JSON そのもの**で、後ろに文章を足すと JSON.parse できなくなるため。

import { getAuthHeaders, getAuthWorkspaceId } from './auth.js';
import { fetchJson } from './http.js';
import { getAppKey, getMainApiBaseUrl } from './gallery-client.js';

/**
 * reposts-api `GET /workspace/:workspaceId/file-usage` のレスポンス。
 * 実体は `app/src/applications/modules/workspace/dto/file-usage.response.ts`
 * (`FileUsageResponse`)。
 *
 * - **`used` / `limit` の単位は「ページ数」であって「PDF の本数」ではない**。
 *   `used` は当月に出力したファイルの `export_size` の合計で
 *   (`file.repository.service.ts countMonthlyUsage`)、`limit` は
 *   `m_plan_limits.max_file_times`。content-service 側の上限判定も同じページ数で
 *   行われる (`design.repository.service.ts`: 「利用量・課金はページ数
 *   （exportSize の合計）で集計するため、上限判定もページ数で行う」→
 *   `usedPages >= planType.maxFileTimes` で 403)。「10 件生成できます」と書くと
 *   複数ページ帳票で必ず外れるため、文言も項目名もページで統一する。
 * - `limit` / `remaining` は null になり得る。null の意味は**一意ではない**:
 *   DTO の説明は「null は無制限」だが、実装 (`workspace.usecase.ts getFileUsage`)
 *   はワークスペースにプラン行が無い / プラン上限レコードが無いときにも null を
 *   返す。したがって null を「無制限」と断定して文章にしてはいけない。
 * - `percentage` は `limit` が null のとき 0 になる。「使用率 0%」という**測定値
 *   ではない 0** なので、この実装では一切使わない。
 * - `planType` は m_plan_limits の plan_type コード ('01'=FREE / '02'=STANDARD /
 *   '03'=PREMIUM / '04'=ENTERPRISE) か、プラン行が無いときのリテラル 'FREE'。
 */
export type FileUsageResponse = {
  used: number;
  limit: number | null;
  remaining: number | null;
  percentage: number;
  planName: string;
  planType: string;
};

/**
 * plan ブロック解決全体のデッドライン。既定 (30s) を使わないのは、この時点で
 * PDF 生成は既に成功しており、ユーザーが待つ価値がある処理ではないため。
 * 取り切れなければ黙って省く方が、生成結果の到達を遅らせるより良い。
 *
 * **fetch 1 回ぶんではなく解決全体に掛ける** (PR #123 のレビュー指摘)。
 * stdio モードの `getAuthWorkspaceId()` / `getAuthHeaders()` は期限切れトークンを
 * 見つけると `refreshTokens()` を呼び、そこは既定 30s のままなので、fetch にだけ
 * 5s を掛けても「省いてよい寄り道」が 35s 生成結果を止めうる。
 */
export const FILE_USAGE_TIMEOUT_MS = 5_000;

/**
 * 月間ファイル出力使用量を取得する (Bearer 認証必須)。
 *
 * `app-key` は reposts-api の `@DefaultController` が付ける VerifyVersion ガードの
 * 必須ヘッダーで、欠落すると 412 でハンドラに到達しない (gallery-client.ts の
 * 複製 API と同じ)。ベース URL と app-key の解決は gallery-client.ts が唯一の
 * 定義場所なので、そこから import する (二重定義するとステージング切り替えで
 * 片方だけずれる)。
 *
 * **`requestWithAuth` を使わない** (PR #123 のレビュー指摘)。あれは 401 を受けると
 * refresh (既定 30s) して**同じリクエストを再送**するため、省いてよい寄り道が
 * 「refresh 30s + 再送」まで伸びる。直前の生成リクエストが同じ `requestWithAuth`
 * を通っており、refresh が要るならそこで既に済んでいる。ここで 401 なら黙って
 * 諦めるのが正しい (`resolvePlanNotice` が undefined に落とす)。
 */
export const getFileUsage = async (
  workspaceId: string,
  signal?: AbortSignal,
): Promise<FileUsageResponse> => {
  const url = `${getMainApiBaseUrl()}/workspace/${encodeURIComponent(workspaceId)}/file-usage`;
  const headers = await getAuthHeaders();
  return fetchJson<FileUsageResponse>(url, {
    headers: {
      ...headers,
      'app-key': getAppKey(),
      Accept: 'application/json',
    },
    timeoutMs: FILE_USAGE_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
};

/**
 * 生成応答へ添える plan ブロック。
 *
 * **取得できた値だけを持つ**。`monthlyLimitPages` / `monthlyRemainingPages` /
 * `planName` / `planType` が無いのは「0 だった」ではなく「観測できなかった」を
 * 意味する。`upgradeUrl` は無料プランと確定したときにだけ入る。
 *
 * 項目名に `Pages` を付けるのは、上流の `used` / `limit` がページ数だから
 * (`FileUsageResponse` のコメント参照)。単位を名前から落とすと、受け取った AI が
 * 「あと 2 件生成できる」と読み替える。
 */
export type PlanNotice = {
  planName?: string;
  planType?: string;
  monthlyUsedPages: number;
  monthlyLimitPages?: number;
  monthlyRemainingPages?: number;
  upgradeUrl?: string;
  /**
   * この数値が「まだ記録されていない生成」を含まないこと。非同期ツールでだけ
   * `true` になる (`PlanNoticeOptions.excludesPendingJob` 参照)。
   */
  excludesPendingJob?: true;
  /** クライアント AI がそのままユーザーへ伝えられる 1〜2 文。 */
  message: string;
};

/**
 * plan ブロックの組み立てオプション。
 *
 * `excludesPendingJob`: **非同期生成ツール専用**。async エンドポイントは requestId を
 * 即返し、PDF の生成とファイルレコード作成 (= `export_size` の記録) は応答後に
 * 走る —— content-service `template.service.ts` で、sync は `_postFileGeneration` を
 * **await してから**応答を組み立てるのに対し、async は切り離した promise chain の中で
 * 呼ぶ。したがって非同期ツールの応答に添える使用量は、**いま受理したジョブぶんを
 * 含まない**。とくに `generate_pdfs_async` の大量バッチで実態から大きくずれるので、
 * 「今の使用量」として読ませてはいけない (PR #123 のレビュー指摘)。
 */
export type PlanNoticeOptions = {
  excludesPendingJob?: boolean;
};

/**
 * 無料プランと**確定できる** planType。
 *
 * - '01'  : m_plan_limits の FREE プラン (plan_type コード)
 * - 'FREE': ワークスペースにプラン行が無いときに usecase が入れるリテラル
 *   (`planType: planType ?? 'FREE'`)
 *
 * 判定は「無料と確定したときだけ宣伝する」向きに倒す。未知のコードが増えても
 * 有料 WS へ煽り文が出ることはなく、代償は「無料かもしれない未知プランに導線が
 * 出ない」だけで、こちらは誤りの方向として安全。
 */
const FREE_PLAN_TYPES: ReadonlySet<string> = new Set(['01', 'FREE']);

const isNonNegativeInteger = (value: number | null): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isNonEmptyString = (value: string): boolean =>
  typeof value === 'string' && value.trim() !== '';

/**
 * プラン変更画面の URL。
 *
 * 遷移先は reports-ui の実ルート `/:workspaceId/plan`。オリジンは**使用量を実際に
 * 問い合わせたホスト** (`getMainApiBaseUrl()`) から取る。config の stage 固定値を
 * 使わないのは、`REPORTFLOW_AUTH_URL` でステージングへ向けた stdio セッション
 * (NODE_ENV 未設定) で、ステージングのワークスペース ID を本番 URL に載せて
 * しまうため。
 *
 * 既知の限界: ローカル開発 (`REPORTFLOW_AUTH_URL=http://localhost:3000/...`) では
 * API のオリジンが返り、reports-ui の dev サーバー (5173) とは一致しない。開発
 * 環境限定の不一致で、実ユーザーの経路 (npx stdio / Cloudflare Container の HTTP) では常に
 * re-port-flow.com 系に解決される。
 */
export const buildPlanPageUrl = (workspaceId: string): string | undefined => {
  try {
    const { origin } = new URL(getMainApiBaseUrl());
    return `${origin}/${encodeURIComponent(workspaceId)}/plan`;
  } catch {
    // REPORTFLOW_AUTH_URL が URL として壊れている場合。URL を作れないなら出さない。
    return undefined;
  }
};

const buildMessage = (notice: Omit<PlanNotice, 'message'>): string => {
  const planLabel = notice.planName
    ? `${notice.planName} プラン`
    : 'プラン名は取得できませんでした';

  // 上限は「取れたとき」だけ書く。null は無制限とプラン上限未設定の両方を含み、
  // どちらかに断定できない (FileUsageResponse のコメント参照)。
  const usage =
    notice.monthlyLimitPages !== undefined
      ? `今月の出力ページ数は ${notice.monthlyUsedPages} / ${notice.monthlyLimitPages} ページです（${planLabel}）。`
      : `今月の出力ページ数は ${notice.monthlyUsedPages} ページです（${planLabel}）。月間の上限ページ数は応答に含まれていません（無制限、またはプラン上限が未設定）。`;

  const remaining =
    notice.monthlyRemainingPages !== undefined
      ? `残り ${notice.monthlyRemainingPages} ページ。`
      : '';

  // 非同期ツールでは、いま受理したジョブぶんがまだ記録されていない
  // (`PlanNoticeOptions.excludesPendingJob` 参照)。数値を「現在値」として
  // 読ませないため、上限や残量より前に断りを置く。
  const pending = notice.excludesPendingJob
    ? '（この数値には、いま受理した出力ジョブのページ数がまだ含まれていません）'
    : '';

  if (!notice.upgradeUrl) {
    // 有料プラン (および無料と確定できないプラン) には事実だけを返す。
    return `${usage}${remaining}${pending}`;
  }

  // 「上限に達すると生成できない」は実装で確認済みの事実:
  // content-service が `usedPages >= maxFileTimes` で ForbiddenException を投げる
  // (design.repository.service.ts)。上限が取れていないときは主張しない。
  const warning =
    notice.monthlyLimitPages !== undefined
      ? '上限に達すると今月はこれ以上PDFを出力できません。'
      : '';
  return `${usage}${remaining}${pending}${warning}有料プランへの変更（アップグレード）はこちら: ${notice.upgradeUrl}`;
};

/**
 * 使用量レスポンスから plan ブロックを組み立てる。
 *
 * `fetchJson` は実行時検証をしないため、契約外の応答 (HTML へのフォールバック、
 * 型違い、欠損) がそのままここへ届く。**`used` を数値として確認できないときは
 * 何も返さない** —— 「今月 0 ページ」と書くと、取得できなかっただけの状態が
 * 測定値のように見える。
 */
export const buildPlanNotice = (
  usage: FileUsageResponse,
  workspaceId: string,
  options: PlanNoticeOptions = {},
): PlanNotice | undefined => {
  if (usage === null || typeof usage !== 'object') return undefined;
  if (!isNonNegativeInteger(usage.used)) return undefined;

  const planType = isNonEmptyString(usage.planType)
    ? usage.planType.trim()
    : undefined;
  const isFree = planType !== undefined && FREE_PLAN_TYPES.has(planType);
  const upgradeUrl = isFree ? buildPlanPageUrl(workspaceId) : undefined;

  const base: Omit<PlanNotice, 'message'> = {
    ...(isNonEmptyString(usage.planName)
      ? { planName: usage.planName.trim() }
      : {}),
    ...(planType !== undefined ? { planType } : {}),
    monthlyUsedPages: usage.used,
    ...(isNonNegativeInteger(usage.limit)
      ? { monthlyLimitPages: usage.limit }
      : {}),
    ...(isNonNegativeInteger(usage.remaining)
      ? { monthlyRemainingPages: usage.remaining }
      : {}),
    ...(upgradeUrl !== undefined ? { upgradeUrl } : {}),
    ...(options.excludesPendingJob
      ? { excludesPendingJob: true as const }
      : {}),
  };

  return { ...base, message: buildMessage(base) };
};

export type PlanNoticeResolver = (
  options?: PlanNoticeOptions,
) => Promise<PlanNotice | undefined>;

/**
 * `fn` を `ms` で打ち切り、超えたら `undefined` を返す。**例外も投げない**。
 *
 * fetch のタイムアウトではなく**解決全体**に掛けるのが要点 (`FILE_USAGE_TIMEOUT_MS`
 * のコメント参照)。トークン refresh のように signal を受け取らない処理が途中に
 * あっても、応答が待たされる上限はここで決まる。
 *
 * 打ち切り後も `fn` の Promise は宙に浮くので、
 * - `signal` を渡して進行中の fetch は実際に中断する
 * - `fn` 側の reject は先に握りつぶし、unhandled rejection にしない
 * - タイマーは必ず解除する (stdio CLI の終了を最大 5s 遅らせないため)
 */
const withDeadline = async (
  ms: number,
  fn: (signal: AbortSignal) => Promise<PlanNotice | undefined>,
): Promise<PlanNotice | undefined> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`plan lookup timed out after ${ms}ms`));
      resolve(undefined);
    }, ms);
  });
  try {
    // `fn` は async 関数なので同期 throw はしない (失敗は必ず reject として来る)。
    // ここに catch を足すと到達しない枝になるので置かない。
    return await Promise.race([
      fn(controller.signal).catch(() => undefined),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // 期限切れで抜けたときに残るリクエストを片付ける (成功後の abort は無害)
    controller.abort();
  }
};

/**
 * 現在の認証コンテキストの plan ブロックを解決する。**例外を投げない**。
 *
 * 認証情報が無い / ワークスペース未解決 / API 失敗 / タイムアウト / 契約外応答は
 * すべて `undefined` (＝何も添えない) に落とす。生成そのものは既に成功しており、
 * ここでの失敗を生成の失敗に昇格させてはならない。
 *
 * `getAuthWorkspaceId()` が返すのは HTTP モードでは**署名検証していない** Bearer
 * JWT の claim だが、それをそのまま URL に載せることにはならない —— この値は
 * まず `getFileUsage()` のパスに使われ、reposts-api の JWTAuthGuard が
 * 「パスの workspaceId と JWT の workspace_id が一致するか」を検査して不一致を
 * 403 で落とす。つまり `upgradeUrl` を組み立てるのは**サーバーがその資格情報を
 * そのワークスペース宛として受理した後**だけになる (telemetry が成功呼び出しに
 * だけ帰属を付けるのと同じ考え方: `telemetry/interceptor.ts`)。
 */
export const resolvePlanNotice: PlanNoticeResolver = async (options = {}) =>
  withDeadline(FILE_USAGE_TIMEOUT_MS, async (signal) => {
    const workspaceId = await getAuthWorkspaceId();
    if (!workspaceId) return undefined;
    return buildPlanNotice(
      await getFileUsage(workspaceId, signal),
      workspaceId,
      options,
    );
  });

/**
 * 生成ツールの構造化ペイロードへ plan ブロックを足す。取得できなければ**元の
 * ペイロードをそのまま**返す (キー自体を生やさない)。
 *
 * 4 つの生成ツールで同じ 1 行を書くための共通口。個別に try/catch を書くと、
 * どれか 1 つで囲い忘れたときだけ生成が壊れる。
 */
export const attachPlanNotice = async <T extends object>(
  payload: T,
  resolve: PlanNoticeResolver = resolvePlanNotice,
  options: PlanNoticeOptions = {},
): Promise<T & { plan?: PlanNotice }> => {
  let notice: PlanNotice | undefined;
  try {
    notice = await resolve(options);
  } catch {
    // resolvePlanNotice は投げない契約だが、注入された resolver が投げても
    // 生成結果を落とさない (ここが最後の砦)。
    notice = undefined;
  }
  return notice ? { ...payload, plan: notice } : { ...payload };
};
