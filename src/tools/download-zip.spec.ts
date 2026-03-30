import axios from 'axios';
import * as fileHelper from '../file-helper';
import { handleDownloadZip } from './download-zip';

jest.mock('axios');
jest.mock('../file-helper');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFileHelper = fileHelper as jest.Mocked<typeof fileHelper>;

describe('handleDownloadZip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('正常系: ZIPをダウンロードしてパスを返す', async () => {
    const mockBuffer = Buffer.from('ZIP_CONTENT');
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockBuffer });
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/invoices.zip');

    const result = await handleDownloadZip({
      requestId: 'req-uuid-1',
      fileName: 'invoices.zip',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.filePath).toBe('/tmp/invoices.zip');

    const callUrl = (mockedAxios.get as jest.Mock).mock.calls[0][0] as string;
    expect(callUrl).toContain('/download/req-uuid-1');
    expect(callUrl).not.toContain('file-uuid');
  });

  it('正常系: fileNameを省略するとrequestId.zipになる', async () => {
    mockedAxios.get = jest.fn().mockResolvedValue({ data: Buffer.from('') });
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/req-uuid-1.zip');

    const result = await handleDownloadZip({
      requestId: 'req-uuid-1',
    });

    expect(result.isError).toBeUndefined();
    expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(
      expect.any(Object),
      'req-uuid-1.zip',
    );
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockedAxios.get = jest.fn().mockRejectedValue(new Error('Not Found'));

    const result = await handleDownloadZip({ requestId: 'req-uuid-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Not Found');
  });
});
