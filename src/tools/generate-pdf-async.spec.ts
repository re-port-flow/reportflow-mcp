import axios from 'axios';
import { handleGeneratePdfAsync } from './generate-pdf-async';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('handleGeneratePdfAsync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const input = {
    designId: 'design-uuid-1',
    version: 1,
    content: {
      fileName: 'invoice.pdf',
      params: { name: '山田太郎', amount: 10000 },
    },
  };

  it('正常系: requestIdとfiles情報を返す', async () => {
    const mockData = {
      requestId: 'req-uuid-1',
      url: 'https://example.com/download/req-uuid-1',
      files: [
        {
          fileName: 'invoice.pdf',
          fileId: 'file-uuid-1',
          params: { name: '山田太郎', amount: 10000 },
          share: { shareType: 'private', passcodeEnabled: false },
        },
      ],
    };
    mockedAxios.post = jest.fn().mockResolvedValue({ data: mockData });

    const result = await handleGeneratePdfAsync(input);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockData);
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('Timeout'));

    const result = await handleGeneratePdfAsync(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Timeout');
  });
});
