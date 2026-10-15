import type { McpServer } from '@modelcontextprotocol/server';
import type { CapabilityToggle } from '../workspace-permission.js';
import {
  requiredCapabilityForResource,
  requiredCapabilityForTool,
  type WorkspaceCapability,
} from '../workspace-permission.js';
import type { ResourceReadResult } from './designs.js';

export const SERVER_INFO_URI = 'reportflow://server-info';
export type CapabilityGetter = () => ReadonlySet<WorkspaceCapability>;

const TOOL_NAMES = [
  'authenticate',
  'list_templates',
  'get_design_parameters',
  'generate_pdf_sync',
  'generate_pdf_async',
  'generate_pdfs_sync',
  'generate_pdfs_async',
  'download_file',
  'download_zip',
  'get_generation_status',
  'suggest_params',
] as const;

const RESOURCE_URIS = [
  ['designs', 'reportflow://designs'],
  ['design-parameters', 'reportflow://designs/{designId}/parameters'],
  ['errors', 'reportflow://errors'],
  ['server-info', 'reportflow://server-info'],
] as const;

const allCapabilities = new Set<WorkspaceCapability>([
  'public',
  'workspace.read',
  'workspace.generate',
  'workspace.write',
]);

const isVisible = (
  granted: ReadonlySet<WorkspaceCapability>,
  required: WorkspaceCapability,
): boolean => granted.has(required);

export const buildServerInfo = (
  pkg: { name: string; version: string },
  granted: ReadonlySet<WorkspaceCapability> = allCapabilities,
) => ({
  name: pkg.name,
  version: pkg.version,
  description:
    'Re:port Flow MCP（パッケージ名: reportflow-mcp）。Re:port Flow のテンプレートから PDF を出力するサーバーで、Tools / Prompts / Resources / Sampling / Roots に対応。',
  capabilities: {
    tools: TOOL_NAMES.filter((name) =>
      isVisible(granted, requiredCapabilityForTool(name)),
    ),
    prompts: ['generate_pdf', 'generate_pdfs', 'reportflow_help'],
    resources: RESOURCE_URIS.filter(([name]) =>
      isVisible(granted, requiredCapabilityForResource(name)),
    ).map(([, uri]) => uri),
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
  (
    pkg: { name: string; version: string },
    getGranted: CapabilityGetter = () => allCapabilities,
  ) =>
  (uri: URL): ResourceReadResult => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(buildServerInfo(pkg, getGranted()), null, 2),
      },
    ],
  });

export const registerServerInfoResource = (
  server: McpServer,
  pkg: { name: string; version: string },
  getGranted: CapabilityGetter = () => allCapabilities,
): CapabilityToggle => {
  return server.registerResource(
    'server-info',
    SERVER_INFO_URI,
    {
      title: 'サーバー情報',
      description: 'このサーバーの提供機能と対応ワークフローの概観 JSON。',
      mimeType: 'application/json',
    },
    buildReadServerInfo(pkg, getGranted),
  );
};
