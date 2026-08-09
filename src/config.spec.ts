// config.ts resolves the stage from NODE_ENV at module-load time, so each
// branch is exercised by re-importing the module under an isolated registry
// with NODE_ENV set accordingly.

describe('config stage resolution', () => {
  let originalNodeEnv: string | undefined;

  beforeAll(() => {
    originalNodeEnv = process.env['NODE_ENV'];
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
    jest.resetModules();
  });

  it('uses production URLs by default (NODE_ENV unset)', () => {
    delete process.env['NODE_ENV'];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const config = require('./config') as typeof import('./config');
      expect(config.RUNTIME_STAGE).toBe('prod');
      expect(config.REPORTFLOW_API_BASE_URL).toBe('https://api.re-port-flow.com');
      expect(config.MCP_RESOURCE_URL).toBe('https://mcp.re-port-flow.com');
      expect(config.REPORTFLOW_OAUTH_ISSUER_URL).toBe(
        'https://re-port-flow.com/api/v1',
      );
    });
  });

  it('uses staging URLs only when NODE_ENV=staging (opt-in)', () => {
    process.env['NODE_ENV'] = 'staging';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const config = require('./config') as typeof import('./config');
      expect(config.RUNTIME_STAGE).toBe('stg');
      expect(config.REPORTFLOW_API_BASE_URL).toBe(
        'https://api.stg.re-port-flow.com',
      );
      expect(config.REPORTFLOW_OAUTH_ISSUER_URL).toBe(
        'https://stg.re-port-flow.com/api/v1',
      );
    });
  });

  it('treats any non-staging NODE_ENV as production', () => {
    process.env['NODE_ENV'] = 'production';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const config = require('./config') as typeof import('./config');
      expect(config.RUNTIME_STAGE).toBe('prod');
    });
  });

  it('builds RFC 9728 protected-resource metadata advertising the MCP resource', () => {
    delete process.env['NODE_ENV'];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const config = require('./config') as typeof import('./config');
      const prm = config.buildProtectedResourceMetadata();
      // 期待値はリテラルで固定する (実装と同じ式を使うと半トートロジーになるため)。
      expect(prm.resource).toBe('https://mcp.re-port-flow.com');
      expect(prm.authorization_servers).toEqual([
        'https://mcp.re-port-flow.com',
      ]);
      expect(prm.scopes_supported).toEqual([
        'openid',
        'profile',
        'designs:read',
        'designs:write',
        'templates:read',
        'templates:write',
        'pdf:generate',
      ]);
      expect(prm.bearer_methods_supported).toEqual(['header']);
      expect(prm.resource_documentation).toBe(
        'https://re-port-flow.com/docs/mcp',
      );
    });
  });

  it('pins the exact set of supported scopes (RFC 8414 / RFC 9728 advertised list)', () => {
    delete process.env['NODE_ENV'];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const config = require('./config') as typeof import('./config');
      expect(config.SUPPORTED_SCOPES).toEqual([
        'openid',
        'profile',
        'designs:read',
        'designs:write',
        'templates:read',
        'templates:write',
        'pdf:generate',
      ]);
    });
  });
});
