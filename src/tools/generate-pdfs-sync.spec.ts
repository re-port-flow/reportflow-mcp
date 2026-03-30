import axios from 'axios';
import * as fileHelper from '../file-helper';
import { handleGeneratePdfsSync } from './generate-pdfs-sync';

jest.mock('axios');
jest.mock('../file-helper');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFileHelper = fileHelper as jest.Mocked<typeof fileHelper>;

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
    const mockBuffer = Buffer.from('ZIP_CONTENT');
    mockedAxios.post = jest.fn().mockResolvedValue({ data: mockBuffer });

    const result = await handleGeneratePdfsSync(input);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.filePath).toBe('/tmp/download.zip');
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('Server Error'));

    const result = await handleGeneratePdfsSync(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Server Error');
  });
});
