import { getAuthHeaders, invalidateToken, requestWithAuth } from './auth';
import { HttpError } from './http';

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockTokenResponse(token: string, expiresIn = 3600) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ access_token: token, expires_in: expiresIn }),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  });
}

const MANAGED_ENV_KEYS = [
  'REPORTFLOW_AUTH_MODE',
  'REPORTFLOW_APP_KEY',
  'REPORTFLOW_CLIENT_ID',
  'REPORTFLOW_CLIENT_SECRET',
  'REPORTFLOW_AUTH_URL',
] as const;

beforeEach(() => {
  global.fetch = mockFetch;
  jest.clearAllMocks();
  invalidateToken();
  MANAGED_ENV_KEYS.forEach((key) => delete process.env[key]);
});

describe('getAuthHeaders — appkey mode', () => {
  beforeEach(() => {
    process.env['REPORTFLOW_AUTH_MODE'] = 'appkey';
  });

  it('REPORTFLOW_APP_KEY を appkey ヘッダとして返す', async () => {
    process.env['REPORTFLOW_APP_KEY'] = 'my-app-key';
    const headers = await getAuthHeaders();
    expect(headers).toEqual({ appkey: 'my-app-key' });
  });

  it('REPORTFLOW_APP_KEY 未設定時にエラーを投げる', async () => {
    delete process.env['REPORTFLOW_APP_KEY'];
    await expect(getAuthHeaders()).rejects.toThrow('REPORTFLOW_APP_KEY must be set');
  });
});

describe('getAuthHeaders — oauth2 mode', () => {
  beforeEach(() => {
    process.env['REPORTFLOW_AUTH_MODE'] = 'oauth2';
    process.env['REPORTFLOW_CLIENT_ID'] = 'client-id';
    process.env['REPORTFLOW_CLIENT_SECRET'] = 'client-secret';
    process.env['REPORTFLOW_AUTH_URL'] = 'http://localhost:3000';
  });

  it('トークンを取得して Bearer ヘッダを返す', async () => {
    mockTokenResponse('access-token-123');
    const headers = await getAuthHeaders();
    expect(headers).toEqual({ Authorization: 'Bearer access-token-123' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/v1/oauth/token');
  });

  it('2回目はキャッシュを使い fetch を呼ばない', async () => {
    mockTokenResponse('cached-token');
    await getAuthHeaders();
    const headers = await getAuthHeaders();
    expect(headers).toEqual({ Authorization: 'Bearer cached-token' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('キャッシュ期限切れ時に再取得する', async () => {
    // expires_in=0 → expiresAt = now - TOKEN_EXPIRY_BUFFER_MS (過去) → 即失効
    mockTokenResponse('old-token', 0);
    await getAuthHeaders();

    mockTokenResponse('new-token');
    const headers = await getAuthHeaders();
    expect(headers).toEqual({ Authorization: 'Bearer new-token' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('並列呼び出し時に fetch は1回のみ実行される (inflight lock)', async () => {
    let resolveToken!: (v: unknown) => void;
    const delayedFetch = jest.fn().mockReturnValueOnce(
      new Promise((resolve) => {
        resolveToken = resolve;
      }),
    );
    global.fetch = delayedFetch;

    try {
      const [p1, p2] = [getAuthHeaders(), getAuthHeaders()];

      resolveToken({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ access_token: 'shared-token', expires_in: 3600 }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });

      const [h1, h2] = await Promise.all([p1, p2]);
      expect(h1).toEqual({ Authorization: 'Bearer shared-token' });
      expect(h2).toEqual({ Authorization: 'Bearer shared-token' });
      expect(delayedFetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = mockFetch;
    }
  });

  it('REPORTFLOW_CLIENT_ID 未設定時にエラーを投げる', async () => {
    delete process.env['REPORTFLOW_CLIENT_ID'];
    await expect(getAuthHeaders()).rejects.toThrow(
      'REPORTFLOW_CLIENT_ID and REPORTFLOW_CLIENT_SECRET must be set',
    );
  });

  it('REPORTFLOW_CLIENT_SECRET 未設定時にエラーを投げる', async () => {
    delete process.env['REPORTFLOW_CLIENT_SECRET'];
    await expect(getAuthHeaders()).rejects.toThrow(
      'REPORTFLOW_CLIENT_ID and REPORTFLOW_CLIENT_SECRET must be set',
    );
  });
});

describe('requestWithAuth', () => {
  beforeEach(() => {
    process.env['REPORTFLOW_AUTH_MODE'] = 'appkey';
    process.env['REPORTFLOW_APP_KEY'] = 'my-app-key';
  });

  it('fn を auth ヘッダ付きで呼び出し結果を返す', async () => {
    const fn = jest.fn().mockResolvedValue('result');
    const result = await requestWithAuth(fn);
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledWith({ appkey: 'my-app-key' });
  });

  it('401 エラー時にキャッシュを無効化して1回だけリトライする', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new HttpError(401, '[401] Unauthorized'))
      .mockResolvedValueOnce('retry-result');

    const result = await requestWithAuth(fn);
    expect(result).toBe('retry-result');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('401 以外の HttpError はリトライせず再スローする', async () => {
    const fn = jest.fn().mockRejectedValue(new HttpError(500, '[500] Server Error'));
    await expect(requestWithAuth(fn)).rejects.toThrow('[500] Server Error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('HttpError 以外のエラーはリトライせず再スローする', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('Network error'));
    await expect(requestWithAuth(fn)).rejects.toThrow('Network error');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
