import { downloadFile } from '../client.js';
import { downloadErrorResult } from './download-errors.js';

export const downloadFileTool = {
  name: 'download_file',
  description:
    'generate_pdf_asyncで出力したPDFを1件ダウンロードします。requestIdとfileIdを指定し、ローカルファイルパスを返します。outputDir を指定するとそのディレクトリに、未指定の場合は現在の作業ディレクトリに保存します。まだ生成中の場合はダウンロードせず FILE_NOT_READY と再試行までの秒数 (retryAfterSeconds) を返すので、その秒数をおいて再度呼び出してください。生成が失敗している場合は FILE_GENERATION_FAILED を返します (get_generation_status で理由を確認)。',
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
    // 生成中 (409) / 生成失敗 (422) / ID の誤り (404) を返し分ける (PRJ-3-2018)。
    return downloadErrorResult(err, 'download_file', input.requestId);
  }
};
