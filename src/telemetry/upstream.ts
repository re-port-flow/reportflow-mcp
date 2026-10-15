// `integration.mcp.invoked` の**失敗イベントに載せる観測値**を 1 回の呼び出し
// スコープに集める (PRJ-3-1117 の帰属規則は変えない)。
//
// ## なぜ要るか
// `interceptor.ts` の `inferErrorClass` は、ツールが `isError: true` を返す経路
// —— つまり**全ツールの通常の失敗経路** —— で常に定数 `'ToolError'` を返す。
// 本番の MCP サーバーはタスク起動ログしか出しておらず、reposts-api 側にも該当
// リクエストのログが残っていないため、テレメトリが唯一の手がかりなのに情報量が
// ゼロだった。実測 (Cloudflare Analytics Engine / 2026-07-18〜08-17) では
// `copy_gallery_template` が 8 回中 4 回失敗していたが、理由は 1 件も分からない。
//
// ## 何を記録するか（＝何を記録しないか）
// **観測できた事実だけ**を記録する。
//
// - 上流が HTTP 応答を返した → そのステータス (`status`)
// - 応答が返らなかった (DNS / 接続 / タイムアウト / 中断) → ステータスは
//   **観測できていない**ので `status` を持たない。下流はキーの有無で
//   「取れなかった」と判別できる。
// - エラー**メッセージ本文は載せない**。上流の文言はユーザー入力（テンプレート
//   名・パラメータ値）を反映しうるので PII が混入する。載せるのは JS のクラス名
//   だけで、これは実装が決める定数（`gallery-demand.ts` の形状マスクと同じ思想で、
//   自由記述をそのまま流さない）。
//
// ## なぜ `last` なのか（原因と断定しない）
// 1 回のツール呼び出しは複数の上流リクエストを出しうる。`requestWithAuth` は 401 を
// 受けると refresh して**再送**するし、`fetch` ツールは主たる取得に付随して
// `listDesigns()` も呼ぶ。つまり「最初に観測した上流エラーから回復し、別の理由で
// 失敗した」呼び出しが実在する。したがってここに残る値は**この呼び出し中に最後に
// 観測した上流エラー**であって、失敗の原因ではない。プロパティ名 (`lastUpstream*`)
// と件数 (`upstreamFailureCount`) の両方でそれが読み取れるようにしてある ——
// 件数が 2 以上なら、最後の 1 件だけを原因として読んではいけないと分かる。
//
// ## スコープの持ち方
// 記録先は `workspace.ts` と同じ **AsyncLocalStorage による呼び出しスコープ**。
// プロセス幅の可変状態に置くと、並行する別の呼び出しが観測した上流エラーが
// 混ざる（`workspace.ts` 冒頭の PRJ-3-1117 と同じ競合）。スコープ外での記録は
// 何もしない —— どのイベントにも属さない観測だから。

import { AsyncLocalStorage } from 'async_hooks';
import type { TelemetryProperties } from './client.js';

/**
 * クラス名として受け入れる形。**実装が決める識別子だけを通す**ための検査で、
 * ここを通らない値は `'Error'` に落とす。
 *
 * `err.name` は本来 `TypeError` / `SyntaxError` のような定数だが、型の上では
 * 任意の文字列でありうる（`AbortSignal.abort(reason)` の reason は呼び出し側が
 * 作る）。テレメトリへ自由記述を流さないという規則 (Notion「Event Telemetry
 * Schema」§7.3) を、値の出所ではなく**形**で担保する。
 */
const ERROR_CLASS_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const FALLBACK_ERROR_CLASS = 'Error';

/**
 * 例外から JS のクラス名を取る。**名前の抽出はここが唯一の定義**
 * (`interceptor.ts` の `inferErrorClass` もこれを使う)。
 */
export const errorClassOf = (err: unknown): string => {
  if (!(err instanceof Error)) return FALLBACK_ERROR_CLASS;
  const name = err.name;
  return typeof name === 'string' && ERROR_CLASS_PATTERN.test(name)
    ? name
    : FALLBACK_ERROR_CLASS;
};

/** 上流リクエスト 1 本の失敗として観測できたこと。 */
export type UpstreamFailure = {
  /**
   * 上流が返した HTTP ステータス。**応答が返らなかったときは持たない**
   * （「取れなかった」と「0 だった」を混同させない）。
   */
  status?: number;
  /** 失敗の JS クラス名 (`HttpError` / `TypeError` / `SyntaxError` 等)。 */
  errorClass: string;
};

/** 1 回のツール呼び出し中に観測した上流アクセス。 */
export type InvocationUpstream = {
  /** 共有 HTTP 層を通して出した上流リクエストの本数。 */
  requestCount: number;
  /** そのうち失敗として観測できた本数。 */
  failureCount: number;
  /** 最後に観測した失敗。`failureCount === 0` なら undefined。 */
  last?: UpstreamFailure;
};

export const createInvocationUpstream = (): InvocationUpstream => ({
  requestCount: 0,
  failureCount: 0,
});

const upstreamStorage = new AsyncLocalStorage<InvocationUpstream>();

/**
 * `fn` を 1 呼び出し分のスコープで実行する (`withTelemetry` から呼ぶ)。
 * スコープ内の `recordUpstreamRequest` / `recordUpstreamFailure` は `slot` に
 * 書き込む。
 */
export const runWithInvocationUpstream = <T>(
  slot: InvocationUpstream,
  fn: () => Promise<T>,
): Promise<T> => upstreamStorage.run(slot, fn);

/**
 * 上流リクエストを出すときに呼ぶ (`http.ts`)。呼び出しスコープ外
 * （どのツール呼び出しにも属さない上流アクセス）では何もしない。
 */
export const recordUpstreamRequest = (): void => {
  const slot = upstreamStorage.getStore();
  if (slot) slot.requestCount += 1;
};

/**
 * 上流リクエストが失敗したときに呼ぶ (`http.ts`)。呼び出しスコープ外では
 * 何もしない。
 */
export const recordUpstreamFailure = (failure: UpstreamFailure): void => {
  const slot = upstreamStorage.getStore();
  if (!slot) return;
  slot.failureCount += 1;
  slot.last = failure;
};

/**
 * 失敗イベントへ載せる properties を組み立てる。
 *
 * 2 つの件数は**常に載せる**。他のフラグ (`gallery-demand.ts`) は「既定と同じ値
 * なら送らない」規則だが、ここでの 0 は既定ではなく観測結果であり、キーが無い状態
 * （この計測を持たない古いビルド）と区別できる必要がある。
 *
 * **`upstreamFailureCount: 0` だけでは意味が定まらない**ので `upstreamRequestCount`
 * を併記する。「上流を一度も呼ばずに失敗した」（例: アクセストークンに
 * ワークスペースが無い）と「上流は正常に応答したがツールが応答内容を拒否した」
 * （例: 2xx だが契約外の payload）は、失敗件数だけでは同じ 0 に見えてしまう。
 */
export const buildUpstreamProperties = (
  slot: InvocationUpstream,
): TelemetryProperties => {
  const counts = {
    upstreamRequestCount: slot.requestCount,
    upstreamFailureCount: slot.failureCount,
  };
  const last = slot.last;
  if (last === undefined) return counts;
  return {
    ...counts,
    lastUpstreamErrorClass: last.errorClass,
    // ステータスはキーの有無で「観測できたか」を表す（上の型コメント参照）。
    ...(last.status === undefined ? {} : { lastUpstreamStatus: last.status }),
  };
};
