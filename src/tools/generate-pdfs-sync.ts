import { generatePdfsSync, ContentDto } from '../client.js';

export const generatePdfsSyncTool = {
  name: 'generate_pdfs_sync',
  description:
    '複数のパラメータセットでPDFを一括同期生成し、ZIPファイルとして返します。生成完了後にZIPファイルのローカルパスを返します。',
};

export type GeneratePdfsSyncInput = {
  designId: string;
  version: number;
  contents: ContentDto[];
};

export type GeneratePdfsSyncResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleGeneratePdfsSync = async (
  input: GeneratePdfsSyncInput,
): Promise<GeneratePdfsSyncResult> => {
  try {
    const filePath = await generatePdfsSync(input);
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
