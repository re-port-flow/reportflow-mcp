import type { GenerationStatusResult } from './client.js';

/**
 * 生成の失敗がプランの上限や設定によるものか (PRJ-3-2563)。
 *
 * code に `PLAN` を語として含むもの (PLAN_PAGE_LIMIT_EXCEEDED /
 * ACTIVE_PLAN_NOT_FOUND など) は入力を直しても解消しない。
 *
 * - `failedFiles` があれば**ファイルごとの code で判定する**。複数出力の全件失敗では
 *   上位の `error.code` は FILE_GENERATION_FAILED のような総称で、理由はファイル側に
 *   入る。上位の code が PLAN 系なら、それもプラン起因として数える。
 * - `failedFiles` が無ければ上位の `error.code` で判定する。
 *
 * 戻り値:
 * - `'all'`  : 失敗はすべてプラン起因 (再生成では直らない)
 * - `'mixed'`: プラン起因と、それ以外 (入力の誤り等) が混ざっている
 * - `'none'` : プラン起因の失敗は無い
 *
 * 判定の元はこのファイルの planBreakdownOf 1 つ。Slack のカード (slack/status-card.ts)
 * は planCauseOf で 3 値に畳んで使い、text の応答 (get-generation-status.ts) は
 * 伝えさせる message の場所 (上位 / ファイル側) を選ぶため planBreakdownOf を直接使う。
 * 判定をこのファイルの外で別に持たない (別々に持つと案内が食い違う)。
 */
export type PlanCause = 'all' | 'mixed' | 'none';

const PLAN_CODE = /(^|_)PLAN(_|$)/;

type FailedFile = NonNullable<GenerationStatusResult['failedFiles']>[number];

/**
 * 上流の `failedFiles` を読める形にそろえる。上流の値は実行時に検査されていない
 * (client.ts は型を当てるだけ) ので、配列でない値や `null` の要素を捨てる。
 * text の応答とカードの両方がこれを通す (片方だけ守ると、守っていない側が落ちる)。
 */
export const failedFilesOf = (
  status: Pick<GenerationStatusResult, 'failedFiles'>,
): FailedFile[] =>
  Array.isArray(status.failedFiles)
    ? status.failedFiles.filter(
        (f): f is FailedFile => typeof f === 'object' && f !== null,
      )
    : [];
const isPlanCode = (code: unknown): boolean =>
  typeof code === 'string' && PLAN_CODE.test(code);

export const planCauseOf = (
  status: Pick<GenerationStatusResult, 'error' | 'failedFiles'>,
): PlanCause => {
  const { topIsPlan, planFiles, otherFiles } = planBreakdownOf(status);
  if (planFiles + otherFiles === 0) return topIsPlan ? 'all' : 'none';
  if (otherFiles === 0) return 'all';
  return planFiles > 0 || topIsPlan ? 'mixed' : 'none';
};

/**
 * プラン起因の失敗が「どこに」あるかの内訳。text の案内は、伝えさせる message の
 * 場所 (上位の error.message か、failedFiles[].message か) を取り違えないよう
 * これを見る。
 */
export type PlanBreakdown = {
  /** 上位の error.code が PLAN 系か (理由は error.message に入る)。 */
  readonly topIsPlan: boolean;
  /** code が PLAN 系の失敗ファイルの数 (理由は各 message に入る)。 */
  readonly planFiles: number;
  /** code が PLAN 系でない失敗ファイルの数。 */
  readonly otherFiles: number;
};

export const planBreakdownOf = (
  status: Pick<GenerationStatusResult, 'error' | 'failedFiles'>,
): PlanBreakdown => {
  const files = failedFilesOf(status);
  const planFiles = files.filter((f) => isPlanCode(f.code)).length;
  return {
    topIsPlan: isPlanCode(status.error?.code),
    planFiles,
    otherFiles: files.length - planFiles,
  };
};

/**
 * 再確認までの秒数。`Retry-After` ヘッダが無いと上流の本文の値が型の検査なしで
 * 残る (client.ts の getGenerationStatus) ので、有限の非負数のときだけ返す。
 * 文字列を mrkdwn / text に埋め込まない (リンクやメンションの注入を防ぐ)。
 */
export const retryAfterSecondsOf = (
  status: Pick<GenerationStatusResult, 'retryAfterSeconds'>,
): number | undefined => {
  const value: unknown = status.retryAfterSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
};
