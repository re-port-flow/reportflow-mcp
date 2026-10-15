import {
  FILE_USAGE_TIMEOUT_MS,
  attachPlanNotice,
  buildPlanNotice,
  buildPlanPageUrl,
  getFileUsage,
  resolvePlanNotice,
  type FileUsageResponse,
} from './workspace-usage';
import { getAuthWorkspaceId } from './auth';

jest.mock('./auth', () => ({
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

const mockJsonResponse = (data: unknown, status = 200) => {
  mockFetch.mockResolvedValue({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  });
};

/** reposts-api の実レスポンス形 (workspace/dto/file-usage.response.ts)。 */
const usage = (over: Partial<FileUsageResponse> = {}): FileUsageResponse => ({
  used: 8,
  limit: 10,
  remaining: 2,
  percentage: 80,
  planName: 'FREE',
  planType: '01',
  ...over,
});

describe('getFileUsage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reposts-api の file-usage を app-key 付き・短いタイムアウトで叩く', async () => {
    mockJsonResponse(usage());

    const result = await getFileUsage('ws-1');

    expect(result).toEqual(usage());
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    // test-setup.ts の REPORTFLOW_AUTH_URL = http://localhost:3000/api/v1
    expect(url).toBe('http://localhost:3000/api/v1/workspace/ws-1/file-usage');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
    // VerifyVersion ガードの必須ヘッダー。欠けると 412 でハンドラに到達しない
    expect(headers['app-key']).toBe('reportflow-mcp');
    // 生成は既に成功しているので既定の 30s は待たない
    expect(FILE_USAGE_TIMEOUT_MS).toBe(5_000);
  });

  it('workspaceId をパスへエスケープして埋める', async () => {
    mockJsonResponse(usage());

    await getFileUsage('ws/../other');

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(
      'http://localhost:3000/api/v1/workspace/ws%2F..%2Fother/file-usage',
    );
  });
});

describe('buildPlanPageUrl', () => {
  it('使用量を問い合わせたホストのオリジン + /:workspaceId/plan を返す', () => {
    // reports-ui の実ルート (app/src/routes/index.tsx: /:workspaceId → plan)
    expect(buildPlanPageUrl('ws-1')).toBe('http://localhost:3000/ws-1/plan');
  });

  it('ベース URL が壊れていれば URL を作らない (発明しない)', () => {
    const original = process.env['REPORTFLOW_AUTH_URL'];
    process.env['REPORTFLOW_AUTH_URL'] = 'not-a-url';
    try {
      expect(buildPlanPageUrl('ws-1')).toBeUndefined();
    } finally {
      process.env['REPORTFLOW_AUTH_URL'] = original;
    }
  });
});

describe('buildPlanNotice', () => {
  it('無料プラン (planType=01): 使用量と上限、アップグレード URL を出す', () => {
    const notice = buildPlanNotice(usage(), 'ws-1');

    expect(notice).toEqual({
      planName: 'FREE',
      planType: '01',
      monthlyUsedPages: 8,
      monthlyLimitPages: 10,
      monthlyRemainingPages: 2,
      upgradeUrl: 'http://localhost:3000/ws-1/plan',
      message: expect.stringContaining('8 / 10 ページ') as string,
    });
    expect(notice?.message).toContain('http://localhost:3000/ws-1/plan');
    expect(notice?.message).toContain('残り 2 ページ');
  });

  // 上流の used / limit はファイル本数ではなくページ数の合計
  // (reposts-api countMonthlyUsage = sum(export_size) / content-service の
  // 上限判定も usedPages >= maxFileTimes)。「件」と書くと複数ページ帳票で外れる。
  it('単位はページで書き、「件」とは書かない', () => {
    const notice = buildPlanNotice(usage(), 'ws-1');

    expect(notice?.message).toContain('今月の出力ページ数');
    expect(notice?.message).not.toContain('件');
  });

  it('プラン行が無い WS (planType=FREE リテラル) も無料として扱う', () => {
    // reposts-api workspace.usecase.ts: planType が無いとき 'FREE' を入れる
    const notice = buildPlanNotice(
      usage({ planType: 'FREE', limit: null, remaining: null, percentage: 0 }),
      'ws-1',
    );

    expect(notice?.upgradeUrl).toBe('http://localhost:3000/ws-1/plan');
    expect(notice?.monthlyLimitPages).toBeUndefined();
    // limit が無いので上限は主張しない
    expect(notice?.message).not.toMatch(/上限 \d/);
    expect(notice?.message).toContain('無制限、またはプラン上限が未設定');
    // 上限が分からないのに「上限に達すると」と書かない
    expect(notice?.message).not.toContain('上限に達すると');
  });

  it('有料プランには煽り文もアップグレード URL も出さず、事実だけを返す', () => {
    const notice = buildPlanNotice(
      usage({
        planType: '02',
        planName: 'STANDARD',
        used: 120,
        limit: 1000,
        remaining: 880,
      }),
      'ws-1',
    );

    expect(notice?.upgradeUrl).toBeUndefined();
    expect(notice?.message).toContain('120 / 1000 ページ');
    expect(notice?.message).toContain('STANDARD プラン');
    expect(notice?.message).not.toContain('アップグレード');
    expect(notice?.message).not.toContain('/plan');
  });

  it('無制限扱い (limit=null) の有料プランで「上限 X ページ」と書かない', () => {
    const notice = buildPlanNotice(
      usage({
        planType: '03',
        planName: 'PREMIUM',
        used: 300,
        limit: null,
        remaining: null,
        percentage: 0,
      }),
      'ws-1',
    );

    expect(notice?.monthlyLimitPages).toBeUndefined();
    expect(notice?.monthlyRemainingPages).toBeUndefined();
    expect(notice?.message).toContain('300 ページ');
    expect(notice?.message).not.toMatch(/上限 \d/);
    expect(notice?.upgradeUrl).toBeUndefined();
  });

  // PR #123 のレビュー指摘 (P2): async 経路の数値は「現在値」ではない
  describe('excludesPendingJob (非同期ツール)', () => {
    it('未記録のジョブがあることを message と項目の両方に残す', () => {
      const notice = buildPlanNotice(usage(), 'ws-1', {
        excludesPendingJob: true,
      });

      expect(notice?.excludesPendingJob).toBe(true);
      // 仕様変更（情報設計 用語統一 2026-09）
      expect(notice?.message).toContain(
        'いま受理した出力ジョブのページ数がまだ含まれていません',
      );
    });

    it('有料プラン (URL 無し) の文面にも断りが残る', () => {
      const notice = buildPlanNotice(
        usage({ planType: '02', planName: 'STANDARD' }),
        'ws-1',
        { excludesPendingJob: true },
      );

      expect(notice?.upgradeUrl).toBeUndefined();
      expect(notice?.message).toContain('まだ含まれていません');
    });

    it('既定 (同期ツール) では断りを付けない', () => {
      // sync は content-service が _postFileGeneration を await してから応答するため、
      // 問い合わせ時点でページ数は記録済み。
      const notice = buildPlanNotice(usage(), 'ws-1');

      expect(notice?.excludesPendingJob).toBeUndefined();
      expect(notice?.message).not.toContain('まだ含まれていません');
    });
  });

  it('未知の planType は無料と確定できないので宣伝しない', () => {
    const notice = buildPlanNotice(
      usage({ planType: '99', planName: 'UNKNOWN' }),
      'ws-1',
    );

    expect(notice?.upgradeUrl).toBeUndefined();
  });

  it('planType / planName が欠けていても used は伝え、プラン名は名乗らない', () => {
    const notice = buildPlanNotice(
      usage({ planType: '  ', planName: '' }),
      'ws-1',
    );

    expect(notice?.planType).toBeUndefined();
    expect(notice?.planName).toBeUndefined();
    expect(notice?.upgradeUrl).toBeUndefined();
    expect(notice?.message).toContain('プラン名は取得できませんでした');
  });

  it('無料プランでもベース URL が壊れていれば URL 抜きで返す', () => {
    const original = process.env['REPORTFLOW_AUTH_URL'];
    process.env['REPORTFLOW_AUTH_URL'] = 'not-a-url';
    try {
      const notice = buildPlanNotice(usage(), 'ws-1');
      expect(notice?.upgradeUrl).toBeUndefined();
      expect(notice?.message).not.toContain('アップグレード');
    } finally {
      process.env['REPORTFLOW_AUTH_URL'] = original;
    }
  });

  describe('契約外の応答は「0 ページ」と書かずに何も返さない', () => {
    it.each([
      ['used が数値でない', usage({ used: '8' as unknown as number })],
      ['used が負数', usage({ used: -1 })],
      ['used が小数', usage({ used: 1.5 })],
    ])('%s', (_label, payload) => {
      expect(buildPlanNotice(payload, 'ws-1')).toBeUndefined();
    });

    it('本体が object でない (CDN が HTML/null に差し替えた等)', () => {
      expect(
        buildPlanNotice(null as unknown as FileUsageResponse, 'ws-1'),
      ).toBeUndefined();
      expect(
        buildPlanNotice('<html>' as unknown as FileUsageResponse, 'ws-1'),
      ).toBeUndefined();
    });

    it('limit / remaining が契約外なら、その値だけを落として used は残す', () => {
      const notice = buildPlanNotice(
        usage({
          limit: 'many' as unknown as number,
          remaining: -5,
        }),
        'ws-1',
      );

      expect(notice?.monthlyUsedPages).toBe(8);
      expect(notice?.monthlyLimitPages).toBeUndefined();
      expect(notice?.monthlyRemainingPages).toBeUndefined();
    });
  });
});

describe('resolvePlanNotice', () => {
  beforeEach(() => jest.clearAllMocks());

  it('成功時は plan ブロックを返す', async () => {
    mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
    mockJsonResponse(usage());

    await expect(resolvePlanNotice()).resolves.toMatchObject({
      monthlyUsedPages: 8,
      upgradeUrl: 'http://localhost:3000/ws-1/plan',
    });
  });

  it('ワークスペースが解決できなければ undefined (問い合わせもしない)', async () => {
    mockedGetAuthWorkspaceId.mockResolvedValue(undefined);

    await expect(resolvePlanNotice()).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('認証エラーは握りつぶす', async () => {
    mockedGetAuthWorkspaceId.mockRejectedValue(new Error('再認証が必要です'));

    await expect(resolvePlanNotice()).resolves.toBeUndefined();
  });

  it('API が HTTP エラーを返しても undefined', async () => {
    mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
    mockJsonResponse({ message: 'Forbidden' }, 403);

    await expect(resolvePlanNotice()).resolves.toBeUndefined();
  });

  it('タイムアウト・通信断でも undefined', async () => {
    mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
    mockFetch.mockRejectedValue(new Error('Request timed out after 5000ms'));

    await expect(resolvePlanNotice()).resolves.toBeUndefined();
  });

  // 以下 2 件は PR #123 のレビュー指摘 (P2) を固定するテスト。
  it('401 でも refresh + 再送をしない (省いてよい寄り道を伸ばさない)', async () => {
    mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
    mockJsonResponse({ message: 'Unauthorized' }, 401);

    await expect(resolvePlanNotice()).resolves.toBeUndefined();
    // requestWithAuth 経由なら refresh + 再送で 3 回になる。1 回で諦める。
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('解決全体がデッドラインで打ち切られる (認証側が固まっても待たせない)', async () => {
    jest.useFakeTimers();
    try {
      // signal を受け取らない refresh 等で固まるケースを、解決しない Promise で表す
      mockedGetAuthWorkspaceId.mockReturnValue(new Promise(() => undefined));

      const pending = resolvePlanNotice();
      await jest.advanceTimersByTimeAsync(FILE_USAGE_TIMEOUT_MS);

      await expect(pending).resolves.toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('進行中の fetch を中断できるよう signal を渡す', async () => {
    mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
    mockJsonResponse(usage());

    await resolvePlanNotice();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
  });
});

describe('attachPlanNotice', () => {
  it('オプションを resolver へそのまま渡す', async () => {
    const resolve = jest.fn().mockResolvedValue(undefined);

    await attachPlanNotice({ requestId: 'r1' }, resolve, {
      excludesPendingJob: true,
    });

    expect(resolve).toHaveBeenCalledWith({ excludesPendingJob: true });
  });

  it('取得できたら plan キーを足す', async () => {
    const resolve = jest.fn().mockResolvedValue({
      monthlyUsedPages: 1,
      message: 'msg',
    });

    await expect(
      attachPlanNotice({ filePath: '/tmp/a.pdf' }, resolve),
    ).resolves.toEqual({
      filePath: '/tmp/a.pdf',
      plan: { monthlyUsedPages: 1, message: 'msg' },
    });
  });

  it('取得できなければキー自体を生やさない (0 ページと書かない)', async () => {
    const resolve = jest.fn().mockResolvedValue(undefined);

    const payload = await attachPlanNotice({ filePath: '/tmp/a.pdf' }, resolve);

    expect(payload).toEqual({ filePath: '/tmp/a.pdf' });
    expect('plan' in payload).toBe(false);
  });

  it('resolver が投げてもペイロードを落とさない', async () => {
    const resolve = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(
      attachPlanNotice({ filePath: '/tmp/a.pdf' }, resolve),
    ).resolves.toEqual({ filePath: '/tmp/a.pdf' });
  });
});

// PRJ-3-1580: file-usage も OAuth issuer と同じホスト (= Cloudflare Access
// 境界の内側) にある。`resolvePlanNotice` は例外を投げず undefined に落とす
// 設計なので、身元が無いと **plan ブロックだけが黙って消える**。
describe('getFileUsage / Access service auth', () => {
  const ID = 'RF_ACCESS_CLIENT_ID';
  const SECRET = 'RF_ACCESS_CLIENT_SECRET';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    saved[ID] = process.env[ID];
    saved[SECRET] = process.env[SECRET];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const sentHeaders = (): Headers => {
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    return new Headers(init.headers);
  };

  it('2 値が揃っていれば CF-Access-* を載せる', async () => {
    process.env[ID] = 'svc-token-id.access';
    process.env[SECRET] = 'svc-token-secret';
    mockJsonResponse(usage());

    await getFileUsage('ws-1');

    const headers = sentHeaders();
    expect(headers.get('CF-Access-Client-Id')).toBe('svc-token-id.access');
    expect(headers.get('CF-Access-Client-Secret')).toBe('svc-token-secret');
    // 既存の必須ヘッダーを潰していない。
    expect(headers.get('Authorization')).toBe('Bearer test-token');
    expect(headers.get('app-key')).toBe('reportflow-mcp');
  });

  it('2 値が無ければ従来どおりヘッダー無しで叩く', async () => {
    delete process.env[ID];
    delete process.env[SECRET];
    mockJsonResponse(usage());

    await getFileUsage('ws-1');

    expect(sentHeaders().get('CF-Access-Client-Id')).toBeNull();
  });
});
