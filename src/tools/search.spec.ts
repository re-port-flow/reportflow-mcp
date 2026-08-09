import { handleSearch } from './search';

jest.mock('../auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ Authorization: 'Bearer test-token' }),
  ),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockJsonResponse(data: unknown, status = 200) {
  mockFetch.mockResolvedValue({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  });
}

const designs = {
  designs: [
    {
      id: 'design-uuid-1',
      label: '請求書テンプレート',
      latestVersion: 3,
      thumbnail: 'https://example.com/thumb1.png',
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
    {
      id: 'design-uuid-2',
      label: '見積書テンプレート',
      latestVersion: 1,
      thumbnail: 'https://example.com/thumb2.png',
      updatedAt: '2026-02-15T00:00:00.000Z',
    },
  ],
};

describe('handleSearch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('正常系: label 部分一致でヒットを返す（id は <designId>@<version> 形式）', async () => {
    mockJsonResponse(designs);

    const result = await handleSearch({ query: '請求書' });

    expect(result.isError).toBeUndefined();
    const expected = [
      {
        id: 'design-uuid-1@3',
        title: '請求書テンプレート',
        url: 'https://re-port-flow.com/designs/design-uuid-1',
      },
    ];
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results).toEqual(expected);
    // OpenAI MCP search 規約: 結果は structuredContent でも返す（text と同内容）
    expect(result.structuredContent).toEqual({ results: expected });
    expect(mockFetch.mock.calls[0][0]).toContain('/v1/file/designs');
  });

  it('正常系: 大文字小文字を無視して一致する', async () => {
    mockJsonResponse({
      designs: [{ ...designs.designs[0], label: 'Invoice Template' }],
    });

    const result = await handleSearch({ query: 'invoice' });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.results).toHaveLength(1);
  });

  it('正常系: 空クエリは全件を返す', async () => {
    mockJsonResponse(designs);

    const result = await handleSearch({ query: '   ' });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.results).toHaveLength(2);
  });

  it('正常系: query 未指定（undefined）でも全件を返す', async () => {
    mockJsonResponse(designs);

    const result = await handleSearch({});

    const payload = JSON.parse(result.content[0].text);
    expect(payload.results).toHaveLength(2);
  });

  it('正常系: 一致なしは空配列を返す', async () => {
    mockJsonResponse(designs);

    const result = await handleSearch({ query: '契約書' });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.results).toEqual([]);
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Network Error'));

    const result = await handleSearch({ query: '請求書' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Network Error');
    // 失敗は structuredContent.error にも機械可読な形で載せる
    expect(result.structuredContent).toEqual({
      error: { tool: 'search', message: 'Network Error' },
    });
  });
});
