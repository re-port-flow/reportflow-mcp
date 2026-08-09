// `integration.mcp.invoked` に載せる workspaceId の解決 (PRJ-3-1093 / PRJ-3-1117)。
//
// ## 規則
// イベントの workspace は「**その呼び出しが実際に認証に使った資格情報**の
// workspace」。ソースはモードごとに 1 つだけで、フォールバックは持たない。
//
// | モード | ソース |
// |--------|--------|
// | stdio  | ハンドラ内で auth 層が読んだ / 保存した資格情報 (`recordCredentialWorkspace`) |
// | HTTP   | そのリクエストの Bearer JWT (`auth-context.ts` の per-request ALS) |
//
// - **ツール入力からは採らない**。workspace は認証コンテキストに属する情報で、
//   呼び出し側が申告した値を信じると帰属を偽装できる。
// - **HTTP で Bearer から読めなくても、ローカル資格情報へは落とさない**。
//   サーバープロセスの保存済みトークンは無関係なワークスペースのものであり得る。
// - 解決は同期・I/O 無し。telemetry の解決でツール応答を待たせない。
//
// ## プロセス幅の可変状態を持たない理由 (PRJ-3-1117)
// 「最後に観測した workspace」をプロセス変数に置くと、並行する
// `authenticate force=true` が別ワークスペースを保存した瞬間に、進行中の別呼び出し
// の帰属先が変わり得る。記録先を**呼び出しスコープ** (AsyncLocalStorage) に閉じる
// ことで、この競合を設計から消している — どの呼び出しも自分のスロットしか読まず、
// 他の呼び出しの記録は届かない。
//
// stdio で上流 API を呼ぶ経路はすべて `client.ts` → `requestWithAuth` →
// `getAuthHeaders()` → `loadOrRefresh()` を通り、そこで資格情報が記録される
// (`authenticate` は `authorize()` で記録)。したがって「起動直後の初回呼び出しが
// 未帰属になる」ことはない — 開始時点ではなくハンドラ内の読み取りを見るため。
// 逆にスロットが空のまま終わるのは、資格情報を読まずに終わった呼び出し (資格情報が
// 無くて失敗した / 上流 API を呼ばずに返った) で、帰属先が無いのが正しい。

import { AsyncLocalStorage } from 'async_hooks';
import { getHttpAuthContext } from '../auth-context.js';
import { decodeJwtPayload } from '../jwt.js';

/** 1 回のツール呼び出しが認証に使った資格情報の workspace。 */
export type InvocationWorkspace = {
  /** 資格情報を一度も読んでいなければ undefined のまま。 */
  workspaceId?: string;
};

const invocationStorage = new AsyncLocalStorage<InvocationWorkspace>();

/**
 * `fn` を 1 呼び出し分のスコープで実行する (`withTelemetry` から呼ぶ)。
 * スコープ内の `recordCredentialWorkspace` は `slot` に書き込む。
 */
export const runWithInvocationWorkspace = <T>(
  slot: InvocationWorkspace,
  fn: () => Promise<T>,
): Promise<T> => invocationStorage.run(slot, fn);

/**
 * auth 層が資格情報を読んだ / 保存した / 破棄したときに呼ぶ (`auth.ts`)。
 * 呼び出しスコープ外での読み取り (どのイベントにも属さない) では何もしない。
 *
 * 1 回の呼び出し中に複数回呼ばれることがあるが、**常に最後の値を採る** —
 * 応答を生んだのは最後に確立された資格情報だから。
 *
 * - `authenticate force=true`: 古い資格情報を破棄 (undefined) → OAuth 交換 →
 *   新しい workspace を保存 ⇒ 最後 = 切り替え後の workspace。
 * - 401 リトライ: 拒否された資格情報 → refresh した資格情報で再試行
 *   ⇒ 最後 = 成功したリトライの資格情報。
 *
 * 1 呼び出しの中で値が実際に変わるのは、`authenticate` 自身が切り替えた場合と、
 * 他の呼び出しの force 再認証と重なった場合だけ。どちらも同一ユーザーの操作で、
 * 最後に確立された資格情報がその呼び出しの応答を生んでいる。
 *
 * ## 既知の残余 (許容する。PRJ-3-1117)
 * 1 ツールが複数の認証付きリクエストを出す場合 (`fetch` の付随的な `listDesigns()`
 * など)、並行 force 再認証と重なると、主たる結果が A 由来でも最後に使われた B に
 * 帰属し得る。二重の同時条件でしか起きず、影響はテレメトリ 1 行の帰属先だけ
 * (A も B も同一ユーザーのワークスペース。未帰属にはならないので月次コホートの
 * 品質ゲートは落ちない)。これを厳密化するには auth 層に「主たる / 付随」の区別を
 * 持ち込む必要があり、帰属規則が再び多段化して壊れやすくなるため採らない。
 */
export const recordCredentialWorkspace = (
  workspaceId: string | undefined,
): void => {
  const slot = invocationStorage.getStore();
  if (slot) slot.workspaceId = workspaceId;
};

/** この呼び出しの帰属先を解決する (`withTelemetry` が完了後に 1 回だけ呼ぶ)。 */
export const resolveInvocationWorkspaceId = (
  slot: InvocationWorkspace,
): string | undefined => {
  const httpCtx = getHttpAuthContext();
  if (httpCtx) return decodeJwtPayload(httpCtx.accessToken)?.workspace_id;
  return slot.workspaceId;
};
