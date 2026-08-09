import {
  buildReadServerInfo,
  buildServerInfo,
  SERVER_INFO_URI,
} from './server-info.js';

const PKG = { name: 'reportflow-mcp', version: '9.9.9' };

const ENV_KEYS = [
  'REPORTFLOW_API_BASE_URL',
  'REPORTFLOW_AUTH_URL',
  'REPORTFLOW_CLIENT_ID',
] as const;

describe('buildServerInfo', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('reflects the package name/version and full capability surface', () => {
    const info = buildServerInfo(PKG);
    expect(info.name).toBe('reportflow-mcp');
    expect(info.version).toBe('9.9.9');
    expect(info.description).toContain('Re:port Flow MCP');
    expect(info.description).toContain('reportflow-mcp');
    expect(info.capabilities.tools).toContain('generate_pdf_sync');
    expect(info.capabilities.prompts).toContain('reportflow_help');
    expect(info.capabilities.resources).toContain('reportflow://server-info');
    expect(info.workflow.singlePdf[0]).toBe('authenticate');
    expect(info.workflow.bulkPdf).toContain('download_zip');
  });

  it('falls back to default env values when unset', () => {
    const info = buildServerInfo(PKG);
    expect(info.envVars.REPORTFLOW_API_BASE_URL).toBe(
      'https://api.re-port-flow.com',
    );
    expect(info.envVars.REPORTFLOW_AUTH_URL).toBe(
      'https://re-port-flow.com/api/v1',
    );
    expect(info.envVars.REPORTFLOW_CLIENT_ID).toBe('reportflow-mcp');
  });

  it('reflects overridden env values', () => {
    process.env.REPORTFLOW_API_BASE_URL = 'https://api.stg.re-port-flow.com';
    process.env.REPORTFLOW_AUTH_URL = 'https://stg.re-port-flow.com/api/v1';
    process.env.REPORTFLOW_CLIENT_ID = 'custom-client';
    const info = buildServerInfo(PKG);
    expect(info.envVars).toEqual({
      REPORTFLOW_API_BASE_URL: 'https://api.stg.re-port-flow.com',
      REPORTFLOW_AUTH_URL: 'https://stg.re-port-flow.com/api/v1',
      REPORTFLOW_CLIENT_ID: 'custom-client',
    });
  });
});

describe('buildReadServerInfo', () => {
  it('serializes the server info as JSON at the requested uri', () => {
    const read = buildReadServerInfo(PKG);
    const uri = new URL(SERVER_INFO_URI);
    const result = read(uri);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe(uri.href);
    expect(result.contents[0].mimeType).toBe('application/json');
    expect(JSON.parse(result.contents[0].text)).toEqual(buildServerInfo(PKG));
  });
});
