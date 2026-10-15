/**
 * A2A v1.0 JSON-RPC binding (仕様 §9) の処理本体。
 *
 * HTTP にも MCP SDK にも依存しない純粋な層にしてある。skill の実行は
 * `deps.callTool` として注入され、本番では http-server.ts が同一プロセスの
 * MCP ハンドラへ `tools/call` を流す (認可・権限・テレメトリを MCP と共有する)。
 *
 * **このサーバーはタスクを保存しない (stateless)。** SendMessage は skill を
 * 実行し終えてから終端状態 (COMPLETED / FAILED) の Task を返すので、後から
 * GetTask / CancelTask で参照できるタスクは存在しない。コンテナは stateless な
 * MCP transport 前提でインスタンス間を行き来する (cloudflare/index.ts) ため、
 * タスクをメモリに持っても別インスタンスからは見えない。
 */
import { A2A_PROTOCOL_VERSION } from './agent-card.js';
import { A2A_SKILLS, A2A_SKILL_IDS } from './skills.js';

// ─── A2A / JSON-RPC エラーコード (仕様 §5.4 / §9.5) ──────────────────────────
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
export const A2A_TASK_NOT_FOUND = -32001;
export const A2A_PUSH_NOTIFICATION_NOT_SUPPORTED = -32003;
export const A2A_UNSUPPORTED_OPERATION = -32004;
export const A2A_EXTENDED_CARD_NOT_CONFIGURED = -32007;
export const A2A_VERSION_NOT_SUPPORTED = -32009;

/** MCP の CallToolResult のうち、A2A へ写すのに使う部分。 */
export type McpToolResult = {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
};

export type ToolCallOutcome =
  | { kind: 'result'; result: McpToolResult }
  /** MCP 側が JSON-RPC エラーを返した (引数検証エラー等)。 */
  | { kind: 'error'; code: number; message: string }
  /** MCP 側が 401 を返した (トークン無効)。 */
  | { kind: 'unauthorized' };

export type A2aDeps = {
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolCallOutcome>;
  newId: () => string;
  now: () => Date;
};

export type A2aRequestContext = {
  /** `A2A-Version` ヘッダーの値 (無ければ undefined)。 */
  versionHeader: string | undefined;
  /** Authorization: Bearer が付いているか。 */
  hasBearer: boolean;
};

/** HTTP 層へ返す結果。`unauthorized` のときは 401 + WWW-Authenticate にする。 */
export type A2aHttpResult =
  | { kind: 'json'; body: Record<string, unknown> }
  | { kind: 'unauthorized'; description: string };

type JsonRpcId = string | number | null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const errorInfo = (reason: string): Record<string, unknown> => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason,
  domain: 'a2a-protocol.org',
});

const errorResponse = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown[],
): A2aHttpResult => ({
  kind: 'json',
  body: {
    jsonrpc: '2.0',
    id,
    error: data ? { code, message, data } : { code, message },
  },
});

const invalidParams = (
  id: JsonRpcId,
  field: string,
  description: string,
): A2aHttpResult =>
  errorResponse(id, JSONRPC_INVALID_PARAMS, 'Invalid parameters', [
    {
      '@type': 'type.googleapis.com/google.rpc.BadRequest',
      fieldViolations: [{ field, description }],
    },
  ]);

const successResponse = (
  id: JsonRpcId,
  result: Record<string, unknown>,
): A2aHttpResult => ({ kind: 'json', body: { jsonrpc: '2.0', id, result } });

/**
 * `A2A-Version` を判定する (仕様 §3.2.6 / §14.2.1)。
 *
 * 値は `Major.Minor`。**1.x だけを受け付ける。** ヘッダーが無い場合は仕様上
 * 0.3 とみなすことになっているが、0.3 のメソッド名 (`message/send` 等) は
 * このエンドポイントでは MethodNotFound になるので、ここでは拒否せず通し、
 * メソッド名で 1.0 の意味で解釈する (ヘッダーを付けない 1.0 クライアントを
 * 門前払いしないため)。
 */
const isSupportedVersion = (header: string | undefined): boolean => {
  if (header === undefined || header.trim() === '') return true;
  const [major] = header.trim().split('.');
  return major === A2A_PROTOCOL_VERSION.split('.')[0];
};

/** SendMessage の data part から skill 呼び出しを取り出す。 */
type SkillInvocation =
  | { kind: 'none' }
  | { kind: 'invalid'; field: string; description: string }
  | { kind: 'call'; skill: string; args: Record<string, unknown> };

const findSkillInvocation = (parts: unknown[]): SkillInvocation => {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!isRecord(part) || !isRecord(part['data'])) continue;
    const data = part['data'];
    if (!('skill' in data)) continue;
    const skill = data['skill'];
    if (typeof skill !== 'string' || !A2A_SKILL_IDS.has(skill)) {
      return {
        kind: 'invalid',
        field: `message.parts[${i}].data.skill`,
        description: `Unknown skill. Supported skills: ${[...A2A_SKILL_IDS].join(', ')}`,
      };
    }
    const args = data['arguments'] ?? {};
    if (!isRecord(args)) {
      return {
        kind: 'invalid',
        field: `message.parts[${i}].data.arguments`,
        description: 'arguments must be a JSON object',
      };
    }
    return { kind: 'call', skill, args };
  }
  return { kind: 'none' };
};

/** skill を指定しなかったメッセージへの案内文 (Message で返す)。 */
const usageText = (): string =>
  [
    'This agent runs skills from structured requests.',
    'Send a message with a data part: {"skill": "<skill id>", "arguments": {...}}.',
    'Arguments follow the input schema of the Re:port Flow MCP tool with the same name.',
    `Skills: ${A2A_SKILLS.map((s) => s.id).join(', ')}.`,
    'Start with list_templates (or search_gallery_templates), then get_design_parameters, then generate_pdf_sync.',
  ].join(' ');

/** MCP の content 要素を A2A の Part へ写す。写せない型は捨てる。 */
const toPart = (item: unknown): Record<string, unknown> | null => {
  if (!isRecord(item)) return null;
  switch (item['type']) {
    case 'text':
      return typeof item['text'] === 'string'
        ? { text: item['text'], mediaType: 'text/plain' }
        : null;
    case 'resource_link':
      return typeof item['uri'] === 'string'
        ? {
            url: item['uri'],
            ...(typeof item['mimeType'] === 'string'
              ? { mediaType: item['mimeType'] }
              : {}),
            ...(typeof item['name'] === 'string'
              ? { filename: item['name'] }
              : {}),
          }
        : null;
    case 'resource': {
      const resource = item['resource'];
      if (!isRecord(resource)) return null;
      const mediaType =
        typeof resource['mimeType'] === 'string'
          ? { mediaType: resource['mimeType'] }
          : {};
      if (typeof resource['text'] === 'string') {
        return { text: resource['text'], ...mediaType };
      }
      if (typeof resource['blob'] === 'string') {
        return { raw: resource['blob'], ...mediaType };
      }
      return typeof resource['uri'] === 'string'
        ? { url: resource['uri'], ...mediaType }
        : null;
    }
    case 'image':
    case 'audio':
      return typeof item['data'] === 'string'
        ? {
            raw: item['data'],
            ...(typeof item['mimeType'] === 'string'
              ? { mediaType: item['mimeType'] }
              : {}),
          }
        : null;
    default:
      return null;
  }
};

const toParts = (result: McpToolResult): Record<string, unknown>[] => {
  const parts = (result.content ?? [])
    .map(toPart)
    .filter((p): p is Record<string, unknown> => p !== null);
  if (isRecord(result.structuredContent)) {
    parts.push({
      data: result.structuredContent,
      mediaType: 'application/json',
    });
  }
  return parts;
};

const handleSendMessage = async (
  id: JsonRpcId,
  params: unknown,
  ctx: A2aRequestContext,
  deps: A2aDeps,
): Promise<A2aHttpResult> => {
  if (!isRecord(params) || !isRecord(params['message'])) {
    return invalidParams(id, 'message', 'message is required');
  }
  const message = params['message'];
  if (typeof message['messageId'] !== 'string' || message['messageId'] === '') {
    return invalidParams(id, 'message.messageId', 'messageId is required');
  }
  if (message['role'] !== 'ROLE_USER') {
    return invalidParams(id, 'message.role', 'role must be ROLE_USER');
  }
  const parts = message['parts'];
  if (!Array.isArray(parts) || parts.length === 0) {
    return invalidParams(id, 'message.parts', 'At least one part is required');
  }
  if (typeof message['taskId'] === 'string' && message['taskId'] !== '') {
    // 保存しているタスクは無い (ファイル冒頭)。既存タスクへの継続は受けられない。
    return errorResponse(id, A2A_TASK_NOT_FOUND, 'Task not found', [
      errorInfo('TASK_NOT_FOUND'),
    ]);
  }

  const contextId =
    typeof message['contextId'] === 'string' && message['contextId'] !== ''
      ? message['contextId']
      : deps.newId();

  const invocation = findSkillInvocation(parts);
  if (invocation.kind === 'invalid') {
    return invalidParams(id, invocation.field, invocation.description);
  }
  if (invocation.kind === 'none') {
    return successResponse(id, {
      message: {
        messageId: deps.newId(),
        contextId,
        role: 'ROLE_AGENT',
        parts: [{ text: usageText(), mediaType: 'text/plain' }],
      },
    });
  }

  // skill の実行は MCP の tools/call と同じく Bearer 必須 (http-server.ts の
  // PROTECTED_METHODS)。トークンを持たない呼び出しは 401 で OAuth へ誘導する。
  if (!ctx.hasBearer) {
    return {
      kind: 'unauthorized',
      description: 'Running a skill requires a Bearer token',
    };
  }

  const outcome = await deps.callTool(invocation.skill, invocation.args);
  if (outcome.kind === 'unauthorized') {
    return {
      kind: 'unauthorized',
      description: 'The Bearer token was rejected',
    };
  }
  if (outcome.kind === 'error') {
    // 引数検証エラーだけは呼び出し側で直せるので内容を返す。それ以外は
    // 内部事情を出さない (MCP 側の 500 と同じ扱い)。
    return outcome.code === JSONRPC_INVALID_PARAMS
      ? invalidParams(id, 'message.parts.data.arguments', outcome.message)
      : errorResponse(id, JSONRPC_INTERNAL_ERROR, 'Internal error');
  }

  const taskId = deps.newId();
  const resultParts = toParts(outcome.result);
  const timestamp = deps.now().toISOString();
  const failed = outcome.result.isError === true;

  const task: Record<string, unknown> = {
    id: taskId,
    contextId,
    status: failed
      ? {
          state: 'TASK_STATE_FAILED',
          timestamp,
          message: {
            messageId: deps.newId(),
            contextId,
            taskId,
            role: 'ROLE_AGENT',
            parts:
              resultParts.length > 0
                ? resultParts
                : [{ text: 'The skill failed.', mediaType: 'text/plain' }],
          },
        }
      : { state: 'TASK_STATE_COMPLETED', timestamp },
    metadata: { skill: invocation.skill },
  };
  if (!failed && resultParts.length > 0) {
    task['artifacts'] = [
      { artifactId: deps.newId(), name: invocation.skill, parts: resultParts },
    ];
  }
  return successResponse(id, { task });
};

/**
 * A2A JSON-RPC リクエスト 1 件を処理する。
 *
 * バッチ (配列) は A2A の JSON-RPC binding に定義が無いので InvalidRequest。
 */
export const handleA2aJsonRpc = async (
  body: unknown,
  ctx: A2aRequestContext,
  deps: A2aDeps,
): Promise<A2aHttpResult> => {
  if (!isRecord(body)) {
    return errorResponse(
      null,
      JSONRPC_INVALID_REQUEST,
      'Request payload validation error',
    );
  }
  const rawId = body['id'];
  // id は文字列か数値に限る。欠落 (= JSON-RPC の通知) や null・真偽値・
  // オブジェクトを null に丸めて処理を続けると、応答を受け取れない呼び出しで
  // PDF 生成やテンプレート複製のような冪等でない skill が走ってしまう。
  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    return errorResponse(
      null,
      JSONRPC_INVALID_REQUEST,
      'Request payload validation error',
    );
  }
  const id: JsonRpcId = rawId;
  if (body['jsonrpc'] !== '2.0' || typeof body['method'] !== 'string') {
    return errorResponse(
      id,
      JSONRPC_INVALID_REQUEST,
      'Request payload validation error',
    );
  }
  if (!isSupportedVersion(ctx.versionHeader)) {
    return errorResponse(
      id,
      A2A_VERSION_NOT_SUPPORTED,
      `A2A version ${ctx.versionHeader ?? ''} is not supported; this agent implements ${A2A_PROTOCOL_VERSION}`,
      [errorInfo('VERSION_NOT_SUPPORTED')],
    );
  }

  const method = body['method'];
  switch (method) {
    case 'SendMessage':
      return handleSendMessage(id, body['params'], ctx, deps);
    case 'GetTask':
    case 'CancelTask':
    case 'SubscribeToTask':
      return errorResponse(id, A2A_TASK_NOT_FOUND, 'Task not found', [
        errorInfo('TASK_NOT_FOUND'),
      ]);
    case 'SendStreamingMessage':
    case 'ListTasks':
      return errorResponse(
        id,
        A2A_UNSUPPORTED_OPERATION,
        `${method} is not supported by this agent`,
        [errorInfo('UNSUPPORTED_OPERATION')],
      );
    case 'CreateTaskPushNotificationConfig':
    case 'GetTaskPushNotificationConfig':
    case 'ListTaskPushNotificationConfigs':
    case 'DeleteTaskPushNotificationConfig':
      return errorResponse(
        id,
        A2A_PUSH_NOTIFICATION_NOT_SUPPORTED,
        'Push notifications are not supported',
        [errorInfo('PUSH_NOTIFICATION_NOT_SUPPORTED')],
      );
    case 'GetExtendedAgentCard':
      return errorResponse(
        id,
        A2A_EXTENDED_CARD_NOT_CONFIGURED,
        'Extended agent card is not configured',
        [errorInfo('EXTENDED_AGENT_CARD_NOT_CONFIGURED')],
      );
    default:
      return errorResponse(id, JSONRPC_METHOD_NOT_FOUND, 'Method not found');
  }
};
