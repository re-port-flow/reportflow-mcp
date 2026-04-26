import { downloadZip } from '../client.js';

export const downloadZipTool = {
  name: 'download_zip',
  description:
    'generate_pdfs_asyncで生成したZIPファイルをダウンロードします。requestIdを指定し、ローカルのZIPファイルパスを返します。outputDir を指定するとそのディレクトリに、未指定の場合は現在の作業ディレクトリに保存します。',
};

export type DownloadZipInput = {
  requestId: string;
  fileName?: string;
  outputDir?: string;
};

export type DownloadZipResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleDownloadZip = async (
  input: DownloadZipInput,
): Promise<DownloadZipResult> => {
  try {
    const filePath = await downloadZip(
      input.requestId,
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
