import axios from 'axios';
import { handleListTemplates } from './list-templates';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('handleListTemplates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('正常系: デザイン一覧を返す', async () => {
    const mockData = {
      designs: [
        {
          id: 'design-uuid-1',
          label: '請求書テンプレート',
          latestVersion: 3,
          thumbnail: 'https://example.com/thumb1.png',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
        {
          id: 'design-uuid-2',
          label: '見積書テンプレート',
          latestVersion: 1,
          thumbnail: 'https://example.com/thumb2.png',
          updatedAt: '2026-02-15T00:00:00.000Z',
        },
      ],
    };
    mockedAxios.get = jest.fn().mockResolvedValue({ data: mockData });

    const result = await handleListTemplates({});

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(mockData);

    const callUrl = (mockedAxios.get as jest.Mock).mock.calls[0][0] as string;
    expect(callUrl).toContain('/v1/file/designs');
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockedAxios.get = jest.fn().mockRejectedValue(new Error('Network Error'));

    const result = await handleListTemplates({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Network Error');
  });
});
