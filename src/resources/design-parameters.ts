import {
  ResourceTemplate,
  type McpServer,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDesignParameters, listDesigns } from '../client.js';
import type { ResourceReadResult } from './designs.js';

export const DESIGN_PARAMETERS_URI_TEMPLATE =
  'reportflow://designs/{designId}/parameters';

export const readDesignParameters = async (
  uri: URL,
  variables: Record<string, string | string[]>,
): Promise<ResourceReadResult> => {
  const raw = variables['designId'];
  const designId = Array.isArray(raw) ? raw[0] : raw;
  if (!designId) {
    throw new Error('designId が URI から抽出できませんでした');
  }
  const result = await getDesignParameters(designId);
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
};

export const listDesignParameterResources = async () => {
  const { designs } = await listDesigns();
  return {
    resources: designs.map((d) => ({
      uri: `reportflow://designs/${d.id}/parameters`,
      name: `${d.label} のパラメータスキーマ (v${d.latestVersion})`,
      mimeType: 'application/json',
    })),
  };
};

export const registerDesignParametersResource = (server: McpServer): void => {
  server.resource(
    'design-parameters',
    new ResourceTemplate(DESIGN_PARAMETERS_URI_TEMPLATE, {
      list: listDesignParameterResources,
    }),
    {
      title: 'デザインのパラメータスキーマ',
      description:
        '指定 designId の最新バージョンのパラメータ構造（get_design_parameters と同等内容）を Resource として公開。',
      mimeType: 'application/json',
    },
    readDesignParameters,
  );
};
