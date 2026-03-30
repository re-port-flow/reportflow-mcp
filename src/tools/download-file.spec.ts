import axios from 'axios';
import * as fileHelper from '../file-helper';
import { handleDownloadFile } from './download-file';

jest.mock('axios');
jest.mock('../file-helper');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFileHelper = fileHelper as jest.Mocked<typeof fileHelper>;

describe('handleDownloadFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('正常系: ファイルをダウンロードしてパスを返す', async () => {
    const mockBuffer = Buffer.from('PDF_CONTENT');
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockBuffer });
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/invoice.pdf');

    const result = await handleDownloadFile({
      requestId: 'req-uuid-1',
      fileId: 'file-uuid-1',
      fileName: 'invoice.pdf',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.filePath).toBe('/tmp/invoice.pdf');

    const callUrl = (mockedAxios.get as jest.Mock).mock.calls[0][0] as string;
    expect(callUrl).toContain('req-uuid-1/file-uuid-1');
  });

  it('正常系: fileNameを省略するとfileId.pdfになる', async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: Buffer.from('') });
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/file-uuid-1.pdf');

    const result = await handleDownloadFile({
      requestId: 'req-uuid-1',
      fileId: 'file-uuid-1',
    });

    expect(result.isError).toBeUndefined();
    expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(
      expect.any(Object),
      'file-uuid-1.pdf',
    );
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockedAxios.get = jest.fn().mockRejectedValue(new Error('Not Found'));

    const result = await handleDownloadFile({
      requestId: 'req-uuid-1',
      fileId: 'file-uuid-1',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Not Found');
  });
});
