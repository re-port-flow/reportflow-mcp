import { handleFetch } from './fetch';

jest.mock('../auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ Authorization: 'Bearer test-token' }),
  ),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const schema = {
  customerName: 'string',
  amount: 'number',
  items: [{ itemName: 'string', price: 'number' }],
};

const designs = {
  designs: [
    {
      id: 'design-uuid-1',
      label: '請求書テンプレート',
      latestVersion: 3,
      thumbnail: 'https://example.com/thumb1.png',
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
  ],
};

/** URL に応じて parameter スキーマ or デザイン一覧を返す */
function routeMock(opts: { listDesignsError?: boolean } = {}) {
  mockFetch.mockImplementation((url: string) => {
    const ok = (data: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(data),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    if (url.includes('/design/parameter/')) return ok(schema);
    if (url.includes('/v1/file/designs')) {
      if (opts.listDesignsError) return Promise.reject(new Error('list failed'));
      return ok(designs);
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  });
}

describe('handleFetch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('正常系: version 付き id でスキーマと解決した title を返す', async () => {
    routeMock();

    const result = await handleFetch({ id: 'design-uuid-1@3' });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe('design-uuid-1@3');
    expect(payload.title).toBe('請求書テンプレート');
    expect(payload.url).toBe(
      'https://re-port-flow.com/designs/design-uuid-1?v=3',
    );
    expect(payload.metadata.parameters).toEqual(schema);
    // OpenAI MCP fetch 規約: 本文 text とスキーマ、structuredContent を返す
    expect(JSON.parse(payload.text)).toEqual(schema);
    expect(result.structuredContent).toEqual(payload);

    const paramCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes('/design/parameter/'),
    );
    expect(String(paramCall?.[0])).toContain('version=3');
  });

  it('正常系: version 省略時は最新版（version パラメータ無し）で取得する', async () => {
    routeMock();

    const result = await handleFetch({ id: 'design-uuid-1' });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.url).toBe('https://re-port-flow.com/designs/design-uuid-1');

    const paramCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes('/design/parameter/'),
    );
    expect(String(paramCall?.[0])).not.toContain('version=');
  });

  it('正常系: label 解決に失敗しても designId を title にしてスキーマを返す', async () => {
    routeMock({ listDesignsError: true });

    const result = await handleFetch({ id: 'design-uuid-1@3' });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.title).toBe('design-uuid-1');
    expect(payload.metadata.parameters).toEqual(schema);
  });

  it('エラー系: スキーマ取得が失敗したら isError=true を返す', async () => {
    mockFetch.mockRejectedValue(new Error('Network Error'));

    const result = await handleFetch({ id: 'design-uuid-1@3' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Network Error');
    expect(result.structuredContent).toEqual({
      error: { tool: 'fetch', id: 'design-uuid-1@3', message: 'Network Error' },
    });
  });
});
