import { HttpError } from '../http.js';

/**
 * download_file / download_zip の失敗を、LLM が次の一手を選べる応答にする
 * (PRJ-3-2018)。
 *
 * ダウンロード API は以前、生成中のファイルにも 404 を返していたため「ID の誤り」
 * と「まだ生成中」を区別できなかった。現在は次のように返し分ける:
 * - 409 `FILE_NOT_READY`         : 生成中 (`Retry-After` 秒後に再試行すればよい)
 * - 422 `FILE_GENERATION_FAILED` : 生成が失敗済み (再試行しても取れない)
 * - 404                          : requestId / fileId の誤り、または出力が削除済み
 *
 * 生成中は**失敗ではなく状態**なので `isError` を付けない。付けると LLM は
 * 「ダウンロードできない」と利用者に伝えて会話を終えうる。
 */
export type DownloadToolResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const FILE_NOT_READY = 'FILE_NOT_READY';
export const FILE_GENERATION_FAILED = 'FILE_GENERATION_FAILED';

export const downloadErrorResult = (
  err: unknown,
  toolName: 'download_file' | 'download_zip',
  requestId: string,
): DownloadToolResult => {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof HttpError && err.code === FILE_NOT_READY) {
    const wait =
      err.retryAfter !== undefined
        ? `${err.retryAfter} 秒後に`
        : '数秒おいてから';
    const payload = {
      status: 'processing',
      code: FILE_NOT_READY,
      requestId,
      downloaded: false,
      ...(err.retryAfter !== undefined
        ? { retryAfterSeconds: err.retryAfter }
        : {}),
    };
    return {
      content: [
        {
          type: 'text',
          text: `PDF はまだ生成中のため、ダウンロードしていません (${FILE_NOT_READY})。${wait}同じ requestId で ${toolName} を再度呼び出してください。進み具合は get_generation_status で確認できます。\n\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
    };
  }

  if (err instanceof HttpError && err.code === FILE_GENERATION_FAILED) {
    return {
      content: [
        {
          type: 'text',
          text: `エラー: PDF の生成が失敗しているため、ダウンロードできません (${FILE_GENERATION_FAILED})。同じ requestId で再試行しても取得できません。get_generation_status に requestId "${requestId}" を渡して失敗理由 (error.code / error.message) を確認し、その案内に従って対処してください。\n詳細: ${message}`,
        },
      ],
      isError: true,
    };
  }

  if (err instanceof HttpError && err.status === 404) {
    return {
      content: [
        {
          type: 'text',
          text: `エラー: ${message}\n対処: 生成中なら 409 が返るため、404 は生成中ではありません。requestId${
            toolName === 'download_file' ? ' / fileId' : ''
          } が生成ツールの応答の値と一致しているか確認してください。一致している場合は出力が削除された可能性があるので、get_generation_status に requestId "${requestId}" を渡して状態を確認してください。`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `エラー: ${message}` }],
    isError: true,
  };
};
