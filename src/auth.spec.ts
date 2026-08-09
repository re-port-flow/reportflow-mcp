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
  getAuthWorkspaceId,
  requestWithAuth,
  clearAuth,
} from './auth.js';
import { HttpError } from './http.js';
import { runWithHttpAuth } from './auth-context.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const ENV_KEYS = [
  'REPORTFLOW_AUTH_URL',
  'REPORTFLOW_API_BASE_URL',
  'REPORTFLOW_CLIENT_ID',
  'REPORTFLOW_CALLBACK_PORT',
  'REPORTFLOW_SCOPE',
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

describe('HTTP mode (per-request Bearer via AsyncLocalStorage)', () => {
  it('getAuthHeaders uses the per-request token and never touches the store', async () => {
    const headers = await runWithHttpAuth({ accessToken: 'http-tok' }, () =>
      getAuthHeaders(),
    );
    expect(headers).toEqual({ Authorization: 'Bearer http-tok' });
    expect(mockStore.load).not.toHaveBeenCalled();
  });

  it('requestWithAuth runs fn with the per-request bearer', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await runWithHttpAuth({ accessToken: 'http-tok' }, () =>
      requestWithAuth(fn),
    );
    expect(result).toEqual('ok');
    expect(fn).toHaveBeenCalledWith({ Authorization: 'Bearer http-tok' });
  });

  it('requestWithAuth maps an upstream 401 to AuthRequiredError (no local refresh)', async () => {
    const fn = jest.fn().mockRejectedValue(new HttpError(401, 'Unauthorized'));
    await expect(
      runWithHttpAuth({ accessToken: 'http-tok' }, () => requestWithAuth(fn)),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    // HTTP モードでは refresh はクライアント側の責務なのでローカル store は触らない
    expect(mockStore.load).not.toHaveBeenCalled();
  });

  it('requestWithAuth rethrows non-401 errors in HTTP mode', async () => {
    const fn = jest.fn().mockRejectedValue(new HttpError(500, 'Boom'));
    await expect(
      runWithHttpAuth({ accessToken: 'http-tok' }, () => requestWithAuth(fn)),
    ).rejects.toThrow('Boom');
  });
});

describe('getAuthWorkspaceId', () => {
  const jwtWithWorkspace = (workspaceId: string): string => {
    const payload = Buffer.from(
      JSON.stringify({ workspace_id: workspaceId }),
    ).toString('base64url');
    return `header.${payload}.sig`;
  };

  it('HTTP モード: per-request Bearer の JWT から workspace_id を取り出し store を触らない', async () => {
    const wsId = await runWithHttpAuth(
      { accessToken: jwtWithWorkspace('ws-http') },
      () => getAuthWorkspaceId(),
    );
    expect(wsId).toEqual('ws-http');
    expect(mockStore.load).not.toHaveBeenCalled();
  });

  it('stdio モード: 保存済みトークンの workspaceId を返す', async () => {
    mockStore.load.mockResolvedValueOnce(baseTokens({ workspaceId: 'ws-saved' }));
    const wsId = await getAuthWorkspaceId();
    expect(wsId).toEqual('ws-saved');
  });

  it('stdio モード: workspaceId 未保持なら access token の JWT から復元する', async () => {
    mockStore.load.mockResolvedValueOnce(
      // 旧バージョンが保存した workspaceId 無しの TokenSet を再現
      baseTokens({ workspaceId: undefined, accessToken: jwtWithWorkspace('ws-jwt') }),
    );
    const wsId = await getAuthWorkspaceId();
    expect(wsId).toEqual('ws-jwt');
  });

  it('stdio モード: トークン未保存なら AuthRequiredError を投げる', async () => {
    mockStore.load.mockResolvedValueOnce(null);
    await expect(getAuthWorkspaceId()).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('JWT workspace extraction', () => {
  it('extracts workspace_id from a valid JWT access token payload', async () => {
    const payload = Buffer.from(
      JSON.stringify({ workspace_id: 'ws-123' }),
    ).toString('base64url');
    const jwt = `header.${payload}.sig`;
    mockStartCallbackServer.mockResolvedValueOnce({ code: 'c' });
    mockOpen.mockResolvedValueOnce(undefined);
    mockFetch.mockResolvedValueOnce(tokenJsonResponse(jwt));
    const result = await authorize();
    expect(result.workspaceId).toEqual('ws-123');
  });

  it('leaves workspaceId undefined when the JWT payload is not valid JSON', async () => {
    const payload = Buffer.from('not-json').toString('base64url');
    const jwt = `header.${payload}.sig`;
    mockStartCallbackServer.mockResolvedValueOnce({ code: 'c' });
    mockOpen.mockResolvedValueOnce(undefined);
    mockFetch.mockResolvedValueOnce(tokenJsonResponse(jwt));
    const result = await authorize();
    expect(result.workspaceId).toBeUndefined();
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
  it('falls back to production AUTH_URL when REPORTFLOW_AUTH_URL is unset', async () => {
    delete process.env['REPORTFLOW_AUTH_URL'];
    mockStartCallbackServer.mockResolvedValueOnce({ code: 'c' });
    mockOpen.mockResolvedValueOnce(undefined);
    mockFetch.mockResolvedValueOnce(tokenJsonResponse('t'));
    await authorize();
    const url = mockOpen.mock.calls[0][0];
    expect(url).toContain('https://re-port-flow.com/api/v1/oauth/authorize');
  });
  it('falls back to DEFAULT_CLIENT_ID when REPORTFLOW_CLIENT_ID is unset', async () => {
    delete process.env['REPORTFLOW_CLIENT_ID'];
    mockStartCallbackServer.mockResolvedValueOnce({ code: 'c' });
    mockOpen.mockResolvedValueOnce(undefined);
    mockFetch.mockResolvedValueOnce(tokenJsonResponse('t'));
    await authorize();
    const url = mockOpen.mock.calls[0][0];
    expect(url).toContain('client_id=reportflow-mcp');
  });
  it('throws when REPORTFLOW_CALLBACK_PORT is not a positive integer', async () => {
    process.env['REPORTFLOW_CALLBACK_PORT'] = 'not-a-port';
    await expect(authorize()).rejects.toThrow(
      'REPORTFLOW_CALLBACK_PORT must be a positive integer',
    );
    delete process.env['REPORTFLOW_CALLBACK_PORT'];
  });
  it('never sends client_secret in token request body (Public client only)', async () => {
    mockStartCallbackServer.mockResolvedValueOnce({ code: 'c' });
    mockOpen.mockResolvedValueOnce(undefined);
    mockFetch.mockResolvedValueOnce(tokenJsonResponse('t'));
    await authorize();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0][1] as { body: string };
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body['client_id']).toEqual('cid');
    expect(body['client_secret']).toBeUndefined();
    expect(body['code_verifier']).toBeDefined();
  });
});
