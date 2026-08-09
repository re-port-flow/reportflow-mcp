import type { McpServer } from '@modelcontextprotocol/server';
import type { ResourceReadResult } from './designs.js';

export const SERVER_INFO_URI = 'reportflow://server-info';

export const buildServerInfo = (pkg: { name: string; version: string }) => ({
  name: pkg.name,
  version: pkg.version,
  description:
    'Re:port Flow MCP（パッケージ名: reportflow-mcp）。Re:port Flow テンプレートを使う PDF 帳票生成サーバーで、Tools / Prompts / Resources / Sampling / Roots に対応。',
  capabilities: {
    tools: [
      'authenticate',
      'list_templates',
      'get_design_parameters',
      'generate_pdf_sync',
      'generate_pdf_async',
      'generate_pdfs_sync',
      'generate_pdfs_async',
      'download_file',
      'download_zip',
      'suggest_params',
    ],
    prompts: ['generate_pdf', 'generate_pdfs', 'reportflow_help'],
    resources: [
      'reportflow://designs',
      'reportflow://designs/{designId}/parameters',
      'reportflow://errors',
      'reportflow://server-info',
    ],
  },
  envVars: {
    REPORTFLOW_API_BASE_URL:
      process.env['REPORTFLOW_API_BASE_URL'] ?? 'https://api.re-port-flow.com',
    REPORTFLOW_AUTH_URL:
      process.env['REPORTFLOW_AUTH_URL'] ?? 'https://re-port-flow.com/api/v1',
    REPORTFLOW_CLIENT_ID:
      process.env['REPORTFLOW_CLIENT_ID'] ?? 'reportflow-mcp',
  },
  workflow: {
    singlePdf: [
      'authenticate',
      'list_templates',
      'get_design_parameters',
      'generate_pdf_sync',
    ],
    bulkPdf: [
      'authenticate',
      'list_templates',
      'get_design_parameters',
      'generate_pdfs_async',
      'download_zip',
    ],
  },
});

export const buildReadServerInfo =
  (pkg: { name: string; version: string }) =>
  (uri: URL): ResourceReadResult => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(buildServerInfo(pkg), null, 2),
      },
    ],
  });

export const registerServerInfoResource = (
  server: McpServer,
  pkg: { name: string; version: string },
): void => {
  server.registerResource(
    'server-info',
    SERVER_INFO_URI,
    {
      title: 'サーバー情報',
      description:
        'このサーバーの提供機能・対応ワークフロー・環境変数の概観 JSON。',
      mimeType: 'application/json',
    },
    buildReadServerInfo(pkg),
  );
};
