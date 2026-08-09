/**
 * Layer A: in-process integration — error path validation
 *
 * fetch が各種エラーステータスを返したとき、tools/call が isError: true の
 * MCP エラー応答を返すことを検証する。
 */

// ─── 外部依存のモック ────────────────────────────────────────────────────────
jest.mock('../auth', () => ({
  authorize: jest.fn(),
  requestWithAuth: jest.fn().mockImplementation(
    (fn: (headers: Record<string, string>) => Promise<unknown>) =>
      fn({ Authorization: 'Bearer dummy-token' }),
  ),
}));
jest.mock('../roots/index', () => ({
  resolveDefaultOutputDir: jest.fn(),
  resolveAllowedRoots: jest.fn().mockResolvedValue([]),
}));
jest.mock('../sampling/request', () => ({
  requestSamplingText: jest.fn(),
}));
jest.mock('../telemetry/index', () => ({
  telemetryClientFromEnv: () => ({ emit: jest.fn() }),
  withTelemetry:
    (_tc: unknown, _name: string, fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
}));

import { createTestClient, TestClientHandle } from './helpers/createTestClient';

type FetchMockFn = jest.MockedFunction<typeof global.fetch>;

// Fix 3: global.fetch を直接代入した場合 jest.restoreAllMocks() では復元できない。
// originalFetch を保持して afterEach で確実に復元する。
const originalFetch = global.fetch;

const mockFetchStatus = (fetchMock: FetchMockFn, status: number, body = '{}') => {
  fetchMock.mockResolvedValueOnce(
    new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
};

/**
 * tools/call のレスポンスから text コンテンツを結合して返す。
 * content が配列でない場合も考慮。
 */
const extractText = (result: { content: unknown }): string => {
  if (!Array.isArray(result.content)) return '';
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
};

describe('error paths (Layer A)', () => {
  let handle: TestClientHandle;
  let fetchMock: FetchMockFn;

  beforeAll(async () => {
    handle = await createTestClient();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(() => {
    fetchMock = jest.fn() as FetchMockFn;
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // list_templates を代表ツールとして使用。他ツールも同じ auth/http 経路を通る。

  it('fetch が 401 → isError: true かつ auth 系メッセージ', async () => {
    mockFetchStatus(fetchMock, 401, JSON.stringify({ message: 'Unauthorized' }));

    const result = await handle.client.callTool({
      name: 'list_templates',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = extractText(result as { content: unknown });
    // 認証エラーであることを示すメッセージが含まれる
    expect(text.toLowerCase()).toMatch(/401|unauthorized|認証|auth/i);
  });

  it('fetch が 404 → isError: true かつ 404 系メッセージ', async () => {
    mockFetchStatus(fetchMock, 404, JSON.stringify({ message: 'Not Found' }));

    const result = await handle.client.callTool({
      name: 'list_templates',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = extractText(result as { content: unknown });
    expect(text).toMatch(/404|not.?found/i);
  });

  it('fetch が 500 → isError: true かつ 500 系メッセージ', async () => {
    mockFetchStatus(
      fetchMock,
      500,
      JSON.stringify({ message: 'Internal Server Error' }),
    );

    const result = await handle.client.callTool({
      name: 'list_templates',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = extractText(result as { content: unknown });
    expect(text).toMatch(/500|server.?error|internal/i);
  });
});
