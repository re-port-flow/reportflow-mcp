import type { McpServer } from '@modelcontextprotocol/server';
import type { ResourceReadResult } from './designs.js';

export const ERROR_CATALOG_URI = 'reportflow://errors';

// Mirror of monepla/reports-content-service: src/common/constants/error-messages.ts
// 更新は両リポジトリ手動同期。ズレが疑わしい場合は content-service 側を正とすること。
export const ERROR_CATALOG = {
  AUTH: {
    UNAUTHORIZED: '認証情報が無効、または期限切れです。',
    FORBIDDEN: '対象リソースへのアクセス権がありません。',
    WORKSPACE_MISMATCH:
      'トークンに紐づくワークスペースとリクエスト先が一致しません。',
  },
  DESIGN: {
    NOT_FOUND: '指定されたデザインが見つかりません。',
    DESIGN_VERSION_NOT_FOUND: '指定されたデザインバージョンが見つかりません。',
    FILE_LIMIT_REACHED: '一度に生成可能なファイル数の上限に達しました。',
  },
  JOB: {
    NOT_FOUND: '指定された生成ジョブ (requestId) が見つかりません。',
    NOT_READY: 'ジョブはまだ完了していません。少し待って再試行してください。',
  },
  FILE: {
    PDF_CONVERSION_FAILED: 'PDF への変換に失敗しました。',
    DOWNLOAD_NOT_AVAILABLE:
      'ダウンロード対象が存在しないか、保管期限を過ぎています。',
  },
} as const;

export const readErrorCatalog = (uri: URL): ResourceReadResult => ({
  contents: [
    {
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify(ERROR_CATALOG, null, 2),
    },
  ],
});

export const registerErrorCatalogResource = (server: McpServer): void => {
  server.registerResource(
    'errors',
    ERROR_CATALOG_URI,
    {
      title: 'エラーカタログ',
      description:
        'Content Service が返す主要エラーメッセージのカタログ。AI が文面からエラー種別を判別する助けになります。',
      mimeType: 'application/json',
    },
    readErrorCatalog,
  );
};
