/**
 * 同一プロセスの MCP ハンドラが返した `tools/call` の HTTP 応答を、A2A 層が
 * 扱う {@link ToolCallOutcome} へ解釈する。
 *
 * http-server.ts から切り出してあるのは、分岐 (SSE / 解析不能 / JSON-RPC
 * エラー / 空の result / 401) を HTTP を立てずに単体で固定するため。
 */
import type { ToolCallOutcome } from './jsonrpc.js';

const INTERNAL_ERROR = -32603;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 応答本文から JSON-RPC メッセージを取り出す。通常は application/json の
 * 単一ボディ。SSE (text/event-stream) で返った場合は最後の `data:` 行を読む。
 */
export const parseJsonRpcBody = (
  contentType: string | null,
  text: string,
): Record<string, unknown> | null => {
  const payload = (contentType ?? '').includes('text/event-stream')
    ? (text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .pop() ?? '')
    : text;
  try {
    const parsed: unknown = JSON.parse(payload);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const interpretMcpToolResponse = (
  status: number,
  contentType: string | null,
  text: string,
): ToolCallOutcome => {
  if (status === 401) return { kind: 'unauthorized' };
  const message = parseJsonRpcBody(contentType, text);
  const error = message?.['error'];
  if (isRecord(error)) {
    return {
      kind: 'error',
      code: typeof error['code'] === 'number' ? error['code'] : INTERNAL_ERROR,
      message:
        typeof error['message'] === 'string'
          ? error['message']
          : 'Tool call failed',
    };
  }
  const result = message?.['result'];
  if (!isRecord(result)) {
    return {
      kind: 'error',
      code: INTERNAL_ERROR,
      message: 'Empty MCP response',
    };
  }
  return { kind: 'result', result };
};
