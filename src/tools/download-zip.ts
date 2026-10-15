import { downloadZip } from '../client.js';
import { downloadErrorResult } from './download-errors.js';

export const downloadZipTool = {
  name: 'download_zip',
  description:
    'generate_pdfs_asyncで出力したPDFをまとめたZIPファイルをダウンロードします。requestIdを指定し、ローカルのZIPファイルパスを返します。outputDir を指定するとそのディレクトリに、未指定の場合は現在の作業ディレクトリに保存します。まだ生成中の場合はダウンロードせず FILE_NOT_READY と再試行までの秒数 (retryAfterSeconds) を返すので、その秒数をおいて再度呼び出してください。生成が失敗している場合は FILE_GENERATION_FAILED を返します (get_generation_status で理由を確認)。',
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
    // 生成中 (409) / 生成失敗 (422) / ID の誤り (404) を返し分ける (PRJ-3-2018)。
    return downloadErrorResult(err, 'download_zip', input.requestId);
  }
};
