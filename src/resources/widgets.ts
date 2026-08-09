import type { McpServer } from '@modelcontextprotocol/server';
import {
  TEMPLATE_LIST_WIDGET_URI,
  TEMPLATE_LIST_WIDGET_HTML,
  WIDGET_MIME_TYPE,
} from '../widgets/template-list.js';

/**
 * ChatGPT Apps SDK 用の widget リソースを登録する。HTTP モード (ChatGPT 経路)
 * 専用。`ui://` URI / mimeType `text/html;profile=mcp-app` で公開し、対応する
 * ツールの `_meta["openai/outputTemplate"]` から参照される。
 */
export const registerWidgetResources = (server: McpServer): void => {
  server.registerResource(
    'template-list-widget',
    TEMPLATE_LIST_WIDGET_URI,
    {
      title: 'Re:port Flow テンプレート一覧 Widget',
      description:
        'search ツールの結果（テンプレート一覧）を ChatGPT 上でカード表示する Apps SDK widget。',
      mimeType: WIDGET_MIME_TYPE,
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: WIDGET_MIME_TYPE,
          text: TEMPLATE_LIST_WIDGET_HTML,
        },
      ],
    }),
  );
};
