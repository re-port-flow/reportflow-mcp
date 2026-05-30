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

export type DownloadFileDeps = {
  /** 明示 `outputDir` 指定時の許可ルート集合解決。詳細は generate-pdf-sync.ts を参照。 */
  resolveAllowedRoots?: () => Promise<string[]>;
};

export const handleDownloadFile = async (
  input: DownloadFileInput,
  deps: DownloadFileDeps = {},
): Promise<DownloadFileResult> => {
  try {
    const allowedRoots =
      input.outputDir != null && deps.resolveAllowedRoots
        ? await deps.resolveAllowedRoots()
        : undefined;
    const filePath = await downloadFile(
      input.requestId,
      input.fileId,
      input.fileName,
      input.outputDir,
      allowedRoots,
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
