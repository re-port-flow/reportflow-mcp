import { generatePdfsAsync, ContentDto, ExportResponse } from '../client.js';

export const generatePdfsAsyncTool = {
  name: 'generate_pdfs_async',
  description:
    '複数のパラメータセットでPDFを一括非同期生成します。即座にrequestIdとfiles情報を返します。ZIPダウンロードはdownload_zipツールを使用してください。',
};

export type GeneratePdfsAsyncInput = {
  designId: string;
  version: number;
  contents: ContentDto[];
};

export type GeneratePdfsAsyncResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleGeneratePdfsAsync = async (
  input: GeneratePdfsAsyncInput,
): Promise<GeneratePdfsAsyncResult> => {
  try {
    const result: ExportResponse = await generatePdfsAsync(input);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
