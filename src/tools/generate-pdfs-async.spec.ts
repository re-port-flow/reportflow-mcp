import axios from 'axios';
import { handleGeneratePdfsAsync } from './generate-pdfs-async';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('handleGeneratePdfsAsync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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
        {
          fileName: 'invoice1.pdf',
          fileId: 'file-uuid-1',
          params: { name: '山田太郎' },
          share: { shareType: 'private', passcodeEnabled: false },
        },
        {
          fileName: 'invoice2.pdf',
          fileId: 'file-uuid-2',
          params: { name: '鈴木次郎' },
          share: { shareType: 'private', passcodeEnabled: false },
        },
      ],
    };
    mockedAxios.post = jest.fn().mockResolvedValue({ data: mockData });

    const result = await handleGeneratePdfsAsync(input);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockData);
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('Timeout'));

    const result = await handleGeneratePdfsAsync(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Timeout');
  });
});
