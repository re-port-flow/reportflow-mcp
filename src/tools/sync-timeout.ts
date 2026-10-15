import { HttpError } from '../http.js';

/**
 * 同期生成 (`generate_pdf_sync` / `generate_pdfs_sync`) が**時間切れで**失敗したかの判定と、
 * そのときに LLM へ渡す対処 (PRJ-3-2016)。
 *
 * 本番の API は同期生成を 60 秒で打ち切る (ALB の idle timeout。`client.ts` の
 * `SYNC_GENERATION_TIMEOUT_MS` のコメント参照)。時間切れは入力の誤りではないので、
 * 「designId / params を照合」と返すと LLM は正しい入力を直そうとするか、同じ呼び出しを
 * 繰り返す。**サーバー側では生成が続いてページが消費されうる**ため、同期での再試行は
 * 二重の生成・消費になりうる。async での生成し直しも同じなので、先に出力履歴で生成済みかを
 * 利用者に確かめてもらい、生成されていないときだけ**利用者の了承を得て**生成し直す順にする
 * (レビュー指摘: 「伝えたうえで」だと LLM は通知と再生成を同じターンで実行できる)。
 *
 * 時間切れとみなすもの:
 * - 504: ALB が 60 秒で切ったとき
 * - 524: Cloudflare がオリジンの応答を待ちきれなかったとき (ALB より長いので通常は出ない)
 * - MCP 側のタイムアウト (`http.ts` の `Request timed out after …ms`)
 */
const SYNC_TIMEOUT_STATUSES: ReadonlySet<number> = new Set([504, 524]);

export const isSyncGenerationTimeout = (err: unknown): boolean => {
  if (err instanceof HttpError) return SYNC_TIMEOUT_STATUSES.has(err.status);
  return (
    err instanceof Error && err.message.startsWith('Request timed out after')
  );
};

export const SYNC_TIMEOUT_GUIDANCE =
  '同期生成がタイムアウトしました (同期生成の上限は 60 秒)。入力の誤りではありません。\n' +
  'サーバー側では生成が続き、ページが消費されている可能性があります。同じ内容で同期生成を再試行すると、二重に生成・消費されることがあります。\n' +
  '対処 (この順に。生成し直すツールをすぐに呼ばないこと):\n' +
  '1. 同期生成でも async でも、まだ生成し直さない。まず利用者に状況を伝え、Re:port Flow Web アプリの出力履歴で、この PDF が生成済みかを確認してもらう。\n' +
  '2. 生成済みでなかった場合に限り、利用者の了承を得てから generate_pdfs_async で生成し直す (新しい生成としてページを消費する)。';
