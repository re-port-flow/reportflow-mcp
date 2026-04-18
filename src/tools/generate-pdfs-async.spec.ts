import { handleGeneratePdfsAsync } from './generate-pdfs-async';

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

describe('handleGeneratePdfsAsync', () => {
  beforeEach(() => jest.clearAllMocks());

  const input = {
    designId: 'design-uuid-1',
    version: 1,
    contents: [
      { fileName: 'invoice1.pdf', params: { name: '山田太郎' } },
      { fileName: 'invoice2.pdf', params: { name: '鈴木次郎' } },
    ],
  };

  it('正常系: requestIdとfiles情報を返す', async () => {
    const mockData = {
      requestId: 'req-uuid-2',
      url: 'https://example.com/download/req-uuid-2',
      files: [
        { fileName: 'invoice1.pdf', fileId: 'file-uuid-1', params: { name: '山田太郎' }, share: { shareType: 'private', passcodeEnabled: false } },
        { fileName: 'invoice2.pdf', fileId: 'file-uuid-2', params: { name: '鈴木次郎' }, share: { shareType: 'private', passcodeEnabled: false } },
      ],
    };
    mockJsonResponse(mockData);

    const result = await handleGeneratePdfsAsync(input);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockData);
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Timeout'));

    const result = await handleGeneratePdfsAsync(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Timeout');
  });
});
