// Wraps MCP tool handlers with fire-and-forget telemetry.
//
// Emits `integration.mcp.invoked` with { tool, durationMs, success, errorClass? }
// after every tool call (success or failure). Never mutates the handler return
// value, so existing callers see identical behavior.
//
// workspace の帰属規則は `telemetry/workspace.ts` 冒頭のコメントを参照。

import type { TelemetryClient } from './client.js';
import {
  resolveInvocationWorkspaceId,
  runWithInvocationWorkspace,
  type InvocationWorkspace,
} from './workspace.js';

type ToolHandler<I, R> = (input: I) => Promise<R>;

type ToolResultLike = {
  isError?: boolean;
  [key: string]: unknown;
};

/**
 * 帰属先の解決関数。テストから差し替えられるよう注入可能にする。
 *
 * 同期関数であることが重要 — telemetry の解決でツール応答を待たせない
 * (keychain / ファイル I/O はここでは行わない)。
 */
export type WorkspaceIdResolver = (
  invocation: InvocationWorkspace,
) => string | undefined;

const inferErrorClass = (
  result: unknown,
  error: unknown,
): string | undefined => {
  if (error instanceof Error) return error.name || 'Error';
  if (typeof error === 'string') return 'Error';
  const r = result as ToolResultLike | undefined;
  if (r?.isError) return 'ToolError';
  return undefined;
};

export const withTelemetry = <I, R extends ToolResultLike>(
  client: TelemetryClient,
  toolName: string,
  handler: ToolHandler<I, R>,
  resolveWorkspace: WorkspaceIdResolver = resolveInvocationWorkspaceId,
): ToolHandler<I, R> => {
  return async (input: I): Promise<R> => {
    const startedAt = Date.now();

    // この呼び出しが認証に使った資格情報を受け取るスロット。ハンドラ内の auth 層
    // (`recordCredentialWorkspace`) が書き込む。
    const invocation: InvocationWorkspace = {};

    // 例外は握って undefined に落とす — telemetry の失敗でツールを壊さない。
    const resolveSafely = (): string | undefined => {
      try {
        return resolveWorkspace(invocation);
      } catch {
        return undefined;
      }
    };

    try {
      const result = await runWithInvocationWorkspace(invocation, () =>
        handler(input),
      );
      client.track({
        event: 'integration.mcp.invoked',
        // 成功した呼び出しにのみ workspace を付ける (PRJ-3-1117)。
        // HTTP モードの workspace_id は**署名検証していない** Bearer JWT の claim
        // で、`handleMcp` は Bearer の存在しか見ない。失敗イベントにも載せると、
        // 未認証の第三者が任意のワークスペース宛に `integration.mcp.invoked` を
        // 注入でき、本番指標を汚染できてしまう。成功 = 上流 API がその Bearer を
        // 受理した、なので成功だけ帰属すればこの経路は閉じる。
        // 月次コホート分類は success=true の行だけを見るため影響しない
        // (developer-docs `internal-docs/mcp-cohort-monthly.md` §3.1 / §6.3)。
        workspaceId: result.isError ? undefined : resolveSafely(),
        // Stamp client-side ingest time so events from clock-skewed clients
        // remain orderable in Analytics Engine (matches schema §6).
        timestamp: Date.now(),
        properties: {
          tool: toolName,
          durationMs: Date.now() - startedAt,
          success: !result.isError,
          ...(result.isError
            ? { errorClass: inferErrorClass(result, undefined) ?? 'ToolError' }
            : {}),
        },
      });
      return result;
    } catch (err) {
      client.track({
        event: 'integration.mcp.invoked',
        // throw = 失敗。上と同じ理由で workspace は付けない。
        timestamp: Date.now(),
        properties: {
          tool: toolName,
          durationMs: Date.now() - startedAt,
          success: false,
          errorClass: inferErrorClass(undefined, err) ?? 'Error',
        },
      });
      throw err;
    }
  };
};
