import type { McpServer } from '@modelcontextprotocol/server';
import { listDesigns } from '../client.js';

export const DESIGNS_RESOURCE_URI = 'reportflow://designs';

export type ResourceReadResult = {
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
};

export const readDesigns = async (uri: URL): Promise<ResourceReadResult> => {
  const result = await listDesigns();
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

export const registerDesignsResource = (server: McpServer): void => {
  server.registerResource(
    'designs',
    DESIGNS_RESOURCE_URI,
    {
      title: 'デザインテンプレート一覧',
      description:
        'ワークスペース内のすべてのデザインテンプレート (id / label / latestVersion / thumbnail / updatedAt)。list_templates と同等の内容を Resource として公開。',
      mimeType: 'application/json',
    },
    readDesigns,
  );
};
