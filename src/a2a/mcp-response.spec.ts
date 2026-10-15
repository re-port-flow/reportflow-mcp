import { interpretMcpToolResponse, parseJsonRpcBody } from './mcp-response';

const JSON_CT = 'application/json';
const SSE_CT = 'text/event-stream';

describe('parseJsonRpcBody', () => {
  it('application/json の単一ボディを読む', () => {
    expect(parseJsonRpcBody(JSON_CT, '{"jsonrpc":"2.0","id":1}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
    });
  });

  it('SSE では最後の data: 行を読む', () => {
    const text = [
      'event: message',
      'data: {"id":1,"step":"first"}',
      '',
      'data: {"id":1,"step":"last"}',
      '',
    ].join('\n');
    expect(parseJsonRpcBody(SSE_CT, text)).toEqual({ id: 1, step: 'last' });
  });

  it('SSE に data: 行が無ければ null', () => {
    expect(parseJsonRpcBody(SSE_CT, 'event: ping\n\n')).toBeNull();
  });

  it.each([
    ['JSON でない', 'not json'],
    ['配列', '[{"id":1}]'],
    ['プリミティブ', '42'],
  ])('%s は null', (_label, text) => {
    expect(parseJsonRpcBody(JSON_CT, text)).toBeNull();
  });

  it('Content-Type が無ければ JSON として読む', () => {
    expect(parseJsonRpcBody(null, '{"a":1}')).toEqual({ a: 1 });
  });
});

describe('interpretMcpToolResponse', () => {
  it('401 は unauthorized (本文は読まない)', () => {
    expect(interpretMcpToolResponse(401, JSON_CT, 'garbage')).toEqual({
      kind: 'unauthorized',
    });
  });

  it('result を返す', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
    expect(interpretMcpToolResponse(200, JSON_CT, body)).toEqual({
      kind: 'result',
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
  });

  it('JSON-RPC エラーは code と message を写す', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'bad args' },
    });
    expect(interpretMcpToolResponse(400, JSON_CT, body)).toEqual({
      kind: 'error',
      code: -32602,
      message: 'bad args',
    });
  });

  it('code / message が欠けたエラーは InternalError と既定文言にする', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: {} });
    expect(interpretMcpToolResponse(500, JSON_CT, body)).toEqual({
      kind: 'error',
      code: -32603,
      message: 'Tool call failed',
    });
  });

  it.each([
    ['解析できない本文', 'not json'],
    ['result も error も無い', '{"jsonrpc":"2.0","id":1}'],
    ['result がオブジェクトでない', '{"jsonrpc":"2.0","id":1,"result":"x"}'],
  ])('%s は InternalError (Empty MCP response)', (_label, text) => {
    expect(interpretMcpToolResponse(200, JSON_CT, text)).toEqual({
      kind: 'error',
      code: -32603,
      message: 'Empty MCP response',
    });
  });
});
