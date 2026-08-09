import open from 'open';
import { startCallbackServer } from './auth-server.js';
import { getHttpAuthContext } from './auth-context.js';
import { fetchJson, HttpError } from './http.js';
import { decodeJwtPayload } from './jwt.js';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from './pkce.js';
import { recordCredentialWorkspace } from './telemetry/workspace.js';
import { createTokenStore, TokenSet } from './token-store/index.js';

const DEFAULT_AUTH_URL = 'https://re-port-flow.com/api/v1';
// 公式 Re:port Flow MCP の OAuth client_id (Re:port Flow 側で配布済の Public client)。
// 環境変数 REPORTFLOW_CLIENT_ID で上書き可能。
const DEFAULT_CLIENT_ID = 'reportflow-mcp';
const DEFAULT_SCOPE =
  'openid profile designs:read designs:write templates:read templates:write pdf:generate';
const DEFAULT_CALLBACK_PORT = 53682;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

type OAuthConfig = {
  authBase: string;
  clientId: string;
  callbackPort: number;
  scope: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

export class AuthRequiredError extends Error {
  /**
   * 発生した経路。復旧手順が経路ごとに異なるため、message を組み立てた後も
   * 呼び出し側 (ツール層) が経路別の補足を出せるように保持する。
   * - stdio: `authenticate` ツールを呼べば復旧する (client_id は固定の seed クライアント)
   * - http: トークンを持つのはクライアント側 (claude.ai 等) なので、そちらでの再認可が必要
   */
  readonly mode: 'stdio' | 'http';

  constructor(detail?: string, mode: 'stdio' | 'http' = 'stdio') {
    const action =
      mode === 'http'
        ? 'クライアント側で OAuth トークンを再取得してください (claude.ai / n8n / Make 等の OAuth 設定を確認)'
        : 'authenticate ツールを呼び出してください';
    super(
      detail
        ? `再認証が必要です: ${detail}。${action}。`
        : `再認証が必要です。${action}。`,
    );
    this.name = 'AuthRequiredError';
    this.mode = mode;
  }
}

const ensureTrailingSlash = (s: string): string =>
  s.endsWith('/') ? s : `${s}/`;

const getOAuthConfig = (): OAuthConfig => {
  const authUrl = process.env['REPORTFLOW_AUTH_URL'] ?? DEFAULT_AUTH_URL;
  const clientId = process.env['REPORTFLOW_CLIENT_ID'] ?? DEFAULT_CLIENT_ID;

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
    callbackPort,
    scope: process.env['REPORTFLOW_SCOPE'] ?? DEFAULT_SCOPE,
  };
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

/**
 * telemetry 側へ「今どのワークスペースで動いているか」を伝える (PRJ-3-1093)。
 * トークンを load / save / clear するすべての経路から呼び、
 * `authenticate force=true` でのワークスペース切り替えにも追従させる。
 *
 * 旧バージョンが保存した TokenSet には workspaceId が無いことがあるので、
 * その場合は access token から読み直す。
 */
const rememberWorkspace = (tokens: TokenSet): void => {
  recordCredentialWorkspace(
    tokens.workspaceId ?? decodeJwtPayload(tokens.accessToken)?.workspace_id,
  );
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

const buildTokenRequestBody = (
  config: OAuthConfig,
  payload: Record<string, string>,
): string =>
  JSON.stringify({
    ...payload,
    client_id: config.clientId,
  });

const exchangeCode = async (
  config: OAuthConfig,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenSet> => {
  const url = new URL('oauth/token', config.authBase).toString();
  const body = buildTokenRequestBody(config, {
    grant_type: 'authorization_code',
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
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
  const body = buildTokenRequestBody(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
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
    // 再認証で別ワークスペースを選ぶ可能性があるため、先に忘れる。
    recordCredentialWorkspace(undefined);
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
  rememberWorkspace(tokens);

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
      rememberWorkspace(fresh);
      return fresh;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new AuthRequiredError(`refresh 失敗 (${detail})`);
    }
  }
  rememberWorkspace(tokens);
  return tokens;
};

export const getAuthHeaders = async (): Promise<Record<string, string>> => {
  // HTTP モード: AsyncLocalStorage に積まれた per-request token を優先利用する
  const httpCtx = getHttpAuthContext();
  if (httpCtx) {
    return { Authorization: `Bearer ${httpCtx.accessToken}` };
  }
  const tokens = await loadOrRefresh();
  return { Authorization: `Bearer ${tokens.accessToken}` };
};

/**
 * 現在の認証に紐づくワークスペースID (アクセストークン JWT の workspace_id
 * クレーム)。reposts-api のパス (/:workspaceId/...) を組み立てる用途で使う。
 *
 * 複製先ワークスペースはこの値（= 同意画面でユーザーが選んだワークスペース）
 * のみ。ツール引数からは受け取らない (PRJ-3-1238)。
 * トークン未保存・期限切れ時は loadOrRefresh 経由で AuthRequiredError を投げる。
 */
export const getAuthWorkspaceId = async (): Promise<string | undefined> => {
  const httpCtx = getHttpAuthContext();
  if (httpCtx) {
    return decodeJwtPayload(httpCtx.accessToken)?.workspace_id;
  }
  const tokens = await loadOrRefresh();
  return (
    tokens.workspaceId ?? decodeJwtPayload(tokens.accessToken)?.workspace_id
  );
};

export const requestWithAuth = async <T>(
  fn: (headers: Record<string, string>) => Promise<T>,
): Promise<T> => {
  const headers = await getAuthHeaders();
  // HTTP モードでは refresh は claude.ai 等の外部クライアントが担うため、
  // 401 を受けた場合はそのまま AuthRequiredError として上位に返す。
  const httpCtx = getHttpAuthContext();
  if (httpCtx) {
    try {
      return await fn(headers);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        throw new AuthRequiredError('上流 API が 401', 'http');
      }
      throw err;
    }
  }

  // stdio モード: 既存の OS keychain 経路 + ローカル refresh 再試行
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
        rememberWorkspace(fresh);
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
  recordCredentialWorkspace(undefined);
};
