import { getGenerationStatus, type GenerationStatusResult } from '../client.js';
import {
  buildStatusCard,
  safeCard,
  type SlackMeta,
} from '../slack/status-card.js';
import {
  failedFilesOf,
  planBreakdownOf,
  retryAfterSecondsOf,
} from '../generation-plan.js';

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
  /**
   * Slack opt-in 時だけ true (PRJ-3-2563)。成功時に `_meta.slack.blocks` へ状態カードを
   * 足す。text の応答は変えない。失敗 (isError) にはカードを付けない。
   */
  slackBlocks?: boolean;
};

export type GetGenerationStatusResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
  _meta?: SlackMeta;
};

/**
 * failed の対処は error.code で変わる。プランの上限や設定 (PLAN_PAGE_LIMIT_EXCEEDED /
 * ACTIVE_PLAN_NOT_FOUND など、code に PLAN を含むもの) は入力を直しても解消しない
 * ので、再生成ではなく利用者への伝達を促す (instructions.ts の「プラン・上限の
 * 失敗はアップグレードの案内を伝える」と揃える)。
 */
const PLAN_ACTION =
  'プランの上限や設定による失敗です。入力を直して再生成しても解消しないため、error.message をそのまま利用者に伝えてください (アップグレードの案内があれば含めてください)。';
const OTHER_ACTION =
  'error.code / error.message に従って対処してください (入力の誤りなら直してから生成をやり直してください)。';
/**
 * ファイルごとの code でプラン起因と判定したときの案内。理由とアップグレードの
 * 案内は failedFiles 側の message に入り、上位の error.message は総称
 * (例: "All N files failed to generate.") なので、伝える message を取り違えない。
 */
const PLAN_ACTION_PER_FILE =
  'プランの上限や設定による失敗です。入力を直して再生成しても解消しないため、failedFiles のうち code が PLAN を含むものの message をそのまま利用者に伝えてください (アップグレードの案内があれば含めてください)。';
/**
 * failed の案内。プラン起因の理由が入っている場所ごとに、伝えさせる message を
 * 選ぶ (planBreakdownOf)。プラン以外の失敗が残っていれば、その直し方も必ず足す。
 *
 * - ファイル側に PLAN 系がある → failedFiles のうち PLAN 系の message を伝える
 * - 上位だけが PLAN 系 → error.message を伝える (単一出力の失敗、または上位だけが PLAN 系)
 * - PLAN 系でない失敗 (ファイル側、または failedFiles 無しで上位も PLAN 系でない) → 直して再生成
 */
const failedAction = (status: GenerationStatusResult): string => {
  const { topIsPlan, planFiles, otherFiles } = planBreakdownOf(status);
  // 上位とファイル側の両方が PLAN 系なら、両方の message を伝えさせる
  // (上位にもアップグレードの案内が入り得る)。
  const planAction =
    planFiles > 0
      ? topIsPlan
        ? `${PLAN_ACTION_PER_FILE} 上位の error.message にも案内があれば併せて伝えてください。`
        : PLAN_ACTION_PER_FILE
      : topIsPlan
        ? PLAN_ACTION
        : '';
  if (planAction === '') return OTHER_ACTION;
  // プラン起因と入力の誤り等が混ざっている。片方の案内だけにすると、
  // もう片方の失敗の直し方が消える。
  return otherFiles > 0
    ? `${planAction} プラン以外の理由 (failedFiles の code が PLAN を含まないもの) で失敗したファイルは、その code / message に従って対処してください (入力の誤りなら直してから生成をやり直してください)。`
    : planAction;
};

/**
 * completed の一部失敗で、プラン起因の失敗があるときの案内 (planBreakdownOf)。
 * PLAN を含まない失敗だけなら従来どおり何も足さない。
 */
const partialPlanAction = (status: GenerationStatusResult): string => {
  const { topIsPlan, planFiles, otherFiles } = planBreakdownOf(status);
  // failed 側 (failedAction) と同じく、上位とファイル側の両方が PLAN 系なら
  // 上位の error.message も伝えさせる。
  const alsoTop = topIsPlan
    ? ' 上位の error.message にも案内があれば併せて伝えてください。'
    : '';
  if (planFiles > 0 && otherFiles === 0) {
    return ` 失敗したファイルはプランの上限や設定によるもので、入力を直して再生成しても解消しないため、failedFiles の message をそのまま利用者に伝えてください (アップグレードの案内があれば含めてください)。${alsoTop}`;
  }
  if (planFiles > 0) {
    return ` failedFiles の code が PLAN を含むファイルはプランの上限や設定による失敗で、再生成しても解消しないため message を利用者に伝えてください。${alsoTop} それ以外は入力の誤りなら直してから生成をやり直してください。`;
  }
  if (topIsPlan) {
    return ` error.code がプランの上限や設定によるもので、入力を直して再生成しても解消しないため、error.message をそのまま利用者に伝えてください (アップグレードの案内があれば含めてください)。${
      otherFiles > 0
        ? ' failedFiles の失敗は、入力の誤りなら直してから生成をやり直してください。'
        : ''
    }`;
  }
  return '';
};

const nextStep = (
  status: GenerationStatusResult,
  mode: 'stdio' | 'http',
): string => {
  switch (status.status) {
    case 'queued':
    case 'processing':
      return `生成中です。${
        retryAfterSecondsOf(status) !== undefined
          ? `${retryAfterSecondsOf(status)} 秒後に`
          : '数秒おいてから'
      }同じ requestId で get_generation_status を再度呼び出してください。`;
    case 'completed': {
      // 件数はカードと同じく failedFilesOf (契約外の要素を捨てた後) で数える。
      const failedCount = failedFilesOf(status).length;
      const partial =
        failedCount > 0
          ? ` ただし ${failedCount} 件は生成に失敗しています (failedFiles の code / message を参照)。${partialPlanAction(status)}`
          : '';
      return mode === 'http'
        ? `生成が完了しました。生成ツールの応答にある url (Web アプリの出力履歴画面) から確認・ダウンロードできます。${partial}`
        : `生成が完了しました。download_file (1 件ずつ) または download_zip (まとめて) で取得できます。${partial}`;
    }
    case 'failed': {
      const perFile =
        failedFilesOf(status).length > 0
          ? ` ファイルごとの理由は failedFiles の code / message を参照してください。`
          : '';
      return `生成に失敗しました${
        status.error ? ` (${status.error.code}: ${status.error.message})` : ''
      }。${perFile}${failedAction(status)}同じ requestId をダウンロードしても取得できません。`;
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
    const card =
      deps.slackBlocks === true
        ? safeCard(() => buildStatusCard(status))
        : null;
    return {
      content: [
        {
          type: 'text',
          text: `${nextStep(status, mode)}\n\n${JSON.stringify(status, null, 2)}`,
        },
      ],
      ...(card !== null ? { _meta: card } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
