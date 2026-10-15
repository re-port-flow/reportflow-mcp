import {
  duplicateGalleryTemplate,
  listGalleryTemplates,
} from './gallery-client';

// `requestWithAuth` の 401 再試行までは本題ではないので、Bearer を渡すだけの
// 素通しに差し替える。検査したいのは「この経路が Access 境界のホストへ出て、
// 身元が載るか」。
jest.mock('./auth', () => ({
  requestWithAuth: jest.fn(
    (fn: (headers: Record<string, string>) => Promise<unknown>) =>
      fn({ Authorization: 'Bearer test-token' }),
  ),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    headers: new Headers(),
    body: null,
  }) as unknown as Response;

const sent = (): { url: string; headers: Headers } => {
  const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  return { url, headers: new Headers(init.headers) };
};

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

const setAuth = (): void => {
  process.env[ID] = 'svc-token-id.access';
  process.env[SECRET] = 'svc-token-secret';
};

// PRJ-3-1580: `copy_gallery_template` が呼ぶ複製 API は、OAuth issuer と同じ
// ホスト (= Cloudflare Access 境界の内側) にある。#134 の対象は
// /register・/token だけだったので、ここには身元が載っていなかった。
describe('duplicateGalleryTemplate / Access service auth', () => {
  it('2 値が揃っていれば CF-Access-* を載せて複製 API を叩く', async () => {
    setAuth();
    mockFetch.mockResolvedValueOnce(okJson({ duplicatedFileId: 'design-1' }));

    await duplicateGalleryTemplate('ws-1', 'invoice-a');

    const { url, headers } = sent();
    // test-setup.ts の REPORTFLOW_AUTH_URL = http://localhost:3000/api/v1
    expect(url).toBe(
      'http://localhost:3000/api/v1/ws-1/my/templates/invoice-a/duplicate',
    );
    expect(headers.get('CF-Access-Client-Id')).toBe('svc-token-id.access');
    expect(headers.get('CF-Access-Client-Secret')).toBe('svc-token-secret');
    // 既存の必須ヘッダーを潰していない。
    expect(headers.get('Authorization')).toBe('Bearer test-token');
    expect(headers.get('app-key')).toBe('reportflow-mcp');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('2 値が無ければ従来どおりヘッダー無しで叩く', async () => {
    delete process.env[ID];
    delete process.env[SECRET];
    mockFetch.mockResolvedValueOnce(okJson({ duplicatedFileId: 'design-1' }));

    await duplicateGalleryTemplate('ws-1', 'invoice-a');

    expect(sent().headers.get('CF-Access-Client-Id')).toBeNull();
  });
});

// 判定はホスト一致で行うので、everyone bypass の /public/templates にも載る。
// bypass 側は身元を無視して通すので害は無く、パスで分けないぶん「新しい
// エンドポイントを一覧へ足し忘れる」面が生まれない。
describe('listGalleryTemplates / Access service auth', () => {
  it('同じホストなので公開ギャラリー API にもヘッダーが載る', async () => {
    setAuth();
    mockFetch.mockResolvedValueOnce(okJson({ items: [] }));

    await listGalleryTemplates();

    const { url, headers } = sent();
    expect(url).toContain('http://localhost:3000/api/v1/public/templates');
    expect(headers.get('CF-Access-Client-Id')).toBe('svc-token-id.access');
  });
});
