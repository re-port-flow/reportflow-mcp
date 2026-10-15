/**
 * 環境別の固定 URL 定数。
 * `NODE_ENV=staging` のときだけステージング、それ以外は本番扱い。
 * stdio 版 (npx で起動、NODE_ENV 未設定) が誤ってステージングを引かないよう、
 * staging を opt-in 方式にしている。HTTP 版はデプロイ環境から NODE_ENV を渡す。
 * 値は外部 env から差し替え不可。
 */

type Stage = 'prod' | 'stg';

const STAGE: Stage = process.env['NODE_ENV'] === 'staging' ? 'stg' : 'prod';

const URLS = {
  prod: {
    // content-service (PDF 生成 / template 取得)
    api: 'https://api.re-port-flow.com',
    mcp: 'https://mcp.re-port-flow.com',
    // OAuth Authorization Server (reposts-api: NestJS global prefix v1 + apex domain 経由)
    oauthIssuer: 'https://re-port-flow.com/api/v1',
  },
  stg: {
    api: 'https://api.stg.re-port-flow.com',
    mcp: 'https://mcp.stg.re-port-flow.com',
    oauthIssuer: 'https://stg.re-port-flow.com/api/v1',
  },
} as const;

export const REPORTFLOW_API_BASE_URL = URLS[STAGE].api;
export const MCP_RESOURCE_URL = URLS[STAGE].mcp;
/**
 * OAuth Authorization Server (reposts-api) の issuer URL。
 * /oauth/authorize, /oauth/token, /.well-known/* の prefix として使う。
 * content-service (api.{stg.}re-port-flow.com) とは別 host のため分離。
 */
export const REPORTFLOW_OAUTH_ISSUER_URL = URLS[STAGE].oauthIssuer;
export const RUNTIME_STAGE: Stage = STAGE;

// ─── reposts-api (main API) のベース URL ──────────────────────────────────────
//
// 公開ギャラリー API とテンプレート複製 API は reposts-api 側にあり、OAuth
// Authorization Server と同じホスト + パスプレフィックス
// (https://{stg.}re-port-flow.com/api/v1) で配信される。content-service
// (REPORTFLOW_API_BASE_URL) とはホストが異なるため、auth.ts と同じ
// REPORTFLOW_AUTH_URL env override に従わせる (stdio でステージングへ向けた
// 場合にトークン発行元と API 呼び出し先が食い違わないようにする)。
// 末尾スラッシュは除去する (auth.ts はスラッシュ付き設定も許容するため、
// そのまま連結すると /api/v1//public/... の二重スラッシュになる)。
//
// **`gallery-client.ts` からここへ移した** (PRJ-3-1580)。この値のホストが
// 「Cloudflare Access 境界の内側か」を決める唯一の根拠になり、`http.ts` が
// 送信直前にそれで判定する。`gallery-client.ts` は `http.ts` を import して
// いるので、あちらに置いたままだと `http.ts` → `gallery-client.ts` →
// `http.ts` の循環になる。`config.ts` は何も import しない葉なので循環しない。
// 既存の import 元を壊さないよう `gallery-client.ts` から再 export している。
export const getMainApiBaseUrl = (): string =>
  (process.env['REPORTFLOW_AUTH_URL'] ?? REPORTFLOW_OAUTH_ISSUER_URL).replace(
    /\/+$/,
    '',
  );

/**
 * AS metadata (RFC 8414) と PRM (RFC 9728) で広告するサポート scope。
 *
 * 最小権限（PRJ-3-1522）。MCP クライアント（Claude.ai / Notion / Coze 等）は
 * ここを読んで authorize の scope を組み立てるので、**この一覧がそのまま
 * 利用者へ要求される権限になる**。実際に必要なのは次の 4 つだけ:
 *   - openid / profile : OIDC の識別（reposts-api の userinfo / workspace 一覧）
 *   - pdf:generate     : content-service `/v1/file/*`（ApplicationGuard が検査する
 *                        唯一のスコープ）＋ reposts-api `workspace/:id/file-usage`
 *   - designs:write    : `copy_gallery_template` が呼ぶ
 *                        `POST /:workspaceId/my/templates/:slug/duplicate`
 *
 * `designs:read` / `templates:read` / `templates:write` は外した。reposts-api・
 * content-service のどちらでも `@RequireScopes` 宣言もガード検査も無く、認可に
 * 一切関与していない。広告し続けると利用者が同意する権限だけが広がり、将来
 * それらを要求する口が増えた時点で、再同意なしに既存トークンが到達できてしまう。
 */
export const SUPPORTED_SCOPES = [
  'openid',
  'profile',
  'designs:write',
  'pdf:generate',
] as const;

/** OAuth 2.0 Protected Resource Metadata (RFC 9728) のレスポンスを生成する */
export const buildProtectedResourceMetadata = (): Record<string, unknown> => ({
  resource: MCP_RESOURCE_URL,
  // authorization_servers には reposts-api の issuer ではなく MCP サーバー自身を指定する。
  // reposts-api issuer はパスベース (https://...re-port-flow.com/api/v1) であるため、
  // RFC 8414 の AS metadata URL が /.well-known/oauth-authorization-server/api/v1 になり
  // Claude.ai がそのパスを解決できず DCR に進めない。
  // MCP サーバー自身はルートドメインで /.well-known/oauth-authorization-server を配信し
  // registration_endpoint / authorize / token も全て proxy しているため、
  // MCP_RESOURCE_URL を AS とすることで Claude.ai が RFC 8414 → DCR → 認可フローを
  // 正常に完走できる。
  authorization_servers: [MCP_RESOURCE_URL],
  scopes_supported: [...SUPPORTED_SCOPES],
  bearer_methods_supported: ['header'],
  resource_documentation: 'https://re-port-flow.com/docs/mcp',
});
