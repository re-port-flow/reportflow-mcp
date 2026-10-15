import * as fileHelper from '../file-helper';
import { getAuthWorkspaceId } from '../auth';
import { handleGeneratePdfsSync } from './generate-pdfs-sync';

jest.mock('../auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ Authorization: 'Bearer test-token' }),
  ),
  // 使用量取得 (workspace-usage.ts) は requestWithAuth を通さず直接ヘッダーを取る
  getAuthHeaders: jest
    .fn()
    .mockResolvedValue({ Authorization: 'Bearer test-token' }),
  getAuthWorkspaceId: jest.fn(),
}));
jest.mock('../file-helper');

const mockedFileHelper = fileHelper as jest.Mocked<typeof fileHelper>;
const mockedGetAuthWorkspaceId = getAuthWorkspaceId as jest.MockedFunction<
  typeof getAuthWorkspaceId
>;
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

/** ZIP 生成 (binary) → 使用量 (JSON) の 2 リクエストを順に返す。 */
function mockGenerateThenUsage(usage: { body: unknown } | Error) {
  mockFetch.mockReset();
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(Buffer.from('ZIP_CONTENT').buffer),
  });
  if (usage instanceof Error) {
    mockFetch.mockRejectedValueOnce(usage);
  } else {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(usage.body),
    });
  }
}

describe('handleGeneratePdfsSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/download.zip');
    // 既定は「ワークスペース未解決」= plan ブロック無し。
    mockedGetAuthWorkspaceId.mockResolvedValue(undefined);
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
    mockBinaryResponse(Buffer.from('ZIP_CONTENT').buffer);

    const result = await handleGeneratePdfsSync(input);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).filePath).toBe(
      '/tmp/download.zip',
    );
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Server Error'));

    const result = await handleGeneratePdfsSync(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Server Error');
  });

  // PRJ-3-2016: 時間切れは同期での再試行が二重消費になりうるので async を案内する。
  it('エラー系: 504 (60 秒の時間切れ) では generate_pdfs_async を案内する', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 504,
      statusText: 'Gateway Timeout',
      json: () => Promise.reject(new Error('not json')),
    });

    const result = await handleGeneratePdfsSync(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: [504]');
    expect(result.content[0].text).toContain('generate_pdfs_async');
  });

  it('エラー系: 時間切れ以外では案内を足さない', async () => {
    mockFetch.mockRejectedValue(new Error('Server Error'));

    const result = await handleGeneratePdfsSync(input);

    expect(result.content[0].text).toBe('エラー: Server Error');
  });

  describe('plan / 使用量 (PRJ-3-1375)', () => {
    it('plan を JSON のキーとして足す', async () => {
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockGenerateThenUsage({
        body: {
          used: 8,
          limit: 10,
          remaining: 2,
          percentage: 80,
          planName: 'FREE',
          planType: '01',
        },
      });

      const result = await handleGeneratePdfsSync(input);

      const payload = JSON.parse(result.content[0].text) as Record<
        string,
        unknown
      >;
      expect(payload.filePath).toBe('/tmp/download.zip');
      expect(payload.plan).toMatchObject({
        monthlyUsedPages: 8,
        upgradeUrl: 'http://localhost:3000/ws-1/plan',
      });
    });

    it('使用量取得が失敗しても ZIP のパスは必ず返す (plan は省く)', async () => {
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockGenerateThenUsage(new Error('Request timed out'));

      const result = await handleGeneratePdfsSync(input);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        filePath: '/tmp/download.zip',
      });
    });
  });
});
