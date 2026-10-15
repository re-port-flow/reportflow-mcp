import {
  A2A_EXTENDED_CARD_NOT_CONFIGURED,
  A2A_PUSH_NOTIFICATION_NOT_SUPPORTED,
  A2A_TASK_NOT_FOUND,
  A2A_UNSUPPORTED_OPERATION,
  A2A_VERSION_NOT_SUPPORTED,
  handleA2aJsonRpc,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  type A2aDeps,
  type A2aHttpResult,
  type ToolCallOutcome,
} from './jsonrpc';

const FIXED_NOW = new Date('2026-09-24T00:00:00.000Z');

const makeDeps = (
  outcome: ToolCallOutcome = {
    kind: 'result',
    result: { content: [{ type: 'text', text: 'ok' }] },
  },
): A2aDeps & { callTool: jest.Mock } => {
  let n = 0;
  return {
    callTool: jest.fn().mockResolvedValue(outcome),
    newId: () => `id-${++n}`,
    now: () => FIXED_NOW,
  };
};

const withBearer = { versionHeader: '1.0', hasBearer: true };

const sendMessage = (
  parts: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'SendMessage',
  params: {
    message: { messageId: 'm-1', role: 'ROLE_USER', parts, ...extra },
  },
});

const skillPart = (skill: string, args?: unknown): Record<string, unknown> => ({
  data: args === undefined ? { skill } : { skill, arguments: args },
  mediaType: 'application/json',
});

const bodyOf = (r: A2aHttpResult): Record<string, unknown> => {
  if (r.kind !== 'json') throw new Error(`expected json, got ${r.kind}`);
  return r.body;
};

const errorCodeOf = (r: A2aHttpResult): number | undefined =>
  (bodyOf(r)['error'] as { code?: number } | undefined)?.code;

describe('handleA2aJsonRpc: request validation', () => {
  it.each([
    ['非オブジェクト', 'hello'],
    ['配列 (バッチ)', [{ jsonrpc: '2.0', id: 1, method: 'SendMessage' }]],
    ['jsonrpc 欠落', { id: 1, method: 'SendMessage' }],
    ['method が文字列でない', { jsonrpc: '2.0', id: 1, method: 3 }],
  ])('%s は InvalidRequest (-32600)', async (_label, body) => {
    const r = await handleA2aJsonRpc(body, withBearer, makeDeps());
    expect(errorCodeOf(r)).toBe(JSONRPC_INVALID_REQUEST);
  });

  it.each([
    ['欠落 (通知)', undefined],
    ['null', null],
    ['真偽値', true],
    ['オブジェクト', { a: 1 }],
    ['配列', [1]],
  ])(
    'id が %s なら InvalidRequest で、skill は実行しない',
    async (_label, rawId) => {
      const deps = makeDeps();
      const body: Record<string, unknown> = {
        jsonrpc: '2.0',
        method: 'SendMessage',
        params: {
          message: {
            messageId: 'm',
            role: 'ROLE_USER',
            parts: [skillPart('generate_pdf_sync', {})],
          },
        },
      };
      if (rawId !== undefined) body['id'] = rawId;
      const r = await handleA2aJsonRpc(body, withBearer, deps);
      expect(errorCodeOf(r)).toBe(JSONRPC_INVALID_REQUEST);
      expect(bodyOf(r)['id']).toBeNull();
      expect(deps.callTool).not.toHaveBeenCalled();
    },
  );

  it('id はそのまま応答に写す', async () => {
    const r = await handleA2aJsonRpc(
      { jsonrpc: '2.0', id: 'abc', method: 'Nope' },
      withBearer,
      makeDeps(),
    );
    expect(bodyOf(r)['id']).toBe('abc');
    expect(errorCodeOf(r)).toBe(JSONRPC_METHOD_NOT_FOUND);
  });

  it.each(['0.3', '2.0'])(
    'A2A-Version %s は VersionNotSupported (-32009)',
    async (v) => {
      const r = await handleA2aJsonRpc(
        sendMessage([{ text: 'hi' }]),
        { versionHeader: v, hasBearer: true },
        makeDeps(),
      );
      expect(errorCodeOf(r)).toBe(A2A_VERSION_NOT_SUPPORTED);
    },
  );

  it.each([undefined, '', '1.0', '1.1', '1'])(
    'A2A-Version %p は受け付ける',
    async (v) => {
      const r = await handleA2aJsonRpc(
        sendMessage([{ text: 'hi' }]),
        { versionHeader: v, hasBearer: false },
        makeDeps(),
      );
      expect(bodyOf(r)['error']).toBeUndefined();
    },
  );
});

describe('handleA2aJsonRpc: SendMessage', () => {
  it.each([
    [
      'message 欠落',
      { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} },
    ],
    [
      'messageId 欠落',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: { message: { role: 'ROLE_USER', parts: [{ text: 'x' }] } },
      },
    ],
    [
      'role が ROLE_USER でない',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            messageId: 'm',
            role: 'ROLE_AGENT',
            parts: [{ text: 'x' }],
          },
        },
      },
    ],
    ['parts が空', sendMessage([])],
  ])('%s は InvalidParams (-32602)', async (_label, body) => {
    const r = await handleA2aJsonRpc(body, withBearer, makeDeps());
    expect(errorCodeOf(r)).toBe(JSONRPC_INVALID_PARAMS);
  });

  it('skill を指定しないメッセージには使い方を Message で返す (認証不要・ツールは呼ばない)', async () => {
    const deps = makeDeps();
    const r = await handleA2aJsonRpc(
      sendMessage([{ text: 'make me an invoice' }], { contextId: 'ctx-1' }),
      { versionHeader: '1.0', hasBearer: false },
      deps,
    );
    const result = bodyOf(r)['result'] as {
      message: { role: string; contextId: string; parts: { text: string }[] };
    };
    expect(result.message.role).toBe('ROLE_AGENT');
    expect(result.message.contextId).toBe('ctx-1');
    expect(result.message.parts[0].text).toContain('"skill"');
    expect(result.message.parts[0].text).toContain('generate_pdf_sync');
    expect(deps.callTool).not.toHaveBeenCalled();
  });

  it('未知の skill は InvalidParams で、フィールド位置を返す', async () => {
    const r = await handleA2aJsonRpc(
      sendMessage([{ text: 'x' }, skillPart('delete_everything')]),
      withBearer,
      makeDeps(),
    );
    expect(errorCodeOf(r)).toBe(JSONRPC_INVALID_PARAMS);
    const data = (bodyOf(r)['error'] as { data: unknown[] }).data;
    expect(JSON.stringify(data)).toContain('message.parts[1].data.skill');
  });

  it('arguments がオブジェクトでなければ InvalidParams', async () => {
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('list_templates', ['x'])]),
      withBearer,
      makeDeps(),
    );
    expect(errorCodeOf(r)).toBe(JSONRPC_INVALID_PARAMS);
  });

  it('Bearer 無しで skill を実行しようとすると unauthorized (ツールは呼ばない)', async () => {
    const deps = makeDeps();
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('list_templates')]),
      { versionHeader: '1.0', hasBearer: false },
      deps,
    );
    expect(r.kind).toBe('unauthorized');
    expect(deps.callTool).not.toHaveBeenCalled();
  });

  it('既存タスクへの継続 (taskId 付き) は TaskNotFound', async () => {
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('list_templates')], { taskId: 't-1' }),
      withBearer,
      makeDeps(),
    );
    expect(errorCodeOf(r)).toBe(A2A_TASK_NOT_FOUND);
  });

  it('skill 名と arguments をそのまま MCP ツールへ渡し、完了 Task + artifact を返す', async () => {
    const deps = makeDeps({
      kind: 'result',
      result: {
        content: [
          { type: 'text', text: 'Generated.' },
          {
            type: 'resource_link',
            uri: 'https://files.re-port-flow.com/x.pdf',
            name: 'invoice.pdf',
            mimeType: 'application/pdf',
          },
          { type: 'unknown-kind' },
        ],
        structuredContent: { fileId: 'f-1' },
      },
    });
    const args = {
      designId: 'd-1',
      content: { fileName: 'a.pdf', params: {} },
    };
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('generate_pdf_sync', args)], {
        contextId: 'ctx-9',
      }),
      withBearer,
      deps,
    );
    expect(deps.callTool).toHaveBeenCalledWith('generate_pdf_sync', args);

    const task = (bodyOf(r)['result'] as { task: Record<string, unknown> })
      .task;
    expect(task['contextId']).toBe('ctx-9');
    expect(task['status']).toEqual({
      state: 'TASK_STATE_COMPLETED',
      timestamp: FIXED_NOW.toISOString(),
    });
    const artifacts = task['artifacts'] as {
      name: string;
      parts: Record<string, unknown>[];
    }[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe('generate_pdf_sync');
    expect(artifacts[0].parts).toEqual([
      { text: 'Generated.', mediaType: 'text/plain' },
      {
        url: 'https://files.re-port-flow.com/x.pdf',
        mediaType: 'application/pdf',
        filename: 'invoice.pdf',
      },
      { data: { fileId: 'f-1' }, mediaType: 'application/json' },
    ]);
  });

  it('resource / image / audio の content も Part に写し、写せないものは捨てる', async () => {
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('list_templates')]),
      withBearer,
      makeDeps({
        kind: 'result',
        result: {
          content: [
            {
              type: 'resource',
              resource: { uri: 'x://a', mimeType: 'text/csv', text: 'a,b' },
            },
            { type: 'resource', resource: { uri: 'x://b', blob: 'QUJD' } },
            { type: 'resource', resource: { uri: 'x://c' } },
            { type: 'resource', resource: {} },
            { type: 'resource', resource: 'not-an-object' },
            { type: 'image', data: 'iVBO', mimeType: 'image/png' },
            { type: 'audio', data: 'UklG' },
            { type: 'image' },
            { type: 'text', text: 42 },
            { type: 'resource_link', uri: 'https://x/y' },
            { type: 'resource_link' },
            'not-an-object',
          ],
        },
      }),
    );
    const task = (bodyOf(r)['result'] as { task: Record<string, unknown> })
      .task;
    const parts = (task['artifacts'] as { parts: unknown[] }[])[0].parts;
    expect(parts).toEqual([
      { text: 'a,b', mediaType: 'text/csv' },
      { raw: 'QUJD' },
      { url: 'x://c' },
      { raw: 'iVBO', mediaType: 'image/png' },
      { raw: 'UklG' },
      { url: 'https://x/y' },
    ]);
  });

  it('isError で content が空なら既定の失敗メッセージを付ける', async () => {
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('list_templates')]),
      withBearer,
      makeDeps({ kind: 'result', result: { isError: true } }),
    );
    const task = (bodyOf(r)['result'] as { task: Record<string, unknown> })
      .task;
    const status = task['status'] as {
      message: { parts: { text: string }[] };
    };
    expect(status.message.parts[0].text).toBe('The skill failed.');
  });

  it('contextId が無ければ新しく振る', async () => {
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('list_templates')]),
      withBearer,
      makeDeps(),
    );
    const task = (bodyOf(r)['result'] as { task: { contextId: string } }).task;
    expect(task.contextId).toMatch(/^id-/);
  });

  it('isError のツール結果は FAILED Task + status.message にする', async () => {
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('generate_pdf_sync', {})]),
      withBearer,
      makeDeps({
        kind: 'result',
        result: {
          isError: true,
          content: [{ type: 'text', text: 'monthly limit reached' }],
        },
      }),
    );
    const task = (bodyOf(r)['result'] as { task: Record<string, unknown> })
      .task;
    const status = task['status'] as {
      state: string;
      message: { role: string; parts: { text: string }[] };
    };
    expect(status.state).toBe('TASK_STATE_FAILED');
    expect(status.message.role).toBe('ROLE_AGENT');
    expect(status.message.parts[0].text).toBe('monthly limit reached');
    expect(task['artifacts']).toBeUndefined();
  });

  it('MCP の引数エラー (-32602) は内容付きで InvalidParams に写す', async () => {
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('get_design_parameters', {})]),
      withBearer,
      makeDeps({ kind: 'error', code: -32602, message: 'designId: Required' }),
    );
    expect(errorCodeOf(r)).toBe(JSONRPC_INVALID_PARAMS);
    expect(JSON.stringify(bodyOf(r))).toContain('designId: Required');
  });

  it('MCP のそれ以外のエラーは中身を出さず InternalError', async () => {
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('list_templates')]),
      withBearer,
      makeDeps({
        kind: 'error',
        code: -32000,
        message: 'upstream secret detail',
      }),
    );
    expect(errorCodeOf(r)).toBe(JSONRPC_INTERNAL_ERROR);
    expect(JSON.stringify(bodyOf(r))).not.toContain('secret');
  });

  it('MCP 側の 401 は unauthorized に写す', async () => {
    const r = await handleA2aJsonRpc(
      sendMessage([skillPart('list_templates')]),
      withBearer,
      makeDeps({ kind: 'unauthorized' }),
    );
    expect(r.kind).toBe('unauthorized');
  });
});

describe('handleA2aJsonRpc: 実装していない操作', () => {
  it.each([
    ['GetTask', A2A_TASK_NOT_FOUND],
    ['CancelTask', A2A_TASK_NOT_FOUND],
    ['SubscribeToTask', A2A_TASK_NOT_FOUND],
    ['SendStreamingMessage', A2A_UNSUPPORTED_OPERATION],
    ['ListTasks', A2A_UNSUPPORTED_OPERATION],
    ['CreateTaskPushNotificationConfig', A2A_PUSH_NOTIFICATION_NOT_SUPPORTED],
    ['GetTaskPushNotificationConfig', A2A_PUSH_NOTIFICATION_NOT_SUPPORTED],
    ['ListTaskPushNotificationConfigs', A2A_PUSH_NOTIFICATION_NOT_SUPPORTED],
    ['DeleteTaskPushNotificationConfig', A2A_PUSH_NOTIFICATION_NOT_SUPPORTED],
    ['GetExtendedAgentCard', A2A_EXTENDED_CARD_NOT_CONFIGURED],
    // 0.3 のメソッド名は 1.0 では存在しない
    ['message/send', JSONRPC_METHOD_NOT_FOUND],
  ])('%s → %i', async (method, code) => {
    const r = await handleA2aJsonRpc(
      { jsonrpc: '2.0', id: 1, method, params: { id: 't' } },
      withBearer,
      makeDeps(),
    );
    expect(errorCodeOf(r)).toBe(code);
  });
});
