// Web アプリ（reports-ui）の画面 URL を組み立てる。
//
// search / fetch の結果に載せる `url` は、利用者がブラウザで開くテンプレートの画面を
// 指す。以前は `https://re-port-flow.com/designs/{id}` を固定で返していたが、
// ワークスペースのセグメントが無く `designs` も複数形で、reports-ui のどのルートにも
// 一致しない（開くと 404 相当）うえ、staging でも本番のホストを返していた。
//
// ## ルート
// reports-ui の `/:workspaceId/templates/:id/:version`（エディタ）。
// 情報設計 2026-09 で `/:workspaceId/design/*` から移った（reports-ui#885。旧 URL は
// reports-ui 側で転送される）。一覧は `/:workspaceId/templates`。
//
// ## ホスト
// reports-ui は reposts-api（OAuth issuer `https://re-port-flow.com/api/v1`）と同じ
// オリジンで配信される（本番 `https://re-port-flow.com` / staging
// `https://stg.re-port-flow.com`）。issuer のオリジンを使うので、環境ごとに正しい
// ホストになる。
//
// ## ワークスペース
// 呼び出しが認証に使った資格情報のワークスペース（`getInvocationWorkspaceId`）。
// ツール入力からは採らない（テレメトリの帰属と同じ規則）。取れないときは
// ワークスペースを推測せず、アプリのトップ（ログイン後にワークスペースを選べる）を返す。

import { getMainApiBaseUrl } from './config.js';

/** reports-ui のオリジン（末尾スラッシュなし）。 */
export const getAppBaseUrl = (): string => new URL(getMainApiBaseUrl()).origin;

/**
 * テンプレートの画面 URL。
 *
 * - ワークスペースとバージョンが分かる → エディタ `/{ws}/templates/{id}/{version}`
 * - バージョンが分からない → テンプレート一覧 `/{ws}/templates`
 * - ワークスペースが分からない → アプリのトップ `/`
 */
export const templatePageUrl = (
  workspaceId: string | undefined,
  designId: string,
  version: number | undefined,
): string => {
  const base = getAppBaseUrl();
  if (workspaceId == null || workspaceId === '') return `${base}/`;
  const ws = encodeURIComponent(workspaceId);
  if (designId === '' || version == null || !Number.isInteger(version)) {
    return `${base}/${ws}/templates`;
  }
  return `${base}/${ws}/templates/${encodeURIComponent(designId)}/${version}`;
};
