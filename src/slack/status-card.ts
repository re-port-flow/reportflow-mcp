/**
 * Slackbot MCP Client 向けの状態カード (PRJ-3-2563 / Slack A3)。
 *
 * Slack は tool の結果の `_meta.slack.blocks` (Block Kit) を描画し、
 * `action_id: "tool:<tool名>"` のボタンを押すと `value` (JSON 文字列) を引数にして
 * その tool を呼ぶ (docs.slack.dev/ai/slackbot-mcp-client/returning-rich-responses)。
 *
 * ここは**純関数だけ**を置く。どのクライアントに出すか (opt-in) は server.ts が
 * 決め、text の応答 (`content`) は従来どおり生成側が作る。blocks は text の上に
 * 足すだけで、blocks を描画しないクライアントでも text だけで次の操作が分かる。
 *
 * 守ること:
 * - ボタンの `value` は**状態照会の引数 (requestId) だけ**。token・入力値・共有先を
 *   載せない。2000 文字を超える値は作らない (Slack の上限)。
 * - 副作用のある操作 (生成のやり直し等) のボタンは置かない。状態照会は読み取り
 *   専用で、連打しても新規生成は起きない。
 * - リンクは Re:port Flow の Web アプリ (ログイン必須の出力履歴) だけ。https かつ
 *   許可したホストでなければリンクを付けない。公開 URL・Base64 は埋め込まない。
 * - 生成が終わる前に「生成済み」と書かない。
 */
import type { ExportResponse, GenerationStatusResult } from '../client.js';
import {
  failedFilesOf,
  planCauseOf,
  retryAfterSecondsOf,
} from '../generation-plan.js';

/** Slack が `value` に許す最大長 (文字)。 */
export const SLACK_BUTTON_VALUE_MAX = 2000;

/** 状態照会ボタンが呼ぶ tool。 */
export const STATUS_TOOL_NAME = 'get_generation_status';

/** requestId の形 (content-service の `Request-Id`。16 文字の英数字)。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9]{16}$/;

export type SlackBlock = Record<string, unknown>;

export type SlackMeta = { slack: { blocks: SlackBlock[] } };

export const isValidRequestId = (value: unknown): value is string =>
  typeof value === 'string' && REQUEST_ID_PATTERN.test(value);

/**
 * `tool:` ボタンの value。上限を超える・作れない場合は null (ボタンを出さない)。
 */
export const toolButtonValue = (
  args: Record<string, string>,
): string | null => {
  const value = JSON.stringify(args);
  return value.length <= SLACK_BUTTON_VALUE_MAX ? value : null;
};

/**
 * 出力履歴リンクとして出してよい URL か。https で、ホストが許可リストに
 * 完全一致するものだけ。読めない URL は出さない側に倒す。
 */
export const isAllowedLinkUrl = (
  url: unknown,
  allowedHosts: readonly string[],
): url is string => {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      allowedHosts.includes(parsed.hostname)
    );
  } catch {
    return false;
  }
};

/** mrkdwn の制御文字 (`&` `<` `>`) を逃がす。上流由来の文字列はすべて通す。 */
// 上流の値は実行時に検査されていない (client.ts は型を当てるだけ)。文字列でない値
// (null / 欠落) でも落ちないように受ける。
const escapeMrkdwn = (text: unknown): string =>
  (typeof text === 'string' ? text : '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** 上流由来の文字列 1 つあたりの上限 (文字)。1 件の長い理由でカード全体を埋めない。 */
const UPSTREAM_TEXT_MAX = 300;
/** 上流由来の値を、切ってからエスケープする (エスケープ列の途中で切らない)。 */
const upstreamText = (value: unknown): string => {
  const text = typeof value === 'string' ? value : '';
  return escapeMrkdwn(
    text.length <= UPSTREAM_TEXT_MAX
      ? text
      : `${text.slice(0, UPSTREAM_TEXT_MAX - 1)}…`,
  );
};

/** Block Kit の section の text 上限 (3000 文字) を超えないよう切る。 */
const SECTION_TEXT_MAX = 3000;
const clip = (text: string): string =>
  text.length <= SECTION_TEXT_MAX
    ? text
    : `${text.slice(0, SECTION_TEXT_MAX - 1)}…`;

const section = (text: string): SlackBlock => ({
  type: 'section',
  // verbatim: true で Slack の自動変換 (素の URL のリンク化・@channel 等の
  // メンション化・チャンネル名のリンク化) を止める。上流・利用者由来の文字列
  // (ファイル名・失敗理由) から、許可していないリンクやメンションを作らせない。
  text: { type: 'mrkdwn', text: clip(text), verbatim: true },
});

const statusButton = (requestId: string, label: string): SlackBlock | null => {
  const value = toolButtonValue({ requestId });
  return value === null
    ? null
    : {
        type: 'button',
        text: { type: 'plain_text', text: label },
        action_id: `tool:${STATUS_TOOL_NAME}`,
        value,
      };
};

const historyButton = (url: string): SlackBlock => ({
  type: 'button',
  text: { type: 'plain_text', text: '出力履歴を開く（ログインが必要）' },
  url,
});

const actions = (elements: Array<SlackBlock | null>): SlackBlock[] => {
  const present = elements.filter((e): e is SlackBlock => e !== null);
  return present.length === 0 ? [] : [{ type: 'actions', elements: present }];
};

const PLAN_GUIDANCE =
  'プランの上限や設定による失敗です。入力を直して再生成しても解消しません。';
const OTHER_FAILURES_GUIDANCE =
  'プラン以外の理由で失敗したファイルは、内容を確認し、必要なら入力を直してから生成をやり直してください。';
/** 失敗ファイルを最大 5 件、理由つきで並べる (残りは件数だけ)。 */
const FAILED_FILES_SHOWN = 5;
const failedFileLines = (
  files: NonNullable<GenerationStatusResult['failedFiles']>,
): string[] => [
  ...files
    .slice(0, FAILED_FILES_SHOWN)
    .map(
      (f) =>
        `• ${upstreamText(f.fileName)}: ${upstreamText(f.code)} ${upstreamText(f.message)}`,
    ),
  ...(files.length > FAILED_FILES_SHOWN
    ? [`ほか ${files.length - FAILED_FILES_SHOWN} 件`]
    : []),
];

export type CardOptions = {
  /** 出力履歴リンクに許すホスト (Re:port Flow の Web アプリ)。 */
  allowedLinkHosts: readonly string[];
};

/**
 * 生成受付 (generate_pdfs_async の成功) のカード。
 * requestId が不正なら null (カードを出さず text だけにする)。
 */
export const buildAcceptedCard = (
  result: ExportResponse,
  opts: CardOptions,
): SlackMeta | null => {
  if (!isValidRequestId(result.requestId)) return null;
  const fileCount = result.files?.length ?? 0;
  const link = isAllowedLinkUrl(result.url, opts.allowedLinkHosts)
    ? historyButton(result.url)
    : null;
  return {
    slack: {
      blocks: [
        section(
          `*PDF の生成を受け付けました*（まだ生成中です）\nrequestId: \`${result.requestId}\`${
            fileCount > 0 ? `\n対象: ${fileCount} 件` : ''
          }`,
        ),
        ...actions([statusButton(result.requestId, '生成状況を確認'), link]),
      ],
    },
  };
};

/**
 * 状態照会 (get_generation_status の成功) のカード。
 * requestId が不正なら null。
 */
export const buildStatusCard = (
  status: GenerationStatusResult,
): SlackMeta | null => {
  if (!isValidRequestId(status.requestId)) return null;
  const id = `requestId: \`${status.requestId}\``;
  const failedFiles = failedFilesOf(status);
  const failedCount = failedFiles.length;
  // プラン起因かどうかは text の応答と同じ判定 (generation-plan.ts)。
  // 混在 (プラン起因 + 入力の誤り等) なら両方の案内を出す。
  const planCause = planCauseOf(status);
  const retryAfter = retryAfterSecondsOf(status);

  switch (status.status) {
    case 'queued':
    case 'processing':
      return {
        slack: {
          blocks: [
            section(
              `*生成中です*\n${id}${
                retryAfter !== undefined
                  ? `\n${retryAfter} 秒ほどおいてから確認してください。`
                  : ''
              }`,
            ),
            ...actions([statusButton(status.requestId, 'もう一度確認')]),
          ],
        },
      };
    case 'completed': {
      // 上流の値は実行時に検査されていないので、配列でなければ 0 件として扱う。
      const files: unknown[] = Array.isArray(status.files) ? status.files : [];
      const okCount = files.length;
      const lines = [
        failedCount > 0
          ? `*一部の生成に失敗しました*（成功 ${okCount} 件 / 失敗 ${failedCount} 件）`
          : `*生成が完了しました*（${okCount} 件）`,
        id,
        '受付時のリンク（出力履歴。ログインが必要）から確認・ダウンロードできます。',
      ];
      lines.push(...failedFileLines(failedFiles));
      // 失敗ファイルが無ければ (上位に error が付いていても) 案内は出さない。text の
      // partialPlanAction も failedCount > 0 のときだけ付く。
      const guidance =
        failedCount === 0
          ? []
          : planCause === 'all'
            ? [PLAN_GUIDANCE]
            : planCause === 'mixed'
              ? [PLAN_GUIDANCE, OTHER_FAILURES_GUIDANCE]
              : [];
      return {
        slack: {
          blocks: [
            section(lines.join('\n')),
            // 案内は上流由来の文字列と別の section に置く (長い理由で押し出されない)
            ...(guidance.length > 0 ? [section(guidance.join('\n'))] : []),
          ],
        },
      };
    }
    case 'failed': {
      const lines = [
        '*生成に失敗しました*',
        id,
        ...(status.error
          ? [
              `${upstreamText(status.error.code)}: ${upstreamText(status.error.message)}`,
            ]
          : []),
        ...failedFileLines(failedFiles),
      ];
      const guidance =
        planCause === 'all'
          ? [PLAN_GUIDANCE]
          : planCause === 'mixed'
            ? [PLAN_GUIDANCE, OTHER_FAILURES_GUIDANCE]
            : [
                '内容を確認し、必要なら入力を直してから生成をやり直してください。',
              ];
      return {
        slack: {
          blocks: [
            section(lines.join('\n')),
            // 案内は上流由来の文字列と別の section に置く (長い理由で押し出されない)
            section(guidance.join('\n')),
          ],
        },
      };
    }
    default:
      // 契約外の status は推測で描かない (text の応答だけにする)。
      return null;
  }
};

/**
 * カードは text の応答に付け足すだけのもの。組み立てに失敗しても (上流の値が
 * 契約外など) ツールの応答をエラーにせず、カード無し (text だけ) にする。
 */
export const safeCard = (build: () => SlackMeta | null): SlackMeta | null => {
  try {
    return build();
  } catch (err) {
    console.error(
      `[reportflow-mcp] slack card build failed: ${err instanceof Error ? err.name : 'unknown'}`,
    );
    return null;
  }
};
