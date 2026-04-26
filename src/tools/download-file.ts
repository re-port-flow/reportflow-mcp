import { downloadFile } from '../client.js';

export const downloadFileTool = {
  name: 'download_file',
  description:
    'generate_pdf_asyncで生成した単一PDFファイルをダウンロードします。requestIdとfileIdを指定し、ローカルファイルパスを返します。outputDir を指定するとそのディレクトリに、未指定の場合は現在の作業ディレクトリに保存します。',
};

export type DownloadFileInput = {
  requestId: string;
  fileId: string;
  fileName?: string;
  outputDir?: string;
};

export type DownloadFileResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleDownloadFile = async (
  input: DownloadFileInput,
): Promise<DownloadFileResult> => {
  try {
    const filePath = await downloadFile(
      input.requestId,
      input.fileId,
      input.fileName,
      input.outputDir,
    );
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
