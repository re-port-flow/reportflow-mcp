import * as fileHelper from '../file-helper';
import { handleGeneratePdfsSync } from './generate-pdfs-sync';

jest.mock('../auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ appkey: 'test-app-key' }),
  ),
  invalidateToken: jest.fn(),
}));
jest.mock('../file-helper');

const mockedFileHelper = fileHelper as jest.Mocked<typeof fileHelper>;
const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockBinaryResponse(buffer: ArrayBuffer, status = 200) {
  mockFetch.mockResolvedValue({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(buffer),
  });
}

describe('handleGeneratePdfsSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/download.zip');
  });

  const input = {
    designId: 'design-uuid-1',
    version: 1,
    contents: [
      { fileName: 'invoice1.pdf', params: { name: '山田太郎' } },
      { fileName: 'invoice2.pdf', params: { name: '鈴木次郎' } },
    ],
  };

  it('正常系: ZIPファイルパスを返す', async () => {
    mockBinaryResponse(Buffer.from('ZIP_CONTENT').buffer);

    const result = await handleGeneratePdfsSync(input);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).filePath).toBe('/tmp/download.zip');
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Server Error'));

    const result = await handleGeneratePdfsSync(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Server Error');
  });
});
