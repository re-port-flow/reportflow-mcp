import {
  buildReadServerInfo,
  buildServerInfo,
  SERVER_INFO_URI,
} from './server-info.js';
import { PUBLIC_CAPABILITIES } from '../workspace-permission.js';

const PKG = { name: 'reportflow-mcp', version: '9.9.9' };

describe('buildServerInfo', () => {
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

  it('does not expose runtime environment configuration', () => {
    process.env.REPORTFLOW_API_BASE_URL = 'https://internal.example';
    process.env.REPORTFLOW_AUTH_URL = 'https://oauth.internal.example';
    process.env.REPORTFLOW_CLIENT_ID = 'secret-client-id';
    const info = buildServerInfo(PKG);
    expect(info).not.toHaveProperty('envVars');
  });

  it('does not advertise workspace resources to an unauthenticated client', () => {
    const info = buildServerInfo(PKG, PUBLIC_CAPABILITIES);

    expect(info.capabilities.resources).toEqual([
      'reportflow://errors',
      'reportflow://server-info',
    ]);
    expect(info.capabilities.resources).not.toContain('reportflow://designs');
    expect(info.capabilities.resources).not.toContain(
      'reportflow://designs/{designId}/parameters',
    );
  });

  it('reflects capability changes when server-info is read again', () => {
    let granted = PUBLIC_CAPABILITIES;
    const read = buildReadServerInfo(PKG, () => granted);
    const publicInfo = JSON.parse(
      read(new URL(SERVER_INFO_URI)).contents[0].text,
    ) as ReturnType<typeof buildServerInfo>;

    granted = new Set([
      'public',
      'workspace.read',
      'workspace.generate',
    ] as const);
    const authenticatedInfo = JSON.parse(
      read(new URL(SERVER_INFO_URI)).contents[0].text,
    ) as ReturnType<typeof buildServerInfo>;

    expect(publicInfo.capabilities.resources).toEqual([
      'reportflow://errors',
      'reportflow://server-info',
    ]);
    expect(authenticatedInfo.capabilities.resources).toEqual([
      'reportflow://designs',
      'reportflow://designs/{designId}/parameters',
      'reportflow://errors',
      'reportflow://server-info',
    ]);
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
