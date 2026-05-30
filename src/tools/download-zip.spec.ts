import * as fileHelper from '../file-helper';
import { handleDownloadZip } from './download-zip';

jest.mock('../auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ Authorization: 'Bearer test-token' }),
  ),
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

describe('handleDownloadZip', () => {
  beforeEach(() => jest.clearAllMocks());

  it('正常系: ZIPをダウンロードしてパスを返す', async () => {
    mockBinaryResponse(Buffer.from('ZIP_CONTENT').buffer);
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/invoices.zip');

    const result = await handleDownloadZip({
      requestId: 'req-uuid-1',
      fileName: 'invoices.zip',
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).filePath).toBe(
      '/tmp/invoices.zip',
    );
    expect(mockFetch.mock.calls[0][0]).toContain('/download/req-uuid-1');
    expect(mockFetch.mock.calls[0][0]).not.toContain('file-uuid');
  });

  it('正常系: fileNameを省略するとrequestId.zipになる', async () => {
    mockBinaryResponse(Buffer.from('').buffer);
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/req-uuid-1.zip');

    const result = await handleDownloadZip({ requestId: 'req-uuid-1' });

    expect(result.isError).toBeUndefined();
    expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      'req-uuid-1.zip',
      undefined,
      [],
    );
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Not Found'));

    const result = await handleDownloadZip({ requestId: 'req-uuid-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Not Found');
  });
});
