// `tools/call` の実行前ガード (PRJ-3-1584 / ST-3)。
//
// ## なぜ一覧のフィルタだけでは足りないか
// `tools/list` から消えたツールでも、クライアントは名前を直接指定して
// `tools/call` を送れる (MCP はそれを禁じていない)。一覧の非表示は UX であって
// 認可境界ではない。ここが**上流 API へ 1 バイトも送る前**に止める層になる。
//
// 上流 API 側 (reposts-api / content-service) にも同じロール条件があり
// (PRJ-3-1586 / ST-2)、MCP を経由しない直接呼び出しも塞がれている。この 2 層は
// どちらか一方の代わりにはならない: MCP 側だけだと API を直接叩けば通り、
// API 側だけだと「見えているのに必ず失敗するツール」が一覧に残る。
//
// ## 拒否の文言は原因ごとに変える
// 「権限不足」と「上流が落ちていて権限を確認できない」を同じ文言にすると、
// 障害のあいだユーザーは権限設定を疑い続ける。`RoleResolution.status` で分ける。

import type { TelemetryClient } from './telemetry/index.js';
import {
  requiredCapabilityForTool,
  type WorkspaceCapability,
  type WorkspaceRole,
} from './workspace-permission.js';
import {
  resolveWorkspaceAuthorization,
  type RoleResolution,
  type WorkspaceAuthorization,
} from './workspace-role.js';

/** 拒否イベント名 (`integration.mcp.invoked` とは別に、拒否だけを数えられるように)。 */
export const TOOL_DENIED_EVENT = 'integration.mcp.tool_denied';

/** ツール応答の最小形 (各ツールの戻り値はこれを満たす)。 */
export type GuardedToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type ToolDenial = {
  toolName: string;
  requiredCapability: WorkspaceCapability;
  resolution: RoleResolution;
};

/** capability を利用者向けの言葉にする (最小ロールも添える)。 */
const CAPABILITY_LABEL: Readonly<Record<WorkspaceCapability, string>> = {
  public: '認証不要',
  'workspace.read': 'ワークスペースの参照権限 (閲覧者 (READ) 以上)',
  'workspace.generate': 'PDF の出力権限 (閲覧者 (READ) 以上)',
  'workspace.write': 'テンプレートの作成権限 (編集者 (WRITE) 以上)',
};

/**
 * ロールの表示名 (情報設計 用語統一 2026-09: 管理者 / 編集者 / 閲覧者)。
 * 権限の値 (ADMIN / WRITE / READ) は変えず、括弧で併記する。
 * UNREAD / UNKNOWN は表示名が決まっていないので値のまま出す。
 */
const ROLE_LABEL: Readonly<Partial<Record<WorkspaceRole, string>>> = {
  ADMIN: '管理者 (ADMIN)',
  WRITE: '編集者 (WRITE)',
  READ: '閲覧者 (READ)',
};

const roleLabel = (role: WorkspaceRole): string => ROLE_LABEL[role] ?? role;

/**
 * 拒否の文言。
 *
 * `resolved` のときは自分のロールを伝える —— 呼び出し元はそのトークンの持ち主
 * 本人なので、自分の権限を知ることに情報漏洩は無く、「管理者に WRITE を依頼する」
 * という次の一手に直結する。逆に `forbidden` (一覧に無い) では所属の有無・
 * ワークスペースの存在を推測させない一般的な文言に留める。
 */
export const denialMessage = (
  denial: ToolDenial,
  mode: 'stdio' | 'http',
): string => {
  const need = `必要な権限: ${CAPABILITY_LABEL[denial.requiredCapability]}`;
  const reauth =
    mode === 'http'
      ? 'クライアント側で OAuth トークンを再取得してください (claude.ai / n8n / Make 等の OAuth 設定を確認)'
      : 'authenticate ツールを呼び出してください';

  switch (denial.resolution.status) {
    case 'resolved':
      return `ツール "${denial.toolName}" は現在のワークスペース権限では実行できません。${need}／現在のロール: ${roleLabel(denial.resolution.role)}。ワークスペース管理者に権限の変更を依頼してください。`;
    case 'unauthenticated':
      return `ツール "${denial.toolName}" の実行には認証が必要です。${reauth}。`;
    case 'forbidden':
      return `ツール "${denial.toolName}" を実行する権限を確認できませんでした。認可したワークスペースのメンバーであること、承認済みであることを確認してください。${need}。`;
    case 'unavailable':
      return `ツール "${denial.toolName}" は実行できませんでした: ワークスペース権限の確認に失敗しました (権限不足ではなく、権限情報の取得に失敗しています)。時間をおいて再試行してください。`;
  }
};

export const denialResult = (
  denial: ToolDenial,
  mode: 'stdio' | 'http',
): GuardedToolResult => ({
  content: [{ type: 'text', text: `エラー: ${denialMessage(denial, mode)}` }],
  isError: true,
});

/**
 * 拒否をテレメトリへ送る。
 *
 * **トークンも個人情報も載せない** (ST-3 Should)。載せるのは tool / 必要 capability /
 * 解決結果の status と reason / 解決できたロール。
 *
 * `workspaceId` を付けるのは `resolved` のときだけ。HTTP モードの workspace_id は
 * **署名検証していない** Bearer JWT の claim で、`resolved` は「上流がその Bearer を
 * 受理した」ことを意味する。未認証の第三者が任意のワークスペース宛にイベントを
 * 注入できないようにするための線引き (`telemetry/interceptor.ts` と同じ考え方)。
 */
export const trackToolDenied = (
  telemetry: TelemetryClient,
  denial: ToolDenial,
): void => {
  const { resolution } = denial;
  telemetry.track({
    event: TOOL_DENIED_EVENT,
    ...(resolution.status === 'resolved'
      ? { workspaceId: resolution.workspaceId }
      : {}),
    timestamp: Date.now(),
    properties: {
      tool: denial.toolName,
      requiredCapability: denial.requiredCapability,
      resolutionStatus: resolution.status,
      resolvedRole: resolution.status === 'resolved' ? resolution.role : 'NONE',
      reason:
        resolution.status === 'resolved'
          ? 'capability-denied'
          : resolution.reason,
    },
  });
};

export type WorkspaceAuthorizationResolver =
  () => Promise<WorkspaceAuthorization>;

export type GuardToolOptions = {
  mode: 'stdio' | 'http';
  telemetry: TelemetryClient;
  /** 解決後に呼ばれるフック (stdio の一覧貼り替え用)。例外は握り潰す。 */
  onAuthorized?: (authorization: WorkspaceAuthorization) => void;
  /** テストからの差し替え口。 */
  resolve?: WorkspaceAuthorizationResolver;
};

/**
 * ツールハンドラを capability ガードで包む。
 *
 * 許可されない場合、**ハンドラを一度も呼ばない**ので上流 fetch は起きない。
 * `withTelemetry` の**内側**に置く前提: 拒否も `integration.mcp.invoked` の
 * 1 呼び出しとして残る (「呼ばれたが拒否した」が消えないように)。
 */
export const guardToolHandler = <I, R extends GuardedToolResult>(
  toolName: string,
  handler: (input: I) => Promise<R>,
  options: GuardToolOptions,
): ((input: I) => Promise<R>) => {
  const requiredCapability = requiredCapabilityForTool(toolName);
  const resolve =
    options.resolve ?? (() => resolveWorkspaceAuthorization(options.mode));

  return async (input: I): Promise<R> => {
    const authorization = await resolve();
    if (options.onAuthorized) {
      try {
        options.onAuthorized(authorization);
      } catch {
        // 一覧の貼り替えに失敗してもツール実行は続ける (認可はこの後の判定が担う)。
      }
    }

    if (!authorization.capabilities.has(requiredCapability)) {
      const denial: ToolDenial = {
        toolName,
        requiredCapability,
        resolution: authorization.resolution,
      };
      trackToolDenied(options.telemetry, denial);
      return denialResult(denial, options.mode) as R;
    }

    return handler(input);
  };
};
