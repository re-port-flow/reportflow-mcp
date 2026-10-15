import { getAuthWorkspaceId } from '../auth';
import { handleGeneratePdfAsync } from './generate-pdf-async';

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

const mockedGetAuthWorkspaceId = getAuthWorkspaceId as jest.MockedFunction<
  typeof getAuthWorkspaceId
>;
const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockJsonResponse(data: unknown, status = 200) {
  mockFetch.mockResolvedValue({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  });
}

/** 生成 → 使用量 の 2 リクエストを順に返す (使用量側は成功 / 失敗を差し替える)。 */
function mockGenerateThenUsage(
  generated: unknown,
  usage: { body: unknown } | Error,
) {
  mockFetch.mockReset();
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(generated),
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

describe('handleGeneratePdfAsync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 既定は「ワークスペース未解決」= plan ブロック無し。
    mockedGetAuthWorkspaceId.mockResolvedValue(undefined);
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
          share: { shareType: 'workspace', passcodeEnabled: false },
        },
      ],
    };
    mockJsonResponse(mockData);

    const result = await handleGeneratePdfAsync(input);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockData);
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Timeout'));

    const result = await handleGeneratePdfAsync(input);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Timeout');
  });

  describe('plan / 使用量 (PRJ-3-1375)', () => {
    const generated = {
      requestId: 'req-uuid-1',
      url: 'https://example.com/download/req-uuid-1',
    };

    it('plan を JSON のキーとして足す (text は JSON のまま)', async () => {
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockGenerateThenUsage(generated, {
        body: {
          used: 8,
          limit: 10,
          remaining: 2,
          percentage: 80,
          planName: 'FREE',
          planType: '01',
        },
      });

      const result = await handleGeneratePdfAsync(input);

      // 応答テキストは JSON.parse 可能なまま (後ろに文章を足さない)
      const payload = JSON.parse(result.content[0].text) as Record<
        string,
        unknown
      >;
      expect(payload.requestId).toBe('req-uuid-1');
      expect(payload.plan).toMatchObject({
        monthlyUsedPages: 8,
        upgradeUrl: 'http://localhost:3000/ws-1/plan',
      });
    });

    it('数値が「今回のジョブを含まない」ことを明示する (PR #123 指摘)', async () => {
      // async は requestId を即返し、ページ数の記録は応答後に走る
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockGenerateThenUsage(generated, {
        body: {
          used: 8,
          limit: 10,
          remaining: 2,
          percentage: 80,
          planName: 'FREE',
          planType: '01',
        },
      });

      const result = await handleGeneratePdfAsync(input);

      const payload = JSON.parse(result.content[0].text) as {
        plan: { excludesPendingJob?: boolean; message: string };
      };
      expect(payload.plan.excludesPendingJob).toBe(true);
      expect(payload.plan.message).toContain('まだ含まれていません');
    });

    it('使用量取得が失敗しても生成結果は必ず返す (plan は省く)', async () => {
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockGenerateThenUsage(generated, new Error('Request timed out'));

      const result = await handleGeneratePdfAsync(input);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual(generated);
    });

    it('注入した resolver が投げても生成結果は返す', async () => {
      mockJsonResponse(generated);

      const result = await handleGeneratePdfAsync(input, {
        resolvePlanNotice: () => Promise.reject(new Error('boom')),
      });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual(generated);
    });
  });
});
