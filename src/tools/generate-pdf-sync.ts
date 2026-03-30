import { generatePdfSync, ContentDto } from '../client.js';

export const generatePdfSyncTool = {
  name: 'generate_pdf_sync',
  description:
    'デザインIDとパラメータを指定してPDFを同期生成します。生成完了後にローカルファイルパスを返します。単一PDFの即時生成に適しています。',
};

export type GeneratePdfSyncInput = {
  designId: string;
  version: number;
  content: ContentDto;
};

export type GeneratePdfSyncResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleGeneratePdfSync = async (
  input: GeneratePdfSyncInput,
): Promise<GeneratePdfSyncResult> => {
  try {
    const filePath = await generatePdfSync(input);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ filePath }, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
