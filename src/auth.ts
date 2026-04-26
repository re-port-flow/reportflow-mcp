import open from 'open';
import { startCallbackServer } from './auth-server.js';
import { fetchJson, HttpError } from './http.js';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from './pkce.js';
import { createTokenStore, TokenSet } from './token-store/index.js';

const DEFAULT_AUTH_URL = 'https://re-port-flow.com/api/v1';
const DEFAULT_SCOPE =
  'openid profile designs:read designs:write templates:read templates:write pdf:generate';
const DEFAULT_CALLBACK_PORT = 53682;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

type OAuthConfig = {
  authBase: string;
  clientId: string;
  clientSecret: string;
  callbackPort: number;
  scope: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

type JwtPayload = {
  workspace_id?: string;
};

export class AuthRequiredError extends Error {
  constructor(detail?: string) {
    super(
      detail
        ? `再認証が必要です: ${detail}。authenticate ツールを呼び出してください。`
        : '再認証が必要です。authenticate ツールを呼び出してください。',
    );
    this.name = 'AuthRequiredError';
  }
}

const ensureTrailingSlash = (s: string): string =>
  s.endsWith('/') ? s : `${s}/`;

const getOAuthConfig = (): OAuthConfig => {
  const authUrl = process.env['REPORTFLOW_AUTH_URL'] ?? DEFAULT_AUTH_URL;
  const clientId = process.env['REPORTFLOW_CLIENT_ID'];
  const clientSecret = process.env['REPORTFLOW_CLIENT_SECRET'];
  if (!clientId) throw new Error('REPORTFLOW_CLIENT_ID is required');
  if (!clientSecret) throw new Error('REPORTFLOW_CLIENT_SECRET is required');

  const portStr = process.env['REPORTFLOW_CALLBACK_PORT'];
  const callbackPort = portStr ? parseInt(portStr, 10) : DEFAULT_CALLBACK_PORT;
  if (Number.isNaN(callbackPort) || callbackPort <= 0) {
    throw new Error(
      `REPORTFLOW_CALLBACK_PORT must be a positive integer (got ${portStr})`,
    );
  }

  return {
    authBase: ensureTrailingSlash(authUrl),
    clientId,
    clientSecret,
    callbackPort,
    scope: process.env['REPORTFLOW_SCOPE'] ?? DEFAULT_SCOPE,
  };
};

const decodeJwtPayload = (jwt: string): JwtPayload | null => {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
};

const toTokenSet = (
  resp: TokenResponse,
  fallbackRefresh: string,
  fallbackScope: string,
): TokenSet => {
  const payload = decodeJwtPayload(resp.access_token);
  return {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token ?? fallbackRefresh,
    expiresAt: Date.now() + resp.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS,
    scope: resp.scope ?? fallbackScope,
    workspaceId: payload?.workspace_id,
  };
};

const buildAuthorizeUrl = (
  config: OAuthConfig,
  params: { codeChallenge: string; state: string; redirectUri: string },
): string => {
  const url = new URL('oauth/authorize', config.authBase);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
};

const exchangeCode = async (
  config: OAuthConfig,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenSet> => {
  const url = new URL('oauth/token', config.authBase).toString();
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const resp = await fetchJson<TokenResponse>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return toTokenSet(resp, '', config.scope);
};

const refreshTokens = async (
  config: OAuthConfig,
  refreshToken: string,
): Promise<TokenSet> => {
  const url = new URL('oauth/token', config.authBase).toString();
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const resp = await fetchJson<TokenResponse>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return toTokenSet(resp, refreshToken, config.scope);
};

export type AuthorizeOptions = {
  force?: boolean;
};

export type AuthorizeResult = {
  workspaceId?: string;
  scope: string;
  expiresAt: number;
};

export const authorize = async (
  options: AuthorizeOptions = {},
): Promise<AuthorizeResult> => {
  const config = getOAuthConfig();
  const store = createTokenStore();
  if (options.force) {
    await store.clear(config.clientId).catch(() => undefined);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const redirectUri = `http://localhost:${config.callbackPort}/callback`;
  const authorizeUrl = buildAuthorizeUrl(config, {
    codeChallenge,
    state,
    redirectUri,
  });

  const callbackPromise = startCallbackServer({
    port: config.callbackPort,
    expectedState: state,
  });

  await open(authorizeUrl);
  const { code } = await callbackPromise;
  const tokens = await exchangeCode(config, {
    code,
    codeVerifier,
    redirectUri,
  });
  await store.save(config.clientId, tokens);

  return {
    workspaceId: tokens.workspaceId,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
  };
};

const loadOrRefresh = async (): Promise<TokenSet> => {
  const config = getOAuthConfig();
  const store = createTokenStore();
  const tokens = await store.load(config.clientId);
  if (!tokens) {
    throw new AuthRequiredError('トークン未保存');
  }
  if (Date.now() >= tokens.expiresAt) {
    try {
      const fresh = await refreshTokens(config, tokens.refreshToken);
      await store.save(config.clientId, fresh);
      return fresh;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new AuthRequiredError(`refresh 失敗 (${detail})`);
    }
  }
  return tokens;
};

export const getAuthHeaders = async (): Promise<Record<string, string>> => {
  const tokens = await loadOrRefresh();
  return { Authorization: `Bearer ${tokens.accessToken}` };
};

export const requestWithAuth = async <T>(
  fn: (headers: Record<string, string>) => Promise<T>,
): Promise<T> => {
  const headers = await getAuthHeaders();
  try {
    return await fn(headers);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      const config = getOAuthConfig();
      const store = createTokenStore();
      const cached = await store.load(config.clientId);
      if (!cached) throw new AuthRequiredError('401 後にトークン無し');
      try {
        const fresh = await refreshTokens(config, cached.refreshToken);
        await store.save(config.clientId, fresh);
        return await fn({ Authorization: `Bearer ${fresh.accessToken}` });
      } catch (refreshErr) {
        const detail =
          refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        throw new AuthRequiredError(`401 後の refresh 失敗 (${detail})`);
      }
    }
    throw err;
  }
};

export const clearAuth = async (): Promise<void> => {
  const config = getOAuthConfig();
  const store = createTokenStore();
  await store.clear(config.clientId).catch(() => undefined);
};
