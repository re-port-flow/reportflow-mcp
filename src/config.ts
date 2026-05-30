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

/** AS metadata (RFC 8414) と PRM (RFC 9728) で広告するサポート scope。 */
export const SUPPORTED_SCOPES = [
  'openid',
  'profile',
  'designs:read',
  'designs:write',
  'templates:read',
  'templates:write',
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
