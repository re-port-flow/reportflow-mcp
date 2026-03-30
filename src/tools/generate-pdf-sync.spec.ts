import axios from 'axios';
import * as fileHelper from '../file-helper';
import { handleGeneratePdfSync } from './generate-pdf-sync';

jest.mock('axios');
jest.mock('../file-helper');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFileHelper = fileHelper as jest.Mocked<typeof fileHelper>;

describe('handleGeneratePdfSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/invoice.pdf');
  });

  const input = {
    designId: 'design-uuid-1',
    version: 1,
    content: {
      fileName: 'invoice.pdf',
      params: { name: '山田太郎', amount: 10000 },
    },
  };

  it('正常系: PDFを生成しファイルパスを返す', async () => {
    const mockBuffer = Buffer.from('PDF_CONTENT');
    mockedAxios.post = jest.fn().mockResolvedValue({ data: mockBuffer });

    const result = await handleGeneratePdfSync(input);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.filePath).toBe('/tmp/invoice.pdf');
    expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(
      expect.any(Object),
      'invoice.pdf',
    );
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('Server Error'));

    const result = await handleGeneratePdfSync(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Server Error');
  });
});
