import { ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDesignParameters, listDesigns } from '../client.js';
import { AuthRequiredError } from '../auth.js';
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
  // 未認証時 (Glama などの introspection) は resources/list を失敗させず空で返す。
  // 認証済みであれば従来どおりワークスペースのデザインを列挙する。
  const { designs } = await listDesigns().catch((err: unknown) => {
    if (err instanceof AuthRequiredError) return { designs: [] };
    throw err;
  });
  return {
    resources: designs.map((d) => ({
      uri: `reportflow://designs/${d.id}/parameters`,
      name: `${d.label} のパラメータスキーマ (v${d.latestVersion})`,
      mimeType: 'application/json',
    })),
  };
};

export const registerDesignParametersResource = (server: McpServer): void => {
  server.registerResource(
    'design-parameters',
    new ResourceTemplate(DESIGN_PARAMETERS_URI_TEMPLATE, {
      list: listDesignParameterResources,
    }),
    {
      title: 'デザインのパラメータスキーマ',
      description:
        '指定 designId の最新バージョンのパラメータ構造（get_design_parameters と同等内容。作成者が設定した場合は各フィールドの意味を表す description を含む）を Resource として公開。',
      mimeType: 'application/json',
    },
    readDesignParameters,
  );
};
