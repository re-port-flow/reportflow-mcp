import request from 'supertest';
import { buildHttpApp } from './http-server';
import { MCP_RESOURCE_URL, REPORTFLOW_OAUTH_ISSUER_URL } from './config';

describe('http-server', () => {
  const app = buildHttpApp();

  describe('GET /healthz', () => {
    it('200 OK + status: ok を返す', async () => {
      const res = await request(app).get('/healthz').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /.well-known/oauth-protected-resource', () => {
    it('RFC 9728 形式の Protected Resource Metadata を返す', async () => {
      const res = await request(app)
        .get('/.well-known/oauth-protected-resource')
        .expect(200);
      expect(res.body.resource).toBe(MCP_RESOURCE_URL);
      expect(res.body.authorization_servers).toEqual([MCP_RESOURCE_URL]);
      expect(res.body.bearer_methods_supported).toEqual(['header']);
      expect(res.body.scopes_supported).toEqual(
        expect.arrayContaining(['openid', 'profile', 'pdf:generate']),
      );
    });

    it('Cache-Control が付与される', async () => {
      const res = await request(app).get(
        '/.well-known/oauth-protected-resource',
      );
      expect(res.headers['cache-control']).toContain('no-cache');
    });
  });

  describe('GET /.well-known/oauth-authorization-server', () => {
    it('registration_endpoint を含む AS metadata を返す', async () => {
      const res = await request(app)
        .get('/.well-known/oauth-authorization-server')
        .expect(200);
      expect(res.body.issuer).toBe(MCP_RESOURCE_URL);
      // registration_endpoint は MCP サーバー自身の /register プロキシを指す
      // (issuer と同一ドメインにすることでクライアントのドメインチェックに対応)
      expect(res.body.registration_endpoint).toBe(
        `${MCP_RESOURCE_URL}/register`,
      );
      expect(res.body.authorization_endpoint).toBe(
        `${MCP_RESOURCE_URL}/authorize`,
      );
      expect(res.body.token_endpoint).toBe(`${MCP_RESOURCE_URL}/token`);
      expect(res.body.code_challenge_methods_supported).toContain('S256');
    });

    it('Cache-Control が付与される', async () => {
      const res = await request(app).get(
        '/.well-known/oauth-authorization-server',
      );
      expect(res.headers['cache-control']).toContain('no-cache');
    });
  });

  describe('GET /authorize', () => {
    it('issuer の path prefix (/api/v1) を保持して 302 redirect する', async () => {
      const res = await request(app)
        .get('/authorize')
        .query({
          response_type: 'code',
          client_id: 'claude-ai-mcp',
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          code_challenge: 'abc',
          code_challenge_method: 'S256',
          state: 'st-1',
          scope: 'openid profile',
          resource: 'https://mcp.re-port-flow.com',
        });
      expect(res.status).toBe(302);
      const loc = res.headers.location ?? '';
      // /api/v1 が drop されないこと (PR #31 で発見した new URL leading slash bug の回帰防止)
      expect(loc).toContain(`${REPORTFLOW_OAUTH_ISSUER_URL}/oauth/authorize`);
      expect(loc).toContain('client_id=claude-ai-mcp');
      expect(loc).toContain('state=st-1');
    });
  });

  describe('POST /mcp 認可ガード', () => {
    it('保護対象メソッド (tools/call) を Bearer 無しで叩くと 401 + WWW-Authenticate', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_templates', arguments: {} },
        })
        .expect(401);

      expect(res.headers['www-authenticate']).toContain('Bearer');
      expect(res.headers['www-authenticate']).toContain(
        '/.well-known/oauth-protected-resource',
      );
      expect(res.body.error).toBe('invalid_token');
    });

    it('保護対象メソッドを Bearer 有りで叩くと 401 にはならない (上流処理は別問題)', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', 'Bearer dummy-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_templates', arguments: {} },
        });
      // 401 で弾かれていなければ HTTP 認可ガードの責務は果たしている。
      // (MCP transport 側の処理結果は本テストのスコープ外)
      expect(res.status).not.toBe(401);
    });

    it('非保護メソッド (initialize) は Bearer 無しでも 401 にしない', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        });
      expect(res.status).not.toBe(401);
    });

    it('バッチ JSON-RPC で1件でも保護対象が含まれていれば 401', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send([
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'list_templates', arguments: {} },
          },
        ])
        .expect(401);
      expect(res.body.error).toBe('invalid_token');
    });
  });

  describe('CORS', () => {
    it('OPTIONS で許可ヘッダが返る', async () => {
      const res = await request(app)
        .options('/mcp')
        .set('Origin', 'https://claude.ai')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,content-type');
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://claude.ai',
      );
      expect(
        (res.headers['access-control-allow-headers'] ?? '').toLowerCase(),
      ).toContain('authorization');
    });
  });

  describe('未定義パス', () => {
    it('GET /foo は 404 + not_found', async () => {
      const res = await request(app).get('/foo').expect(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });
  });
});
