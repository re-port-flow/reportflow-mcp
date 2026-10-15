import { getGenerationStatus, type GenerationStatusResult } from '../client.js';

/**
 * get_generation_status (PRJ-3-2018)。
 *
 * 非同期生成 (generate_pdf_async / generate_pdfs_async) の完了・失敗を、
 * ダウンロードを試して推測させずに確認するための読み取りツール。
 * content-service の `GET /v1/file/status/{requestId}` をそのまま中継し、
 * 状態ごとの次の一手を 1 行添える。
 */
export const getGenerationStatusTool = {
  name: 'get_generation_status',
  description:
    'generate_pdf_async / generate_pdfs_async で受け付けた PDF 出力リクエストの状態を取得します。requestId（16 文字の英数字。UUID ではない）を指定すると status（queued / processing / completed / failed）を返します。completed なら files[]（fileId・fileName・pageCount）、一部失敗なら failedFiles[]、failed なら error（code・message）を含みます（複数出力の全件失敗では failedFiles[] にファイルごとの理由も入ります）。生成中（queued / processing）の場合は retryAfterSeconds 秒おいてから再度呼び出してください。詳しい状態は完了・失敗から 24 時間保持され、それを過ぎると completed、または複数出力の全件失敗なら failed（FILE_GENERATION_FAILED）だけを返し、ファイルごとの理由は返りません（1 件出力の失敗は 24 時間を過ぎると 404 になります）。存在しない requestId と、生成後に削除された出力も 404 になります。',
};

export type GetGenerationStatusInput = {
  requestId: string;
};

export type GetGenerationStatusDeps = {
  /**
   * stdio: download_file / download_zip で取得できる。
   * http : ダウンロードツールが無いので、生成ツールの応答の url (Web アプリの
   *        出力履歴画面) を案内する。
   */
  mode?: 'stdio' | 'http';
};

export type GetGenerationStatusResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

/**
 * failed の対処は error.code で変わる。プランの上限や設定 (PLAN_PAGE_LIMIT_EXCEEDED /
 * ACTIVE_PLAN_NOT_FOUND など、code に PLAN を含むもの) は入力を直しても解消しない
 * ので、再生成ではなく利用者への伝達を促す (instructions.ts の「プラン・上限の
 * 失敗はアップグレードの案内を伝える」と揃える)。
 */
const failedAction = (code: string | undefined): string =>
  code !== undefined && /(^|_)PLAN(_|$)/.test(code)
    ? 'プランの上限や設定による失敗です。入力を直して再生成しても解消しないため、error.message をそのまま利用者に伝えてください (アップグレードの案内があれば含めてください)。'
    : 'error.code / error.message に従って対処してください (入力の誤りなら直してから生成をやり直してください)。';

const nextStep = (
  status: GenerationStatusResult,
  mode: 'stdio' | 'http',
): string => {
  switch (status.status) {
    case 'queued':
    case 'processing':
      return `生成中です。${
        status.retryAfterSeconds !== undefined
          ? `${status.retryAfterSeconds} 秒後に`
          : '数秒おいてから'
      }同じ requestId で get_generation_status を再度呼び出してください。`;
    case 'completed': {
      const partial =
        status.failedFiles && status.failedFiles.length > 0
          ? ` ただし ${status.failedFiles.length} 件は生成に失敗しています (failedFiles の code / message を参照)。`
          : '';
      return mode === 'http'
        ? `生成が完了しました。生成ツールの応答にある url (Web アプリの出力履歴画面) から確認・ダウンロードできます。${partial}`
        : `生成が完了しました。download_file (1 件ずつ) または download_zip (まとめて) で取得できます。${partial}`;
    }
    case 'failed': {
      const perFile =
        status.failedFiles && status.failedFiles.length > 0
          ? ` ファイルごとの理由は failedFiles の code / message を参照してください。`
          : '';
      return `生成に失敗しました${
        status.error ? ` (${status.error.code}: ${status.error.message})` : ''
      }。${perFile}${failedAction(status.error?.code)}同じ requestId をダウンロードしても取得できません。`;
    }
    default:
      // 契約外の status。推測で案内せず、値だけを返す。
      return `status: ${String(status.status)}`;
  }
};

export const handleGetGenerationStatus = async (
  input: GetGenerationStatusInput,
  deps: GetGenerationStatusDeps = {},
): Promise<GetGenerationStatusResult> => {
  const mode = deps.mode ?? 'stdio';
  try {
    const status = await getGenerationStatus(input.requestId);
    return {
      content: [
        {
          type: 'text',
          text: `${nextStep(status, mode)}\n\n${JSON.stringify(status, null, 2)}`,
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
