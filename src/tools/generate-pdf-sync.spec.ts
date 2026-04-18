import * as fileHelper from '../file-helper';
import { handleGeneratePdfSync } from './generate-pdf-sync';

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

describe('handleGeneratePdfSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/invoice.pdf');
  });

  const input = {
    designId: 'design-uuid-1',
    version: 1,
    content: { fileName: 'invoice.pdf', params: { name: '山田太郎', amount: 10000 } },
  };

  it('正常系: PDFを生成しファイルパスを返す', async () => {
    mockBinaryResponse(Buffer.from('PDF_CONTENT').buffer);

    const result = await handleGeneratePdfSync(input);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).filePath).toBe('/tmp/invoice.pdf');
    expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'invoice.pdf');
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Server Error'));

    const result = await handleGeneratePdfSync(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Server Error');
  });
});
