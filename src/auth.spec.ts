import { TokenSet } from './token-store/types.js';

const mockStore = {
  kind: 'file' as const,
  load: jest.fn<Promise<TokenSet | null>, [string]>(),
  save: jest.fn<Promise<void>, [string, TokenSet]>(),
  clear: jest.fn<Promise<void>, [string]>(),
};
const mockStartCallbackServer = jest.fn<Promise<{ code: string }>, [unknown]>();
const mockOpen = jest.fn<Promise<unknown>, [string]>();

jest.mock('./token-store/index.js', () => ({
  createTokenStore: () => mockStore,
}));
jest.mock('./auth-server.js', () => ({
  startCallbackServer: (opts: unknown) => mockStartCallbackServer(opts),
}));
jest.mock('open', () => ({
  __esModule: true,
  default: (url: string) => mockOpen(url),
}));

import {
  AuthRequiredError,
  authorize,
  getAuthHeaders,
  requestWithAuth,
  clearAuth,
} from './auth.js';
import { HttpError } from './http.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const ENV_KEYS = [
  'REPORTFLOW_AUTH_URL',
  'REPORTFLOW_API_BASE_URL',
  'REPORTFLOW_CLIENT_ID',
  'REPORTFLOW_CLIENT_SECRET',
  'REPORTFLOW_CALLBACK_PORT',
  'REPORTFLOW_SCOPE',
  'REPORTFLOW_AUTH_MODE',
  'REPORTFLOW_APP_KEY',
] as const;

const baseTokens = (override: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'jwt.placeholder.signature',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3600_000,
  scope: 'openid',
  workspaceId: '00000000-0000-0000-0000-000000000000',
  ...override,
});

const tokenJsonResponse = (
  token: string,
  expiresIn = 3600,
  refresh = 'r-new',
): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () =>
      Promise.resolve({
        access_token: token,
        refresh_token: refresh,
        expires_in: expiresIn,
        scope: 'openid',
      }),
  }) as unknown as Response;

beforeEach(() => {
  jest.clearAllMocks();
  ENV_KEYS.forEach((k) => delete process.env[k]);
  process.env['REPORTFLOW_AUTH_URL'] = 'https://example.test/api/v1';
  process.env['REPORTFLOW_CLIENT_ID'] = 'cid';
  process.env['REPORTFLOW_CLIENT_SECRET'] = 'csecret';
  mockStore.load.mockReset();
  mockStore.save.mockReset();
  mockStore.clear.mockReset();
  mockStore.save.mockResolvedValue(undefined);
  mockStore.clear.mockResolvedValue(undefined);
});

describe('getAuthHeaders', () => {
  it('returns Bearer header when token is fresh', async () => {
    mockStore.load.mockResolvedValueOnce(baseTokens());
    const headers = await getAuthHeaders();
    expect(headers).toEqual({
      Authorization: 'Bearer jwt.placeholder.signature',
    });
    expect(mockStore.save).not.toHaveBeenCalled();
  });

  it('throws AuthRequiredError when no token saved', async () => {
    mockStore.load.mockResolvedValueOnce(null);
    await expect(getAuthHeaders()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('refreshes when expiresAt is past, then returns new bearer', async () => {
    mockStore.load.mockResolvedValueOnce(
      baseTokens({ expiresAt: Date.now() - 1, refreshToken: 'r-old' }),
    );
    mockFetch.mockResolvedValueOnce(
      tokenJsonResponse('new-jwt', 3600, 'r-new'),
    );
    const headers = await getAuthHeaders();
    expect(headers).toEqual({ Authorization: 'Bearer new-jwt' });
    expect(mockStore.save).toHaveBeenCalledTimes(1);
    const [, savedTokens] = mockStore.save.mock.calls[0];
    expect(savedTokens.accessToken).toEqual('new-jwt');
    expect(savedTokens.refreshToken).toEqual('r-new');
  });

  it('throws AuthRequiredError when refresh fails', async () => {
    mockStore.load.mockResolvedValueOnce(
      baseTokens({ expiresAt: Date.now() - 1 }),
    );
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: 'invalid_grant' }),
    } as unknown as Response);
    await expect(getAuthHeaders()).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('requestWithAuth', () => {
  it('runs fn with auth headers', async () => {
    mockStore.load.mockResolvedValueOnce(baseTokens());
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await requestWithAuth(fn);
    expect(result).toEqual('ok');
    expect(fn).toHaveBeenCalledWith({
      Authorization: 'Bearer jwt.placeholder.signature',
    });
  });

  it('on 401, refreshes via refresh_token and retries fn once', async () => {
    mockStore.load
      .mockResolvedValueOnce(baseTokens({ accessToken: 'old' }))
      .mockResolvedValueOnce(baseTokens({ accessToken: 'old' }));
    mockFetch.mockResolvedValueOnce(tokenJsonResponse('refreshed', 3600));
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new HttpError(401, 'Unauthorized'))
      .mockResolvedValueOnce('after-refresh');
    const result = await requestWithAuth(fn);
    expect(result).toEqual('after-refresh');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1][0]).toEqual({
      Authorization: 'Bearer refreshed',
    });
  });

  it('throws AuthRequiredError when 401 and refresh also fails', async () => {
    mockStore.load
      .mockResolvedValueOnce(baseTokens())
      .mockResolvedValueOnce(baseTokens());
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: 'invalid_grant' }),
    } as unknown as Response);
    const fn = jest.fn().mockRejectedValue(new HttpError(401, 'Unauthorized'));
    await expect(requestWithAuth(fn)).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('non-401 HttpError is rethrown without retry', async () => {
    mockStore.load.mockResolvedValueOnce(baseTokens());
    const fn = jest.fn().mockRejectedValue(new HttpError(500, 'Boom'));
    await expect(requestWithAuth(fn)).rejects.toThrow('Boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('authorize (PKCE flow)', () => {
  it('runs full PKCE flow and saves tokens', async () => {
    mockStartCallbackServer.mockResolvedValueOnce({ code: 'authcode' });
    mockOpen.mockResolvedValueOnce(undefined);
    mockFetch.mockResolvedValueOnce(tokenJsonResponse('newjwt', 3600, 'rt'));
    const result = await authorize();
    expect(mockOpen).toHaveBeenCalledTimes(1);
    const url = mockOpen.mock.calls[0][0];
    expect(url).toContain('https://example.test/api/v1/oauth/authorize');
    expect(url).toContain('response_type=code');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('client_id=cid');
    expect(mockStore.save).toHaveBeenCalledTimes(1);
    const [account, tokens] = mockStore.save.mock.calls[0];
    expect(account).toEqual('cid');
    expect(tokens.accessToken).toEqual('newjwt');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('clears existing token when force=true', async () => {
    mockStartCallbackServer.mockResolvedValueOnce({ code: 'c' });
    mockOpen.mockResolvedValueOnce(undefined);
    mockFetch.mockResolvedValueOnce(tokenJsonResponse('t'));
    await authorize({ force: true });
    expect(mockStore.clear).toHaveBeenCalledWith('cid');
  });

  it('uses default callback port 53682 when REPORTFLOW_CALLBACK_PORT unset', async () => {
    mockStartCallbackServer.mockResolvedValueOnce({ code: 'c' });
    mockOpen.mockResolvedValueOnce(undefined);
    mockFetch.mockResolvedValueOnce(tokenJsonResponse('t'));
    await authorize();
    const startOpts = mockStartCallbackServer.mock.calls[0][0] as {
      port: number;
    };
    expect(startOpts.port).toEqual(53682);
  });
});

describe('clearAuth', () => {
  it('clears the token store entry for current client_id', async () => {
    await clearAuth();
    expect(mockStore.clear).toHaveBeenCalledWith('cid');
  });
});

describe('config validation', () => {
  it('throws when REPORTFLOW_AUTH_URL is missing', async () => {
    delete process.env['REPORTFLOW_AUTH_URL'];
    await expect(getAuthHeaders()).rejects.toThrow(
      'REPORTFLOW_AUTH_URL is required',
    );
  });
  it('throws when REPORTFLOW_CLIENT_ID is missing', async () => {
    delete process.env['REPORTFLOW_CLIENT_ID'];
    await expect(getAuthHeaders()).rejects.toThrow(
      'REPORTFLOW_CLIENT_ID is required',
    );
  });
  it('throws when REPORTFLOW_CLIENT_SECRET is missing', async () => {
    delete process.env['REPORTFLOW_CLIENT_SECRET'];
    await expect(getAuthHeaders()).rejects.toThrow(
      'REPORTFLOW_CLIENT_SECRET is required',
    );
  });
});
