import request from 'supertest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import {
  buildHttpApp,
  isAllowedHost,
  isRejectableOrigin,
  parsePort,
} from './http-server';
import { MCP_RESOURCE_URL, REPORTFLOW_OAUTH_ISSUER_URL } from './config';

describe('parsePort', () => {
  it('returns undefined when PORT is unset', () => {
    expect(parsePort(undefined)).toBeUndefined();
  });

  it('returns undefined when PORT is an empty string', () => {
    expect(parsePort('')).toBeUndefined();
  });

  it('parses a valid positive integer', () => {
    expect(parsePort('8080')).toBe(8080);
  });

  it('trims surrounding whitespace', () => {
    expect(parsePort(' 8080 ')).toBe(8080);
  });

  it('throws when PORT is not a number', () => {
    expect(() => parsePort('abc')).toThrow(
      'PORT must be an integer in the range 1-65535 (got abc)',
    );
  });

  it('throws when PORT is zero', () => {
    expect(() => parsePort('0')).toThrow(
      'PORT must be an integer in the range 1-65535 (got 0)',
    );
  });

  it('throws when PORT is negative', () => {
    expect(() => parsePort('-1')).toThrow(
      'PORT must be an integer in the range 1-65535 (got -1)',
    );
  });

  it('throws when PORT exceeds 65535', () => {
    expect(() => parsePort('65536')).toThrow(
      'PORT must be an integer in the range 1-65535 (got 65536)',
    );
  });

  it('throws when PORT is a float', () => {
    expect(() => parsePort('8080.5')).toThrow(
      'PORT must be an integer in the range 1-65535 (got 8080.5)',
    );
  });

  it('throws when PORT has trailing non-numeric characters', () => {
    expect(() => parsePort('8080abc')).toThrow(
      'PORT must be an integer in the range 1-65535 (got 8080abc)',
    );
  });
});

describe('isAllowedHost (MCP spec §Security: DNS rebinding 対策)', () => {
  it.each([
    'mcp.re-port-flow.com', // MCP_RESOURCE_URL のホスト (テストは NODE_ENV=test = prod 扱い)
    'mcp.re-port-flow.com:443', // ポート付き表記は hostname 一致で許可 (port-agnostic)
    'MCP.RE-PORT-FLOW.COM', // hostname は大文字小文字非区別 (URL パースで正規化)
    'localhost',
    'localhost:5173',
    '127.0.0.1:3000',
    '[::1]:3000',
  ])('許可: %s', (host) => {
    expect(isAllowedHost(host)).toBe(true);
  });

  it.each([
    'evil.example',
    'evil.example:443',
    'mcp.re-port-flow.com.evil.example', // suffix 偽装
    '10.0.0.1:3000', // ALB ヘルスチェック相当の Host (MCP エンドポイントでは拒否)
    '127.0.0.2', // localhost 系は完全一致のみ
  ])('拒否: %s', (host) => {
    expect(isAllowedHost(host)).toBe(false);
  });

  it('Host 欠落 (undefined) は拒否する', () => {
    expect(isAllowedHost(undefined)).toBe(false);
  });

  it('空文字 / パース不能 Host は拒否する', () => {
    expect(isAllowedHost('')).toBe(false);
    expect(isAllowedHost('bad host name')).toBe(false);
  });
});

describe('isRejectableOrigin (MCP spec §Security: 構造検証のみ)', () => {
  it.each([
    undefined, // Origin を送らないネイティブクライアント
    'null', // sandboxed iframe 等の opaque origin (PRJ-3-1115: 許容に倒す)
    'https://claude.ai',
    'http://localhost:6274', // MCP Inspector
    'http://[::1]:6274', // IPv6 ホストの serialized origin
    'https://example.com:8443', // ポート付き serialized origin
    'chrome-extension://abcdefg', // 拡張ページの fetch が実際に送る serialized origin (非特殊スキーム)
    'capacitor://localhost', // WebView シェルのアプリ内スキーム (denylist 方式のため許可される)
    'https://xn--fiq228c.example', // IDN punycode ホスト
  ])('許可 (拒否しない): %s', (origin) => {
    expect(isRejectableOrigin(origin)).toBe(false);
  });

  it.each([
    '', // present but empty (Node は空値ヘッダーを '' で公開する。欠落 undefined とは区別)
    'http://[invalid', // ブラケット不整合 (raw 文法不一致)
    'not a url',
    // 以下は URL としてはパース可能だが serialized origin (RFC 6454) の形ではない
    'https://example.com/path', // path 付き
    'https://claude.ai/', // 末尾スラッシュ (raw 文法検証のため拒否できる。実ブラウザは送らない)
    'https://user@example.com', // userinfo 付き
    'https://example.com?q=1', // query 付き
    'https://example.com#frag', // fragment 付き
    'data:text/plain,x', // data: URL は origin ではない
    // authority 成分が無い形 (WHATWG パーサーの受理・正規化に依らず拒否)
    'https:example.com', // '://' 無し (パーサーは https://example.com/ に正規化する)
    'foo:', // scheme のみ
    'file:///', // host 空
    // パース中の正規化・空デリミタ除去で成分検査をすり抜ける形 (raw 文法で拒否)
    'https://example.com/.', // dot segment → パーサーは pathname '/' に正規化
    'https://example.com/..',
    'https://example.com/%2e', // %2e = '.' の pct-encode。同上
    'https://@example.com', // 空 userinfo デリミタ
    'https://example.com?', // 空 query デリミタ
    'https://example.com:', // 空 port デリミタ
    'https://example.com:99999', // 文法一致だがポートレンジ外 (new URL が throw)
    // opaque origin にしかなり得ないスキームに `//host` を付けた偽装 (raw 文法には一致する)
    'data://evil',
    'file://evil',
    'javascript://evil',
    'blob://evil',
    'urn://evil', // IANA 登録済み非 authority スキームも同様に拒否
    'tel://evil',
  ])('拒否: %s', (origin) => {
    expect(isRejectableOrigin(origin)).toBe(true);
  });
});

describe('http-server', () => {
  const app = buildHttpApp();

  describe('GET /healthz', () => {
    it('200 OK + status: ok を返す', async () => {
      const res = await request(app).get('/healthz').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /favicon.ico', () => {
    it('200 + image Content-Type + 非空 body を返す', async () => {
      const res = await request(app).get('/favicon.ico').expect(200);
      expect(res.headers['content-type']).toContain('image/');
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('Cache-Control が付与される', async () => {
      const res = await request(app).get('/favicon.ico');
      expect(res.headers['cache-control']).toContain('max-age=');
    });
  });

  describe('GET /favicon.svg', () => {
    it('200 + image/svg+xml を返す', async () => {
      const res = await request(app).get('/favicon.svg').expect(200);
      expect(res.headers['content-type']).toContain('image/svg+xml');
      expect(res.body.length).toBeGreaterThan(0);
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

  describe('GET /.well-known/openai-apps-challenge (ChatGPT Apps ドメイン所有確認)', () => {
    const KEY = 'OPENAI_APPS_CHALLENGE_TOKEN';
    const original = process.env[KEY];
    afterEach(() => {
      if (original === undefined) delete process.env[KEY];
      else process.env[KEY] = original;
    });

    it('トークン設定時は 200 + text/plain でトークンそのままを返す', async () => {
      process.env[KEY] = 'challenge-token-abc123';
      const res = await request(app)
        .get('/.well-known/openai-apps-challenge')
        .expect(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toBe('challenge-token-abc123');
    });

    it('前後の空白は trim して返す (改行混入による検証失敗を防ぐ)', async () => {
      process.env[KEY] = '  spaced-token\n';
      const res = await request(app)
        .get('/.well-known/openai-apps-challenge')
        .expect(200);
      expect(res.text).toBe('spaced-token');
    });

    it('Cache-Control が付与される', async () => {
      process.env[KEY] = 'tok';
      const res = await request(app).get('/.well-known/openai-apps-challenge');
      expect(res.headers['cache-control']).toContain('no-cache');
    });

    it('未設定時は 404 + not_found (従来どおり、空ボディで検証を通さない)', async () => {
      delete process.env[KEY];
      const res = await request(app)
        .get('/.well-known/openai-apps-challenge')
        .expect(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });

    it('空文字 / 空白のみは未設定扱いで 404', async () => {
      process.env[KEY] = '   ';
      const res = await request(app)
        .get('/.well-known/openai-apps-challenge')
        .expect(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });
  });

  describe('GET /authorize', () => {
    it('issuer の path prefix (/api/v1) を保持して 302 redirect する', async () => {
      const res = await request(app).get('/authorize').query({
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

  describe('POST /token (OAuth token proxy)', () => {
    const realFetch = global.fetch;
    let fetchMock: jest.Mock;

    beforeEach(() => {
      fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
    });
    afterEach(() => {
      global.fetch = realFetch;
    });

    const upstreamOk = (
      body: unknown = { access_token: 'at', token_type: 'Bearer' },
      status = 200,
    ): void => {
      fetchMock.mockResolvedValue({
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    };

    type FetchInit = {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    const calledUrl = (): string => fetchMock.mock.calls[0][0] as string;
    const sentBody = (): Record<string, unknown> =>
      JSON.parse((fetchMock.mock.calls[0][1] as FetchInit).body) as Record<
        string,
        unknown
      >;
    const sentInit = (): FetchInit => fetchMock.mock.calls[0][1] as FetchInit;

    it('form-encoded を JSON に変換し upstream /oauth/token へ転送する', async () => {
      upstreamOk();
      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code: 'abc',
          code_verifier: 'verifier',
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        })
        .expect(200);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(calledUrl()).toBe(`${REPORTFLOW_OAUTH_ISSUER_URL}/oauth/token`);
      expect(sentInit().method).toBe('POST');
      expect(sentInit().headers['Content-Type']).toBe('application/json');
      const body = sentBody();
      expect(body.grant_type).toBe('authorization_code');
      expect(body.code).toBe('abc');
      expect(res.body.access_token).toBe('at');
    });

    it('application/json はそのまま JSON で転送する', async () => {
      upstreamOk();
      await request(app)
        .post('/token')
        .send({ grant_type: 'refresh_token', refresh_token: 'rt' })
        .expect(200);

      const body = sentBody();
      expect(body.grant_type).toBe('refresh_token');
      expect(body.refresh_token).toBe('rt');
    });

    it('JSON 経路でも単一要素 resource 配列はスカラーに正規化する', async () => {
      upstreamOk();
      await request(app)
        .post('/token')
        .send({
          grant_type: 'authorization_code',
          resource: ['https://only.example'],
        })
        .expect(200);

      expect(sentBody().resource).toBe('https://only.example');
    });

    it('repeated resource キーは配列で転送する (RFC 8707)', async () => {
      upstreamOk();
      await request(app)
        .post('/token')
        .type('form')
        .send(
          'grant_type=authorization_code&resource=https://a.example&resource=https://b.example',
        )
        .expect(200);

      expect(sentBody().resource).toEqual([
        'https://a.example',
        'https://b.example',
      ]);
    });

    it('単一 resource はスカラーで転送する (reposts-api は string を期待)', async () => {
      upstreamOk();
      await request(app)
        .post('/token')
        .type('form')
        .send('grant_type=authorization_code&resource=https://only.example')
        .expect(200);

      expect(sentBody().resource).toBe('https://only.example');
    });

    it('Authorization ヘッダがあれば upstream に引き継ぐ', async () => {
      upstreamOk();
      await request(app)
        .post('/token')
        .set('Authorization', 'Basic Y2xpZW50')
        .type('form')
        .send({ grant_type: 'authorization_code' })
        .expect(200);

      expect(sentInit().headers.Authorization).toBe('Basic Y2xpZW50');
    });

    it('upstream のステータスとボディをそのまま透過する (4xx も)', async () => {
      upstreamOk({ error: 'invalid_grant' }, 400);
      const res = await request(app)
        .post('/token')
        .type('form')
        .send({ grant_type: 'authorization_code' })
        .expect(400);

      expect(res.body.error).toBe('invalid_grant');
    });

    it('upstream 通信失敗時は 502 + server_error (ユーザーフレンドリー)', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await request(app)
        .post('/token')
        .type('form')
        .send({ grant_type: 'authorization_code' })
        .expect(502);

      expect(res.body.error).toBe('server_error');
      expect(res.body.error_description).toBeTruthy();
    });
  });

  describe('POST /register (Dynamic Client Registration proxy)', () => {
    const realFetch = global.fetch;
    let fetchMock: jest.Mock;

    beforeEach(() => {
      fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
    });
    afterEach(() => {
      global.fetch = realFetch;
    });

    it('body を upstream /oauth/register に転送し no-cache を付ける', async () => {
      fetchMock.mockResolvedValue({
        status: 201,
        text: () =>
          Promise.resolve(JSON.stringify({ client_id: 'generated-id' })),
        headers: new Headers({ 'content-type': 'application/json' }),
      });

      const res = await request(app)
        .post('/register')
        .send({
          client_name: 'Claude',
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        })
        .expect(201);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${REPORTFLOW_OAUTH_ISSUER_URL}/oauth/register`,
      );
      expect(res.body.client_id).toBe('generated-id');
      expect(res.headers['cache-control']).toContain('no-cache');
    });

    it('upstream 通信失敗時は 502 + server_error', async () => {
      fetchMock.mockRejectedValue(new Error('upstream down'));
      const res = await request(app)
        .post('/register')
        .send({ client_name: 'Claude' })
        .expect(502);

      expect(res.body.error).toBe('server_error');
      expect(res.body.error_description).toBeTruthy();
    });
  });

  describe('POST /mcp 認可ガード', () => {
    // PROTECTED_METHODS 全要素を Bearer 無しで叩くと 401 になることを回帰固定する。
    // 過去に resources/list のガードが外れた regression 歴があるため、tools/call
    // だけでなく保護対象メソッド全件を HTTP 層でピン止めする (http-server.ts の
    // PROTECTED_METHODS と 1:1 対応)。
    const PROTECTED_METHODS = [
      'tools/call',
      'resources/read',
      'resources/list',
      'prompts/get',
    ] as const;
    it.each(PROTECTED_METHODS)(
      '保護対象メソッド %s を Bearer 無しで叩くと 401 + WWW-Authenticate',
      async (method) => {
        const res = await request(app)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .send({ jsonrpc: '2.0', id: 1, method, params: {} })
          .expect(401);
        expect(res.headers['www-authenticate']).toContain('Bearer');
        expect(res.headers['www-authenticate']).toContain(
          '/.well-known/oauth-protected-resource',
        );
        expect(res.body.error).toBe('invalid_token');
      },
    );

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

  describe('POST / (ルート) も MCP ハンドラとして応答する', () => {
    it('保護対象メソッドを Bearer 無しで叩くと 401 (ルートでも /mcp と同じガード)', async () => {
      const res = await request(app)
        .post('/')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_templates', arguments: {} },
        })
        .expect(401);
      expect(res.body.error).toBe('invalid_token');
    });

    it('非保護メソッド (initialize) は 401 にも 404 にもしない', async () => {
      const res = await request(app)
        .post('/')
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
      expect(res.status).not.toBe(404);
    });

    it('SSE でない GET / は (サーバ生成前に) 404 で弾く', async () => {
      const res = await request(app).get('/').expect(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });
  });

  describe('MCP エンドポイントの Host / Origin 検証 (MCP spec §Security)', () => {
    const initializeBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    };

    it('不正 Host の POST /mcp は 403 + JSON-RPC エラー (MCP 処理に到達しない)', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Host', 'evil.example')
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeBody)
        .expect(403);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.error.code).toBe(-32000);
      expect(res.body.error.message).toContain('evil.example');
      expect(res.body.id).toBeNull();
    });

    it('ルート / も同一ポリシーで不正 Host を 403 にする', async () => {
      const res = await request(app)
        .post('/')
        .set('Host', 'evil.example')
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeBody)
        .expect(403);
      expect(res.body.error.code).toBe(-32000);
    });

    it('SSE 用 GET も不正 Host なら 403 (405 より前に弾く)', async () => {
      await request(app)
        .get('/mcp')
        .set('Host', 'evil.example')
        .set('Accept', 'text/event-stream')
        .expect(403);
    });

    it('正規 Host (mcp.re-port-flow.com) は 403 にならない', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Host', 'mcp.re-port-flow.com')
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeBody);
      expect(res.status).not.toBe(403);
    });

    it('ポート付きの正規 Host (mcp.re-port-flow.com:443) も許可する (境界の固定)', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Host', 'mcp.re-port-flow.com:443')
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeBody);
      expect(res.status).not.toBe(403);
    });

    it('localhost 系 Host (supertest 既定 = 127.0.0.1:port) は従来どおり処理される', async () => {
      // 既存テスト全件のグリーンがそのまま localhost 許可の検証になるが、
      // ここでも明示的に 1 件ピン止めする。
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeBody);
      expect(res.status).not.toBe(403);
    });

    it('パース不能な Origin は 403', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Origin', 'http://[invalid')
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeBody)
        .expect(403);
      expect(res.body.error.code).toBe(-32000);
      expect(res.body.error.message).toContain('Origin');
    });

    it('serialized origin の形でない Origin (path 付き) も 403', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Origin', 'https://example.com/path')
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeBody)
        .expect(403);
      expect(res.body.error.code).toBe(-32000);
    });

    it('CORS preflight (OPTIONS) も不正 Host なら 403 (204 より前に検証)', async () => {
      // guard は CORS middleware より前に置いているため、preflight も検証対象。
      const res = await request(app)
        .options('/mcp')
        .set('Host', 'evil.example')
        .set('Origin', 'https://claude.ai')
        .set('Access-Control-Request-Method', 'POST')
        .expect(403);
      expect(res.body.error.code).toBe(-32000);
    });

    it('不正 Host は body パースより前に 403 (malformed JSON でも 400 にならない)', async () => {
      // guard は express.json より前に置いているため、body の状態に依らず 403。
      const res = await request(app)
        .post('/mcp')
        .set('Host', 'evil.example')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .send('{invalid-json')
        .expect(403);
      expect(res.body.error.code).toBe(-32000);
    });

    it('正常な Origin (https://claude.ai) は従来どおり処理される', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Origin', 'https://claude.ai')
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeBody);
      expect(res.status).not.toBe(403);
    });

    it('Origin: null (opaque origin) は 403 にしない (PRJ-3-1115 の許容判断を固定)', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Origin', 'null')
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeBody);
      expect(res.status).not.toBe(403);
    });

    it('Origin ヘッダー無し (ネイティブクライアント) は従来どおり処理される', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeBody);
      expect(res.status).not.toBe(403);
    });

    it('/healthz は Host 不問で 200 (ALB ヘルスチェックの回帰防止)', async () => {
      // ALB ヘルスチェックは Host にターゲット IP:port を載せてくるため、
      // /healthz に Host 検証を適用するとヘルスチェックが即落ちする。
      const res = await request(app)
        .get('/healthz')
        .set('Host', '10.0.0.1:3000')
        .expect(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('well-known (PRM) は Host 検証の適用外 (公開メタデータ)', async () => {
      await request(app)
        .get('/.well-known/oauth-protected-resource')
        .set('Host', '10.0.0.1:3000')
        .expect(200);
    });

    it('favicon は Host 検証の適用外', async () => {
      await request(app)
        .get('/favicon.ico')
        .set('Host', '10.0.0.1:3000')
        .expect(200);
    });
  });

  describe('全 Origin 許可ポリシーのガードレール (PRJ-3-1116)', () => {
    // 以下の 2 前提が「全 Origin 許可 (cors origin: true) + Host 検証」を安全に
    // している (親タスク PRJ-3-1114 の脅威モデル / docs/security.md 参照):
    //   (1) CORS が credential を許可しない (credentials: false)
    //   (2) サーバーが Set-Cookie を発行しない (ambient credential が存在しない)
    // このどちらかが崩れたら全 Origin 許可の前提が崩れる。壊す変更が入ったら
    // このテストが落ちることで、Origin ポリシーの再設計が必要だと気付けるように
    // ピン止めする (テストの期待値を変えて通すのは禁止。ポリシー再設計が先)。
    it('CORS preflight は Access-Control-Allow-Credentials を返さない', async () => {
      const res = await request(app)
        .options('/mcp')
        .set('Origin', 'https://claude.ai')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,content-type');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('MCP 応答 (旧仕様 initialize) に Set-Cookie が無い', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Origin', 'https://claude.ai')
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
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('MCP 応答 (新仕様 tools/list) に Set-Cookie が無い', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Origin', 'https://claude.ai')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', '2026-07-28')
        .set('Mcp-Method', 'tools/list')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        })
        .expect(200);
      expect(res.headers['set-cookie']).toBeUndefined();
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
