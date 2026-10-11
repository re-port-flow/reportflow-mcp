/**
 * 環境別の固定 URL 定数。
 * `NODE_ENV=staging` のときだけステージング、それ以外は本番扱い。
 * stdio 版 (npx で起動、NODE_ENV 未設定) が誤ってステージングを引かないよう、
 * staging を opt-in 方式にしている。HTTP 版は ECS Task Definition で NODE_ENV を渡す。
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

/**
 * AS metadata (RFC 8414) と PRM (RFC 9728) で広告するサポート scope。
 *
 * ## なぜ 7 つではなく 4 つか（PRJ-3-1522 / 前提 PRJ-3-2012）
 * ここを読むクライアント（Claude.ai / ChatGPT / Notion 等の MCP クライアント）は
 * MCP サーバーの `/register` 経由で **DCR** する ＝ reposts-api から見て
 * **匿名クライアント**になる。匿名クライアントが持てる上限は reposts-api の
 * `ANONYMOUS_CLIENT_SCOPES`（`openid profile designs:write pdf:generate`。
 * 2026-10-01 kobori 決定）で、`authorize` は上限外を**削らずに 400
 * `scope_not_allowed` で拒否する**（`oauth.service.ts` のスコープ検証）。
 * つまり広告に `designs:read` / `templates:read` / `templates:write` を載せると、
 * **広告どおりに scope を組み立てた正しいクライアントが認可に進めない。**
 *
 * この 3 つは reposts-api / reports-content-service のどのエンドポイントでも
 * 強制していない（`@RequireScopes` 0 件）ので、外しても使える機能は減らない。
 * 広告したまま取得できてしまうと、将来それらを要求する口が増えた時点で
 * 既存トークンが**再同意なしに**届く（PRJ-3-1522 が「無効なスコープ」と呼ぶ状態）。
 *
 * **増やすときは reposts-api 側の `ANONYMOUS_CLIENT_SCOPES` に入っているかを
 * 先に確認する。** 入っていない値を足すと DCR 経由の接続が全部 400 になる。
 * 宣言場所をまたぐ食い違いは、親リポジトリ report-flow の
 * `tools/oauth-scope-consistency.sh` が観測する。
 */
export const SUPPORTED_SCOPES = [
  'openid',
  'profile',
  'designs:write',
  'pdf:generate',
] as const;

/**
 * ローカル（stdio / CLI）の OAuth で要求する scope の既定値。
 *
 * 広告集合と**同じ 1 箇所から導く**。別々のリテラルで持つと、片方を変えたときに
 * 黙ってずれる（reposts-api の `oauth-scopes.constants.ts` が同じ理由で
 * `MINIMUM_SCOPES` を 1 定数にしている）。
 */
export const SUPPORTED_SCOPE_STRING: string = SUPPORTED_SCOPES.join(' ');

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
