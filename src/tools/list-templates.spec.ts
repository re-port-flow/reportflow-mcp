import { handleListTemplates } from './list-templates';

jest.mock('../auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ appkey: 'test-app-key' }),
  ),
  invalidateToken: jest.fn(),
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

describe('handleListTemplates', () => {
  beforeEach(() => jest.clearAllMocks());

  it('正常系: デザイン一覧を返す', async () => {
    const mockData = {
      designs: [
        { id: 'design-uuid-1', label: '請求書テンプレート', latestVersion: 3, thumbnail: 'https://example.com/thumb1.png', updatedAt: '2026-03-01T00:00:00.000Z' },
        { id: 'design-uuid-2', label: '見積書テンプレート', latestVersion: 1, thumbnail: 'https://example.com/thumb2.png', updatedAt: '2026-02-15T00:00:00.000Z' },
      ],
    };
    mockJsonResponse(mockData);

    const result = await handleListTemplates({});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    expect(mockFetch.mock.calls[0][0]).toContain('/v1/file/designs');
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Network Error'));

    const result = await handleListTemplates({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Network Error');
  });
});
