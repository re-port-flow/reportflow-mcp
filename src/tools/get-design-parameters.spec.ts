import { handleGetDesignParameters } from './get-design-parameters';

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

describe('handleGetDesignParameters', () => {
  beforeEach(() => jest.clearAllMocks());

  it('正常系: パラメータ構造を返す', async () => {
    const mockData = { name: 'string', amount: 'number', items: [{ itemName: 'string', price: 'number' }] };
    mockJsonResponse(mockData);

    const result = await handleGetDesignParameters({ designId: 'test-design-id' });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockData);
  });

  it('正常系: versionを指定してパラメータ構造を返す', async () => {
    const mockData = { title: 'string' };
    mockJsonResponse(mockData);

    const result = await handleGetDesignParameters({ designId: 'test-design-id', version: 2 });

    expect(result.isError).toBeUndefined();
    expect(mockFetch.mock.calls[0][0]).toContain('version=2');
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Network Error'));

    const result = await handleGetDesignParameters({ designId: 'invalid-id' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Network Error');
  });

  it('エラー系: 非Errorオブジェクトのエラーでも文字列化する', async () => {
    mockFetch.mockRejectedValue('unknown error');

    const result = await handleGetDesignParameters({ designId: 'invalid-id' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー:');
  });
});
