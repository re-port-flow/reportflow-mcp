/**
 * Slackbot MCP Client との OAuth・通信の互換性契約 (PRJ-3-2565 / Slack A2)。
 *
 * Slack の公式資料 (docs.slack.dev/ai/slackbot-mcp-client) が MCP サーバーに求める
 * ことを、Slack が実際に使う値で固定する。既存のテスト (http-server.spec.ts) は
 * claude.ai の値で同じ経路を見ているが、Slack 固有の失敗 (下の各 `it` に対応する
 * Slack 側のエラー名) が出ないことをここで 1 か所に集める。
 *
 * - Streamable HTTP のみ (SSE 形式の応答は可、旧 HTTP+SSE / stdio は不可)
 * - DCR: AS metadata に authorization / token / registration endpoint が要る
 *   (`dynamic_client_registration_missing_oauth_endpoints` /
 *   `dynamic_client_registration_not_supported`)
 * - DCR の redirect URI は `https://oauth2.slack.com/external/auth/callback` を
 *   受け付けること (`dynamic_client_registration_invalid_redirect_uri`)
 * - DCR の応答は client_id を持つ JSON (`dynamic_client_registration_invalid_response`)
 * - manual_auth の identity は MCP ホストの `/userinfo` (Access の外から届く)
 *
 * 実 Slack の protocol revision・DCR で送る scope・制限時間は、Slack App を作った
 * 後の実機検証 (H1) で確定する。ここでは**サーバーが満たすべき側**だけを固定する。
 *
 * 外部 HTTP はすべて mock。実データは送らない。
 */
import request from 'supertest';

import { buildHttpApp } from './http-server';
import {
  MCP_RESOURCE_URL,
  REPORTFLOW_OAUTH_ISSUER_URL,
  SUPPORTED_SCOPES,
} from './config';

/** Slack の External Auth のコールバック (Slack 公式資料の値)。 */
const SLACK_REDIRECT_URI = 'https://oauth2.slack.com/external/auth/callback';

const bodyOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      if (text !== '') controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

type FetchInit = {
  method: string;
  headers: Record<string, string>;
  body?: string;
};

describe('Slackbot MCP Client 互換 (PRJ-3-2565)', () => {
  const app = buildHttpApp();
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  const upstreamJson = (status: number, json: unknown): void => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        status,
        body: bodyOf(JSON.stringify(json)),
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
    );
  };
  const sentInit = (): FetchInit => fetchMock.mock.calls[0][1] as FetchInit;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('AS metadata は DCR に要る 3 endpoint を MCP ホスト上で広告し、PKCE S256・public client を示す', async () => {
    const res = await request(app)
      .get('/.well-known/oauth-authorization-server')
      .expect(200);

    expect(res.body.authorization_endpoint).toBe(
      `${MCP_RESOURCE_URL}/authorize`,
    );
    expect(res.body.token_endpoint).toBe(`${MCP_RESOURCE_URL}/token`);
    expect(res.body.registration_endpoint).toBe(`${MCP_RESOURCE_URL}/register`);
    expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
    // Slack の manifest は client secret を持たない (mcp_ 接頭辞 + PKCE)。
    expect(res.body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(res.body.grant_types_supported).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token']),
    );
    expect(res.body.scopes_supported).toEqual([...SUPPORTED_SCOPES]);
  });

  it('PRM は AS として MCP ホスト自身を指す (Slack が metadata を辿れる)', async () => {
    const res = await request(app)
      .get('/.well-known/oauth-protected-resource')
      .expect(200);
    expect(res.body.authorization_servers).toEqual([MCP_RESOURCE_URL]);
  });

  it('DCR: Slack の redirect URI と scope を書き換えずに上流へ渡し、client_id を返す', async () => {
    upstreamJson(201, {
      client_id: 'slack-generated',
      redirect_uris: [SLACK_REDIRECT_URI],
    });
    const registration = {
      client_name: 'Slack',
      redirect_uris: [SLACK_REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SUPPORTED_SCOPES.join(' '),
    };

    const res = await request(app)
      .post('/register')
      .send(registration)
      .expect(201);

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${REPORTFLOW_OAUTH_ISSUER_URL}/oauth/register`,
    );
    expect(JSON.parse(sentInit().body ?? '')).toEqual(registration);
    expect(res.body.client_id).toBe('slack-generated');
  });

  it('DCR: 上流が redirect URI を拒否した 400 (JSON) はそのまま返す (502 に化けない)', async () => {
    const error = {
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uri not allowed',
    };
    upstreamJson(400, error);
    const res = await request(app)
      .post('/register')
      .send({ redirect_uris: [SLACK_REDIRECT_URI] })
      .expect(400);
    expect(res.body).toEqual(error);
  });

  it('authorize: Slack の redirect URI・S256 の challenge・scope・state を変えずに上流へ 302', async () => {
    const res = await request(app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: 'slack-generated',
        redirect_uri: SLACK_REDIRECT_URI,
        code_challenge: 'challenge-value',
        code_challenge_method: 'S256',
        scope: SUPPORTED_SCOPES.join(' '),
        state: 'slack-state',
      })
      .expect(302);

    const upstream = new URL(res.headers.location);
    expect(`${upstream.origin}${upstream.pathname}`).toBe(
      `${REPORTFLOW_OAUTH_ISSUER_URL}/oauth/authorize`,
    );
    expect(upstream.searchParams.get('redirect_uri')).toBe(SLACK_REDIRECT_URI);
    expect(upstream.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(upstream.searchParams.get('code_challenge_method')).toBe('S256');
    expect(upstream.searchParams.get('scope')).toBe(SUPPORTED_SCOPES.join(' '));
    expect(upstream.searchParams.get('state')).toBe('slack-state');
  });

  it.each(['form', 'json'] as const)(
    'token (%s): code_verifier と redirect_uri を上流へ渡し、no-store で返す',
    async (encoding) => {
      upstreamJson(200, {
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      const res = await request(app)
        .post('/token')
        .type(encoding)
        .send({
          grant_type: 'authorization_code',
          code: 'code-1',
          code_verifier: 'verifier-1',
          redirect_uri: SLACK_REDIRECT_URI,
          client_id: 'slack-generated',
        })
        .expect(200);

      const sent = JSON.parse(sentInit().body ?? '') as Record<string, string>;
      expect(sent.code_verifier).toBe('verifier-1');
      expect(sent.redirect_uri).toBe(SLACK_REDIRECT_URI);
      expect(sent.client_id).toBe('slack-generated');
      expect(res.body.access_token).toBe('at');
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );

  it('refresh: refresh_token grant を上流へ渡す', async () => {
    upstreamJson(200, { access_token: 'at2', token_type: 'Bearer' });
    await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: 'rt',
        client_id: 'slack-generated',
      })
      .expect(200);
    const sent = JSON.parse(sentInit().body ?? '') as Record<string, string>;
    expect(sent.grant_type).toBe('refresh_token');
    expect(sent.refresh_token).toBe('rt');
  });

  it('identity (manual_auth): /userinfo は Bearer を上流 UserInfo へ渡し sub を返す', async () => {
    upstreamJson(200, { sub: 'user-1' });
    const res = await request(app)
      .get('/userinfo')
      .set('Authorization', 'Bearer at')
      .expect(200);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${REPORTFLOW_OAUTH_ISSUER_URL}/oauth/userinfo`,
    );
    expect(sentInit().headers.Authorization).toBe('Bearer at');
    expect(res.body.sub).toBe('user-1');
  });

  it('Streamable HTTP: POST /mcp の initialize に応答する (Accept: JSON と SSE)', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Host', new URL(MCP_RESOURCE_URL).host)
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'slackbot-compat-test', version: '0' },
        },
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"protocolVersion"');
    expect(res.text).toContain('reportflow-mcp');
  });
});
