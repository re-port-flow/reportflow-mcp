import { A2A_SKILLS } from './skills.js';

/** このサーバーが実装する A2A プロトコルのバージョン (Major.Minor)。 */
export const A2A_PROTOCOL_VERSION = '1.0';

/** A2A JSON-RPC エンドポイントのパス。Agent Card の supportedInterfaces が指す。 */
export const A2A_ENDPOINT_PATH = '/a2a';

/** Agent Card の securitySchemes / securityRequirements で使うスキーム名。 */
export const A2A_OAUTH_SCHEME_NAME = 'reportflow-oauth2';

/**
 * OAuth スコープの説明 (AuthorizationCodeOAuthFlow.scopes は名前 → 説明の map)。
 * キーは `SUPPORTED_SCOPES` と一致させる (agent-card.spec.ts が固定)。
 */
export const A2A_SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  openid: 'Identify the signed-in user (OpenID Connect).',
  profile: "Read the signed-in user's basic profile.",
  'designs:write': 'Read and create templates in the workspace.',
  'pdf:generate': 'Generate PDFs (consumes the monthly page quota).',
};

export type BuildAgentCardOptions = {
  /** このサーバーの公開オリジン (MCP_RESOURCE_URL)。末尾スラッシュ無し。 */
  resourceUrl: string;
  /** package.json の version。カードの version に出す。 */
  version: string;
  /** SUPPORTED_SCOPES。securityRequirements に載せる。 */
  scopes: readonly string[];
};

/**
 * A2A v1.0 の Agent Card (仕様 §4.4.1 / §8.2)。
 *
 * - supportedInterfaces は **実際に応答する** `/a2a` (JSON-RPC binding) だけを載せる。
 *   gRPC / HTTP+JSON は実装していないので広告しない。
 * - 認可は MCP と同じ OAuth (このサーバーが /authorize /token を proxy している)。
 *   同じオリジンが resource なので、MCP 用に取得したトークンをそのまま使える。
 * - streaming / pushNotifications は実装していない (false)。
 */
export const buildAgentCard = ({
  resourceUrl,
  version,
  scopes,
}: BuildAgentCardOptions): Record<string, unknown> => ({
  name: 'Re:port Flow',
  description:
    'Re:port Flow generates PDFs (invoices, quotations, delivery notes and more) from reusable templates. Send a message with a data part {"skill": "<skill id>", "arguments": {...}} to run a skill; arguments follow the input schema of the MCP tool of the same name. Authorize with OAuth 2.0 (authorization code + PKCE, dynamic client registration supported).',
  supportedInterfaces: [
    {
      url: `${resourceUrl}${A2A_ENDPOINT_PATH}`,
      protocolBinding: 'JSONRPC',
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ],
  provider: {
    organization: '株式会社マネプラ (MonePla Inc.)',
    url: 'https://lp.re-port-flow.com/',
  },
  version,
  documentationUrl: 'https://doc.re-port-flow.com/docs/intro',
  iconUrl: `${resourceUrl}/favicon.svg`,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extendedAgentCard: false,
  },
  securitySchemes: {
    [A2A_OAUTH_SCHEME_NAME]: {
      oauth2SecurityScheme: {
        description:
          'Same OAuth 2.0 authorization server as the Re:port Flow MCP server.',
        flows: {
          authorizationCode: {
            authorizationUrl: `${resourceUrl}/authorize`,
            tokenUrl: `${resourceUrl}/token`,
            scopes: Object.fromEntries(
              scopes.map((s) => [s, A2A_SCOPE_DESCRIPTIONS[s] ?? s]),
            ),
            pkceRequired: true,
          },
        },
        oauth2MetadataUrl: `${resourceUrl}/.well-known/oauth-authorization-server`,
      },
    },
  },
  securityRequirements: [
    { schemes: { [A2A_OAUTH_SCHEME_NAME]: { list: [...scopes] } } },
  ],
  defaultInputModes: ['application/json', 'text/plain'],
  defaultOutputModes: ['application/json', 'text/plain'],
  skills: A2A_SKILLS.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [...skill.tags],
    examples: [...skill.examples],
    inputModes: ['application/json'],
    outputModes: ['application/json', 'text/plain'],
  })),
});
