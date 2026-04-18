import * as fileHelper from '../file-helper';
import { handleDownloadFile } from './download-file';

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

describe('handleDownloadFile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('正常系: ファイルをダウンロードしてパスを返す', async () => {
    mockBinaryResponse(Buffer.from('PDF_CONTENT').buffer);
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/invoice.pdf');

    const result = await handleDownloadFile({ requestId: 'req-uuid-1', fileId: 'file-uuid-1', fileName: 'invoice.pdf' });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).filePath).toBe('/tmp/invoice.pdf');
    expect(mockFetch.mock.calls[0][0]).toContain('req-uuid-1/file-uuid-1');
  });

  it('正常系: fileNameを省略するとfileId.pdfになる', async () => {
    mockBinaryResponse(Buffer.from('').buffer);
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/file-uuid-1.pdf');

    const result = await handleDownloadFile({ requestId: 'req-uuid-1', fileId: 'file-uuid-1' });

    expect(result.isError).toBeUndefined();
    expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'file-uuid-1.pdf');
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Not Found'));

    const result = await handleDownloadFile({ requestId: 'req-uuid-1', fileId: 'file-uuid-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Not Found');
  });
});
