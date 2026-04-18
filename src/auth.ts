import { fetchJson, HttpError } from './http.js';

type TokenResponse = {
  access_token: string;
  expires_in: number;
};

type CachedToken = {
  token: string;
  expiresAt: number;
};

// Token cache shared across all calls
let cachedToken: CachedToken | null = null;
// Inflight lock: prevents multiple concurrent token requests
let inflightRequest: Promise<string> | null = null;

const TOKEN_EXPIRY_BUFFER_MS = 60_000;

function getOAuth2Config() {
  const clientId = process.env['REPORTFLOW_CLIENT_ID'];
  const clientSecret = process.env['REPORTFLOW_CLIENT_SECRET'];
  const authUrl = process.env['REPORTFLOW_AUTH_URL'] ?? 'http://localhost:3000';

  if (!clientId || !clientSecret) {
    throw new Error(
      'REPORTFLOW_CLIENT_ID and REPORTFLOW_CLIENT_SECRET must be set for oauth2 mode.',
    );
  }

  return { clientId, clientSecret, authUrl };
}

async function fetchNewToken(): Promise<string> {
  const { clientId, clientSecret, authUrl } = getOAuth2Config();
  const url = new URL('/v1/oauth/token', authUrl).toString();

  const data = await fetchJson<TokenResponse>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const expiresAt =
    Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS;
  cachedToken = { token: data.access_token, expiresAt };
  return data.access_token;
}

async function getOAuth2Token(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  if (inflightRequest) {
    return inflightRequest;
  }

  inflightRequest = fetchNewToken().finally(() => {
    inflightRequest = null;
  });

  return inflightRequest;
}

export function invalidateToken(): void {
  cachedToken = null;
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const mode = process.env['REPORTFLOW_AUTH_MODE'] ?? 'appkey';

  if (mode === 'oauth2') {
    const token = await getOAuth2Token();
    return { Authorization: `Bearer ${token}` };
  }

  // appkey mode (default / backward compat)
  const appKey = process.env['REPORTFLOW_APP_KEY'];
  if (!appKey) {
    throw new Error('REPORTFLOW_APP_KEY must be set for appkey mode.');
  }
  return { appkey: appKey };
}

export async function requestWithAuth<T>(
  fn: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const headers = await getAuthHeaders();
  try {
    return await fn(headers);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      invalidateToken();
      const retryHeaders = await getAuthHeaders();
      return fn(retryHeaders);
    }
    throw err;
  }
}
