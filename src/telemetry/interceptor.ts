// Wraps MCP tool handlers with fire-and-forget telemetry.
//
// Emits `integration.mcp.invoked` with { tool, durationMs, success, errorClass? }
// after every tool call (success or failure). Never mutates the handler return
// value, so existing callers see identical behavior.

import type { TelemetryClient } from './client.js';

type ToolHandler<I, R> = (input: I) => Promise<R>;

type ToolResultLike = {
  isError?: boolean;
  [key: string]: unknown;
};

// None of today's tool schemas declare `workspaceId` (the workspace is
// implicit in the OAuth token / keychain entry), so this helper currently
// returns `undefined` for every production call. Kept defensively so a
// future tool that exposes `workspaceId` to the model surfaces it
// automatically — and so the field can be re-pointed at the OAuth /
// keychain auth context once that is threaded into createMcpServer
// (Codex P2 on PR #38).
const extractWorkspaceId = (input: unknown): string | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>).workspaceId;
  return typeof value === 'string' ? value : undefined;
};

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
): ToolHandler<I, R> => {
  return async (input: I): Promise<R> => {
    const startedAt = Date.now();
    const workspaceId = extractWorkspaceId(input);

    try {
      const result = await handler(input);
      client.track({
        event: 'integration.mcp.invoked',
        workspaceId,
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
        workspaceId,
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
