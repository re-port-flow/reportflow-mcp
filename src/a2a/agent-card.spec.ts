import { SUPPORTED_SCOPES } from '../config';
import {
  A2A_OAUTH_SCHEME_NAME,
  A2A_SCOPE_DESCRIPTIONS,
  buildAgentCard,
} from './agent-card';
import { A2A_SKILLS } from './skills';

const card = buildAgentCard({
  resourceUrl: 'https://mcp.example.test',
  version: '9.9.9',
  scopes: SUPPORTED_SCOPES,
});

describe('buildAgentCard (A2A v1.0 §4.4.1)', () => {
  it('必須フィールドがすべて在る', () => {
    for (const key of [
      'name',
      'description',
      'supportedInterfaces',
      'version',
      'capabilities',
      'defaultInputModes',
      'defaultOutputModes',
      'skills',
    ]) {
      expect(card).toHaveProperty(key);
    }
    expect(card['version']).toBe('9.9.9');
  });

  it('supportedInterfaces は実装している JSON-RPC の /a2a だけを指す', () => {
    expect(card['supportedInterfaces']).toEqual([
      {
        url: 'https://mcp.example.test/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ]);
  });

  it('streaming / push / extended card は実装していないので false', () => {
    expect(card['capabilities']).toEqual({
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    });
  });

  it('OAuth はこのサーバー自身の /authorize /token (MCP と同じ AS) を指す', () => {
    const schemes = card['securitySchemes'] as Record<
      string,
      {
        oauth2SecurityScheme: {
          flows: {
            authorizationCode: {
              authorizationUrl: string;
              tokenUrl: string;
              scopes: Record<string, string>;
              pkceRequired: boolean;
            };
          };
          oauth2MetadataUrl: string;
        };
      }
    >;
    const scheme = schemes[A2A_OAUTH_SCHEME_NAME].oauth2SecurityScheme;
    const flow = scheme.flows.authorizationCode;
    expect(flow.authorizationUrl).toBe('https://mcp.example.test/authorize');
    expect(flow.tokenUrl).toBe('https://mcp.example.test/token');
    expect(flow.pkceRequired).toBe(true);
    expect(Object.keys(flow.scopes)).toEqual([...SUPPORTED_SCOPES]);
    expect(scheme.oauth2MetadataUrl).toBe(
      'https://mcp.example.test/.well-known/oauth-authorization-server',
    );
  });

  it('スコープ説明の表は SUPPORTED_SCOPES と過不足なく一致する', () => {
    // SUPPORTED_SCOPES を増減したらここで気づく (説明がスコープ名そのままに落ちない)。
    expect(Object.keys(A2A_SCOPE_DESCRIPTIONS).sort()).toEqual(
      [...SUPPORTED_SCOPES].sort(),
    );
  });

  it('skills は skills.ts の定義から作り、各 skill が必須フィールドを持つ', () => {
    const skills = card['skills'] as Record<string, unknown>[];
    expect(skills.map((s) => s['id'])).toEqual(A2A_SKILLS.map((s) => s.id));
    for (const s of skills) {
      expect(typeof s['name']).toBe('string');
      expect(typeof s['description']).toBe('string');
      expect(Array.isArray(s['tags'])).toBe(true);
      expect((s['tags'] as unknown[]).length).toBeGreaterThan(0);
    }
  });
});
