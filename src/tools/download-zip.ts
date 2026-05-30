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

export type DownloadZipDeps = {
  /** 明示 `outputDir` 指定時の許可ルート集合解決。詳細は generate-pdf-sync.ts を参照。 */
  resolveAllowedRoots?: () => Promise<string[]>;
};

export const handleDownloadZip = async (
  input: DownloadZipInput,
  deps: DownloadZipDeps = {},
): Promise<DownloadZipResult> => {
  try {
    const allowedRoots =
      input.outputDir != null && deps.resolveAllowedRoots
        ? await deps.resolveAllowedRoots()
        : undefined;
    const filePath = await downloadZip(
      input.requestId,
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
