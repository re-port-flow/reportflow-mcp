import request from 'supertest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import type { Server } from 'node:http';
import {
  buildHttpApp,
  isAllowedHost,
  isRejectableOrigin,
  MCP_HTTP_IP_RATE_LIMIT_MAX,
  MCP_HTTP_RATE_LIMIT_MAX,
  MCP_HTTP_RATE_LIMIT_WINDOW_MS,
  parsePort,
  startHttpServer,
} from './http-server';
import { MCP_RESOURCE_URL, REPORTFLOW_OAUTH_ISSUER_URL } from './config';
import { fixedAuthorization } from './integration/helpers/createTestClient';

/**
 * 上流応答モックの本文ストリーム。
 *
 * **`text()` だけのモックにしない。** `callOAuthUpstream` は本文サイズの上限を
 * **実測**で効かせるため `res.body` をストリームで読む。`text()` しか持たない
 * モックは「`body` を持たない応答」という**本番の fetch では起きない形**なので、
 * それに合わせると本文を読む経路そのものを検査しないテストになる。
 *
 * ストリームは 1 度しか読めない。使い回す helper では `mockResolvedValue`
 * ではなく `mockImplementation` で**毎回作る**こと。
 */
const bodyOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      if (text !== '') controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

/** 本文の読み取り自体が失敗する応答（中断・通信断の再現）。 */
const failingBodyOf = (err: unknown): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.error(err);
    },
  });

const parseLastSseMessage = (text: string): Record<string, unknown> => {
  const dataLine = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .at(-1);
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine!.slice('data: '.length)) as Record<
    string,
    unknown
  >;
};

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
    '10.0.0.1:3000', // ヘルスチェック相当の Host (MCP エンドポイントでは拒否)
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
      // ストリームは 1 度しか読めないので**呼ばれるたびに作る**。
      fetchMock.mockImplementation(() =>
        Promise.resolve({
          status,
          body: bodyOf(JSON.stringify(body)),
          headers: new Headers({ 'content-type': 'application/json' }),
        }),
      );
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

    // RFC 6749 §5.1: token を含む応答は `Cache-Control: no-store` が MUST。
    // ヘッダーを自前で組み立てる以上、上流の Cache-Control は写らないので
    // ここが落ちると access_token がキャッシュ制御なしで中間層へ届く。
    it('token 応答に Cache-Control: no-store と Pragma: no-cache を付ける', async () => {
      upstreamOk();
      const res = await request(app)
        .post('/token')
        .type('form')
        .send({ grant_type: 'authorization_code' })
        .expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['pragma']).toBe('no-cache');
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
        body: bodyOf(JSON.stringify({ client_id: 'generated-id' })),
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
      // DCR 応答は client_secret / registration_access_token を含み得るので
      // **保存させない** (`no-cache` は保存を許すので足りない)。
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['pragma']).toBe('no-cache');
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

  // ─── Cloudflare Access Service Auth + fail-closed (PRJ-3-1573) ────────────
  // staging の上流は Cloudflare Access の裏に居る。身元 (service token) を
  // 載せないと Access が 302 でログイン画面へ送り、`fetch` の既定がそれを追従して
  // ログイン HTML を 200 として claude.ai へ返していた (2026-09-05 実測: /register
  // が 3 回 200 / 約 36.9 KiB)。ここで固定するのは 2 つ:
  //   1. 2 値が揃うときだけ Access ヘッダーを載せ、外部応答には出さない
  //   2. redirect / 非 JSON 2xx / 空 body / timeout を成功扱いしない
  describe('OAuth proxy の Cloudflare Access Service Auth と fail-closed', () => {
    const realFetch = global.fetch;
    let fetchMock: jest.Mock;
    let errorSpy: jest.SpyInstance;

    // 実発行値ではないダミー。ID は Cloudflare の実物と同じ形 (末尾 `.access`)。
    const DUMMY_CLIENT_ID = 'a1b2c3d4e5f6.access';
    const DUMMY_CLIENT_SECRET = 'dummy-service-token-secret-not-real';
    // Access のログイン画面相当。実測の応答サイズ (36,936 bytes) を再現する。
    const ACCESS_LOGIN_HTML = `<!DOCTYPE html><html><head><title>Sign in</title></head><body>${'x'.repeat(36_800)}</body></html>`;

    type FetchInit = {
      method: string;
      headers: Record<string, string>;
      body: string;
      redirect?: RequestRedirect;
      signal?: AbortSignal;
    };
    const sentInit = (): FetchInit => fetchMock.mock.calls[0][1] as FetchInit;
    const loggedLines = (): string =>
      errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');

    /**
     * 2 値を設定した状態でアプリを組み、**すぐ環境変数を消す**。
     * `buildHttpApp` は生成時に 1 度だけ env を読むので、これで
     * 「staging 相当のアプリ」と「他テストへ漏らさない env」が同時に成立する。
     */
    const buildStagingApp = (): ReturnType<typeof buildHttpApp> => {
      process.env['RF_ACCESS_CLIENT_ID'] = DUMMY_CLIENT_ID;
      process.env['RF_ACCESS_CLIENT_SECRET'] = DUMMY_CLIENT_SECRET;
      try {
        return buildHttpApp();
      } finally {
        delete process.env['RF_ACCESS_CLIENT_ID'];
        delete process.env['RF_ACCESS_CLIENT_SECRET'];
      }
    };

    const upstream = (init: {
      status: number;
      contentType?: string | null;
      text?: string;
    }): void => {
      // ストリームは 1 度しか読めないので**呼ばれるたびに作る**。
      fetchMock.mockImplementation(() =>
        Promise.resolve({
          status: init.status,
          body: bodyOf(init.text ?? ''),
          headers: new Headers(
            init.contentType === null || init.contentType === undefined
              ? {}
              : { 'content-type': init.contentType },
          ),
        }),
      );
    };

    beforeEach(() => {
      fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      global.fetch = realFetch;
      errorSpy.mockRestore();
      delete process.env['RF_ACCESS_CLIENT_ID'];
      delete process.env['RF_ACCESS_CLIENT_SECRET'];
    });

    // ── UT1: 両方未設定 (production 相当) ──────────────────────────────────
    it.each([
      ['/register', { client_name: 'Claude' }, 201, { client_id: 'generated' }],
      [
        '/token',
        { grant_type: 'refresh_token', refresh_token: 'rt' },
        200,
        { access_token: 'at', token_type: 'Bearer' },
      ],
    ] as const)(
      '2 値未設定なら %s の上流 fetch に Access ヘッダーを付けない',
      async (path, body, status, upstreamBody) => {
        upstream({
          status,
          contentType: 'application/json',
          text: JSON.stringify(upstreamBody),
        });
        // describe 冒頭の `app` は env 未設定で生成済み (= production 相当)。
        await request(app).post(path).send(body).expect(status);

        const headers = sentInit().headers;
        expect(headers['CF-Access-Client-Id']).toBeUndefined();
        expect(headers['CF-Access-Client-Secret']).toBeUndefined();
      },
    );

    // ── UT2: 両方設定 (staging 相当) ──────────────────────────────────────
    it.each([
      ['/register', { client_name: 'Claude' }, 201, { client_id: 'generated' }],
      [
        '/token',
        { grant_type: 'refresh_token', refresh_token: 'rt' },
        200,
        { access_token: 'at', token_type: 'Bearer' },
      ],
    ] as const)(
      '2 値設定なら %s の上流 fetch に CF-Access-Client-Id/Secret を付ける',
      async (path, body, status, upstreamBody) => {
        upstream({
          status,
          contentType: 'application/json',
          text: JSON.stringify(upstreamBody),
        });
        const res = await request(buildStagingApp())
          .post(path)
          .send(body)
          .expect(status);

        expect(sentInit().headers['CF-Access-Client-Id']).toBe(DUMMY_CLIENT_ID);
        expect(sentInit().headers['CF-Access-Client-Secret']).toBe(
          DUMMY_CLIENT_SECRET,
        );
        // **外部応答に出さない** (ヘッダーも本文も)。
        expect(JSON.stringify(res.headers)).not.toContain(DUMMY_CLIENT_ID);
        expect(JSON.stringify(res.headers)).not.toContain(DUMMY_CLIENT_SECRET);
        expect(res.text).not.toContain(DUMMY_CLIENT_ID);
        expect(res.text).not.toContain(DUMMY_CLIENT_SECRET);
      },
    );

    it('クライアントが送った CF-Access-* ヘッダーで上書きされない', async () => {
      upstream({
        status: 201,
        contentType: 'application/json',
        text: JSON.stringify({ client_id: 'generated' }),
      });
      await request(buildStagingApp())
        .post('/register')
        .set('CF-Access-Client-Id', 'attacker.access')
        .set('CF-Access-Client-Secret', 'attacker-secret')
        .send({ client_name: 'Claude' })
        .expect(201);

      expect(sentInit().headers['CF-Access-Client-Id']).toBe(DUMMY_CLIENT_ID);
      expect(sentInit().headers['CF-Access-Client-Secret']).toBe(
        DUMMY_CLIENT_SECRET,
      );
    });

    it('Authorization を引き継ぐ /token でも Access ヘッダーが勝つ', async () => {
      upstream({
        status: 200,
        contentType: 'application/json',
        text: JSON.stringify({ access_token: 'at' }),
      });
      await request(buildStagingApp())
        .post('/token')
        .set('Authorization', 'Basic Y2xpZW50')
        .type('form')
        .send({ grant_type: 'authorization_code' })
        .expect(200);

      expect(sentInit().headers.Authorization).toBe('Basic Y2xpZW50');
      expect(sentInit().headers['CF-Access-Client-Id']).toBe(DUMMY_CLIENT_ID);
    });

    // ── UT3 / UT4: 片方だけ (fail-fast) ──────────────────────────────────
    it.each([
      ['Client ID のみ', 'RF_ACCESS_CLIENT_ID', DUMMY_CLIENT_ID],
      ['Client Secret のみ', 'RF_ACCESS_CLIENT_SECRET', DUMMY_CLIENT_SECRET],
    ])('%s の設定ではアプリ生成が失敗する', (_label, envName, value) => {
      process.env[envName] = value;
      let caught: unknown;
      try {
        buildHttpApp();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      // 値そのものは例外へ入れない (Cloudflare Workers Logs に残る)。
      expect((caught as Error).message).not.toContain(value);
    });

    // ── UT7: 302 (Access ログイン画面へのリダイレクト) ────────────────────
    it.each(['/register', '/token'] as const)(
      '%s: 上流 302 は追従せず 502 の OAuth JSON エラーにする',
      async (path) => {
        const loginUrl =
          'https://monepla.cloudflareaccess.com/cdn-cgi/access/login/stg.re-port-flow.com';
        fetchMock.mockResolvedValue({
          status: 302,
          body: bodyOf(ACCESS_LOGIN_HTML),
          headers: new Headers({
            location: loginUrl,
            'content-type': 'text/html',
          }),
        });

        const res = await request(buildStagingApp())
          .post(path)
          .send({ client_name: 'Claude', grant_type: 'authorization_code' })
          .expect(502);

        expect(res.body.error).toBe('server_error');
        expect(res.body.error_description).toBeTruthy();
        // Location も HTML もクライアントへ漏らさない。
        expect(res.text).not.toContain(loginUrl);
        expect(res.text).not.toContain('<!DOCTYPE html');
        // redirect を自動追従しない指定になっていること (直接原因の固定)。
        expect(sentInit().redirect).toBe('manual');
      },
    );

    // 読み残しの解放に失敗しても、**確定した理由を塗り替えない**。
    // ここで例外が漏れると `redirect` が `network_error` に化け、
    // Cloudflare Workers Logs の `rejection=` が原因を指さなくなる。
    it('読み残しの cancel が失敗しても rejection=redirect のまま 502 にする', async () => {
      fetchMock.mockResolvedValue({
        status: 302,
        body: { cancel: () => Promise.reject(new Error('cancel failed')) },
        headers: new Headers({
          location: 'https://monepla.cloudflareaccess.com/login',
          'content-type': 'text/html',
        }),
      });

      const res = await request(buildStagingApp())
        .post('/register')
        .send({ client_name: 'Claude' })
        .expect(502);

      expect(res.body.error).toBe('server_error');
      expect(loggedLines()).toContain('rejection=redirect');
      expect(loggedLines()).not.toContain('rejection=network_error');
    });

    // ── UT8: 200 text/html (約 36.9 KiB) ────────────────────────────────
    it.each(['/register', '/token'] as const)(
      '%s: 上流 200 + text/html (Access ログイン HTML) を成功扱いしない',
      async (path) => {
        upstream({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          text: ACCESS_LOGIN_HTML,
        });

        const res = await request(buildStagingApp())
          .post(path)
          .send({ client_name: 'Claude', grant_type: 'authorization_code' })
          .expect(502);

        expect(res.body.error).toBe('server_error');
        expect(res.text).not.toContain('<!DOCTYPE html');
        expect(res.text.length).toBeLessThan(1_000);
      },
    );

    // ── UT9 / UT10: 不正 JSON / 空 body / 必須項目欠落 ────────────────────
    it.each([
      ['壊れた JSON', 'application/json', '{"client_id":'],
      ['空 body', 'application/json', ''],
      ['オブジェクトでない JSON', 'application/json', 'null'],
      ['必須項目なし', 'application/json', '{"foo":"bar"}'],
      ['Content-Type なし + 非 JSON', null, 'plain text'],
    ])(
      '/register: 上流 200 + %s は 502 にする',
      async (_label, contentType, text) => {
        upstream({ status: 200, contentType, text });
        const res = await request(buildStagingApp())
          .post('/register')
          .send({ client_name: 'Claude' })
          .expect(502);
        expect(res.body.error).toBe('server_error');
      },
    );

    it.each([
      ['壊れた JSON', 'application/json', '{"access_token":'],
      ['空 body', 'application/json', ''],
      ['必須項目 (access_token) なし', 'application/json', '{"foo":"bar"}'],
    ])(
      '/token: 上流 200 + %s は 502 にする',
      async (_label, contentType, text) => {
        upstream({ status: 200, contentType, text });
        const res = await request(buildStagingApp())
          .post('/token')
          .type('form')
          .send({ grant_type: 'authorization_code' })
          .expect(502);
        expect(res.body.error).toBe('server_error');
      },
    );

    // ── UT11: 正規 4xx は維持 / 非 JSON 4xx は転送しない ──────────────────
    it('/token: 正規 4xx OAuth JSON エラーは status と本文を維持する', async () => {
      upstream({
        status: 400,
        contentType: 'application/json',
        text: JSON.stringify({
          error: 'invalid_grant',
          error_description: 'code expired',
        }),
      });
      const res = await request(buildStagingApp())
        .post('/token')
        .type('form')
        .send({ grant_type: 'authorization_code' })
        .expect(400);

      expect(res.body.error).toBe('invalid_grant');
      expect(res.body.error_description).toBe('code expired');
    });

    it('/register: 4xx の HTML 本文は転送せず 502 にする', async () => {
      upstream({
        status: 403,
        contentType: 'text/html',
        text: ACCESS_LOGIN_HTML,
      });
      const res = await request(buildStagingApp())
        .post('/register')
        .send({ client_name: 'Claude' })
        .expect(502);

      expect(res.body.error).toBe('server_error');
      expect(res.text).not.toContain('<!DOCTYPE html');
    });

    // ── UT12: timeout / network error ────────────────────────────────────
    it('上流 timeout は 502 + rejection=timeout でログする', async () => {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      fetchMock.mockRejectedValue(timeoutErr);

      const res = await request(buildStagingApp())
        .post('/register')
        .send({ client_name: 'Claude' })
        .expect(502);

      expect(res.body.error).toBe('server_error');
      expect(loggedLines()).toContain('rejection=timeout');
      // タイムアウト指定が実際に fetch へ渡っていること。
      expect(sentInit().signal).toBeInstanceOf(AbortSignal);
    });

    it('上流 network error は 502 + rejection=network_error でログする', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await request(buildStagingApp())
        .post('/token')
        .type('form')
        .send({ grant_type: 'authorization_code' })
        .expect(502);

      expect(loggedLines()).toContain('rejection=network_error');
    });

    it('上流応答の読み取りが予期せず失敗しても 502 で閉じる', async () => {
      // `headers.get` が投げる = callOAuthUpstream が想定していない失敗。
      // ハンドラ側の最終 catch が 502 を返すことを固定する。
      fetchMock.mockResolvedValue({
        status: 200,
        body: bodyOf('{}'),
        headers: {
          get: (): string => {
            throw new Error('boom');
          },
        },
      });

      const res = await request(buildStagingApp())
        .post('/register')
        .send({ client_name: 'Claude' })
        .expect(502);
      expect(res.body.error).toBe('server_error');
    });

    it('body の読み取りが中断された場合も 502 にする', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      // 本文ストリームそのものを error 状態にする（実際の中断と同じ形）。
      fetchMock.mockResolvedValue({
        status: 200,
        body: failingBodyOf(abortErr),
        headers: new Headers({ 'content-type': 'application/json' }),
      });

      await request(buildStagingApp())
        .post('/register')
        .send({ client_name: 'Claude' })
        .expect(502);
      expect(loggedLines()).toContain('rejection=timeout');
    });

    // ── UT13: 秘密がログへ出ない ─────────────────────────────────────────
    it('ログに Client ID / Secret / Authorization / token / 上流 HTML を出さない', async () => {
      const stagingApp = buildStagingApp();
      const cases: (() => void)[] = [
        () =>
          fetchMock.mockResolvedValue({
            status: 302,
            body: bodyOf(ACCESS_LOGIN_HTML),
            headers: new Headers({
              location: 'https://monepla.cloudflareaccess.com/login',
              'content-type': 'text/html',
            }),
          }),
        () =>
          fetchMock.mockResolvedValue({
            status: 200,
            body: bodyOf(ACCESS_LOGIN_HTML),
            headers: new Headers({ 'content-type': 'text/html' }),
          }),
        () => fetchMock.mockRejectedValue(new TypeError('fetch failed')),
      ];

      for (const arrange of cases) {
        arrange();
        await request(stagingApp)
          .post('/token')
          .set('Authorization', 'Basic c2VjcmV0LWNsaWVudC1hdXRo')
          .type('form')
          .send({
            grant_type: 'authorization_code',
            code: 'super-secret-auth-code',
            code_verifier: 'super-secret-verifier',
          })
          .expect(502);
      }

      const logged = loggedLines();
      expect(logged).not.toContain(DUMMY_CLIENT_ID);
      expect(logged).not.toContain(DUMMY_CLIENT_SECRET);
      expect(logged).not.toContain('Basic c2VjcmV0LWNsaWVudC1hdXRo');
      expect(logged).not.toContain('super-secret-auth-code');
      expect(logged).not.toContain('super-secret-verifier');
      expect(logged).not.toContain('<!DOCTYPE html');
      expect(logged).not.toContain('cloudflareaccess.com');
      // 代わりに切り分けに要る分類だけが出ている。
      expect(logged).toContain('endpoint=token');
      expect(logged).toContain('path=/api/v1/oauth/token');
      expect(logged).toContain('rejection=redirect');
      expect(logged).toContain('rejection=non_json_content_type');
      expect(logged).toContain('rejection=network_error');
    });

    it('上流の Content-Type に改行を混ぜられてもログ行を分断されない', async () => {
      // ヘッダー値経由のログ注入。Node の Headers は制御文字を拒否するため
      // 分類関数側と同じ経路 (mock オブジェクト) で直接与える。
      fetchMock.mockResolvedValue({
        status: 200,
        body: bodyOf('not json'),
        headers: {
          get: (): string => 'text/html\nrejection=forged path=/spoofed',
        },
      });

      await request(buildStagingApp())
        .post('/register')
        .send({ client_name: 'Claude' })
        .expect(502);

      const logged = loggedLines();
      expect(logged).not.toContain('\nrejection=forged');
      expect(logged).toContain('rejection=non_json_content_type');
    });
  });

  describe('POST /mcp 認可ガード', () => {
    // PROTECTED_METHODS 全要素を Bearer 無しで叩くと 401 になることを回帰固定する。
    // resources/list/read は未認証時にも静的 public resource を公開するため、
    // この一覧には含めない。workspace resource は capability filtering 側で保護する。
    const PROTECTED_METHODS = ['tools/call', 'prompts/get'] as const;
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

    it('未認証の resources/list は静的 public resource を返す', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} })
        .expect(200);
      const message = parseLastSseMessage(res.text) as {
        result?: { resources?: Array<{ uri: string }> };
      };
      const uris = (message.result?.resources ?? []).map(
        (resource) => resource.uri,
      );
      expect(uris).toContain('reportflow://server-info');
      expect(uris).toContain('reportflow://errors');
      expect(uris).not.toContain('reportflow://designs');
      expect(uris).not.toContain('reportflow://designs/d1/parameters');
    });

    it('未認証の静的 resources/read は 200 を返す', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'resources/read',
          params: { uri: 'reportflow://server-info' },
        })
        .expect(200);
      const message = parseLastSseMessage(res.text) as {
        result?: {
          contents?: Array<{
            uri: string;
            mimeType?: string;
            text: string;
          }>;
        };
      };
      const contents = message.result?.contents ?? [];
      expect(contents).toHaveLength(1);
      expect(contents[0]).toMatchObject({
        uri: 'reportflow://server-info',
        mimeType: 'application/json',
      });
      expect(JSON.parse(contents[0].text)).toMatchObject({
        name: 'reportflow-mcp',
        version: expect.any(String),
      });
      const serverInfo = JSON.parse(contents[0].text) as {
        capabilities: { resources: string[] };
      };
      expect(serverInfo.capabilities.resources).toEqual([
        'reportflow://errors',
        'reportflow://server-info',
      ]);
    });

    it('未認証の workspace resource read は公開しない', async () => {
      for (const uri of [
        'reportflow://designs',
        'reportflow://designs/d1/parameters',
      ]) {
        const res = await request(app)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .send({
            jsonrpc: '2.0',
            id: 5,
            method: 'resources/read',
            params: { uri },
          });
        expect(res.status).toBe(200);
        const message = parseLastSseMessage(res.text) as {
          result?: unknown;
          error?: unknown;
        };
        expect(message.result).toBeUndefined();
        expect(message.error).toBeDefined();
      }
    });

    it('READ role with Bearer lists and reads workspace resources', async () => {
      const readApp = buildHttpApp({
        resolveAuthorization: () => Promise.resolve(fixedAuthorization('READ')),
      });
      const realFetch = global.fetch;
      global.fetch = jest
        .fn()
        .mockImplementation((input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/v1/file/designs')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  designs: [
                    {
                      id: 'd1',
                      label: 'Invoice',
                      latestVersion: 1,
                      thumbnail: '',
                      updatedAt: '2026-01-01T00:00:00Z',
                    },
                  ],
                }),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                },
              ),
            );
          }
          if (url.includes('/v1/file/design/parameter/d1')) {
            return Promise.resolve(
              new Response(JSON.stringify({ amount: { type: 'number' } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          }
          throw new Error(`unexpected fetch URL: ${url}`);
        }) as unknown as typeof fetch;
      try {
        const list = await request(readApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', 'Bearer dummy-token')
          .send({
            jsonrpc: '2.0',
            id: 6,
            method: 'resources/list',
            params: {},
          })
          .expect(200);
        const listMessage = parseLastSseMessage(list.text) as {
          result?: { resources?: Array<{ uri: string }> };
        };
        const uris = (listMessage.result?.resources ?? []).map(
          (resource) => resource.uri,
        );
        expect(uris).toContain('reportflow://designs');
        expect(uris).toContain('reportflow://designs/d1/parameters');

        for (const [uri, expectedText] of [
          ['reportflow://designs', 'Invoice'],
          ['reportflow://designs/d1/parameters', 'number'],
        ]) {
          const res = await request(readApp)
            .post('/mcp')
            .set('Accept', 'application/json, text/event-stream')
            .set('Authorization', 'Bearer dummy-token')
            .send({
              jsonrpc: '2.0',
              id: 7,
              method: 'resources/read',
              params: { uri },
            })
            .expect(200);
          const message = parseLastSseMessage(res.text) as {
            result?: {
              contents?: Array<{
                uri: string;
                mimeType?: string;
                text: string;
              }>;
            };
          };
          expect(message.result?.contents).toHaveLength(1);
          expect(message.result?.contents?.[0]).toMatchObject({
            uri,
            mimeType: 'application/json',
          });
          expect(message.result?.contents?.[0]?.text).toContain(expectedText);
        }
      } finally {
        global.fetch = realFetch;
      }
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

    it('/healthz は Host 不問で 200 (ヘルスチェックの回帰防止)', async () => {
      // Container/プロキシのヘルスチェックは Host にターゲット IP:port を載せてくるため、
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

describe('MCP HTTP rate limit (PRJ-3-2258)', () => {
  const buildLimited = (): ReturnType<typeof buildHttpApp> =>
    buildHttpApp({
      mcpRateLimit: { windowMs: 60_000, limit: 2, ipLimit: 2 },
      trustConnectingIpHeaders: true,
    });

  it('本番の窓は 60 秒、Bearer 上限は 300、IP 上限は 3000', () => {
    expect(MCP_HTTP_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(MCP_HTTP_RATE_LIMIT_MAX).toBe(300);
    expect(MCP_HTTP_IP_RATE_LIMIT_MAX).toBe(3_000);
  });

  it('/ と /mcp は同じ IP でカウンタを共有し、超過は JSON-RPC 429', async () => {
    const app = buildLimited();
    const ip = '203.0.113.10';
    await request(app).get('/').set('CF-Connecting-IP', ip).expect(404);
    await request(app).get('/mcp').set('CF-Connecting-IP', ip).expect(404);
    const blocked = await request(app)
      .get('/')
      .set('CF-Connecting-IP', ip)
      .expect(429);
    expect(blocked.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many requests' },
      id: null,
    });
    expect(blocked.headers['content-type']).toMatch(/application\/json/);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    expect(blocked.headers['ratelimit']).toBeDefined();
    expect(blocked.headers['x-ratelimit-limit']).toBeUndefined();

    const other = await request(app)
      .get('/mcp')
      .set('CF-Connecting-IP', '203.0.113.11')
      .expect(404);
    expect(other.body).toEqual({ error: 'not_found' });

    const health = await request(app)
      .get('/healthz')
      .set('CF-Connecting-IP', ip)
      .expect(200);
    expect(health.body).toEqual({ status: 'ok' });
    await request(app).get('/healthz').expect(200);

    const otherPath = await request(app)
      .get('/foo')
      .set('CF-Connecting-IP', ip)
      .expect(404);
    expect(otherPath.body).toEqual({ error: 'not_found' });
  });

  it('CF-Connecting-IP が空・IP でないときは req.ip のバケットを使い、X-Forwarded-For では分けない', async () => {
    const app = buildLimited();
    await request(app)
      .get('/')
      .set('X-Forwarded-For', '198.51.100.8')
      .expect(404);
    await request(app)
      .get('/mcp')
      .set('CF-Connecting-IP', '   ')
      .set('X-Forwarded-For', '198.51.100.9')
      .expect(404);
    const blocked = await request(app)
      .get('/')
      .set('CF-Connecting-IP', 'not-an-ip')
      .set('X-Forwarded-For', '198.51.100.10')
      .expect(429);
    expect(blocked.body.error).toEqual({
      code: -32000,
      message: 'Too many requests',
    });
  });

  it('同じ /56 の IPv6 は 1 つのキー、別の /56 は別キー', async () => {
    const app = buildLimited();
    await request(app)
      .get('/')
      .set('CF-Connecting-IP', '2001:db8:85a3::1')
      .expect(404);
    await request(app)
      .get('/mcp')
      .set('CF-Connecting-IP', '2001:db8:85a3::2')
      .expect(404);
    await request(app)
      .get('/')
      .set('CF-Connecting-IP', '2001:db8:85a3::3')
      .expect(429);
    await request(app)
      .get('/mcp')
      .set('CF-Connecting-IP', '2001:db8:85a3:0100::1')
      .expect(404);
  });

  it('同じ Bearer は IP が違っても 1 つの枠、別トークンと未認証は別枠', async () => {
    const app = buildHttpApp({
      mcpRateLimit: { windowMs: 60_000, limit: 2, ipLimit: 10 },
      trustConnectingIpHeaders: true,
    });
    await request(app)
      .get('/')
      .set('Authorization', 'Bearer secret-a')
      .set('CF-Connecting-IP', '203.0.113.20')
      .expect(404);
    await request(app)
      .get('/mcp')
      .set('Authorization', 'Bearer secret-a')
      .set('CF-Connecting-IP', '203.0.113.20')
      .expect(404);
    await request(app)
      .get('/')
      .set('Authorization', 'Bearer secret-a')
      .set('CF-Connecting-IP', '203.0.113.21')
      .expect(429);
    await request(app)
      .get('/mcp')
      .set('Authorization', 'Bearer secret-b')
      .set('CF-Connecting-IP', '203.0.113.20')
      .expect(404);
    await request(app)
      .get('/')
      .set('CF-Connecting-IP', '203.0.113.20')
      .expect(404);
  });

  it('同じ IP から Bearer を変えても IP の上限で 429 になる', async () => {
    const app = buildLimited();
    const ip = '203.0.113.30';
    await request(app)
      .get('/')
      .set('Authorization', 'Bearer rotate-a')
      .set('CF-Connecting-IP', ip)
      .expect(404);
    await request(app)
      .get('/mcp')
      .set('Authorization', 'Bearer rotate-b')
      .set('CF-Connecting-IP', ip)
      .expect(404);
    const blocked = await request(app)
      .get('/')
      .set('Authorization', 'Bearer rotate-c')
      .set('CF-Connecting-IP', ip)
      .expect(429);
    expect(blocked.body.error).toEqual({
      code: -32000,
      message: 'Too many requests',
    });
  });

  it('Worker が写した接続元は CF-Connecting-IP より先に使い、IP でなければ捨てる', async () => {
    const app = buildLimited();
    await request(app)
      .get('/')
      .set('x-reportflow-connecting-ip', '203.0.113.60')
      .set('CF-Connecting-IP', '203.0.113.61')
      .expect(404);
    await request(app)
      .get('/mcp')
      .set('x-reportflow-connecting-ip', '203.0.113.60')
      .set('CF-Connecting-IP', '203.0.113.62')
      .expect(404);
    await request(app)
      .get('/')
      .set('x-reportflow-connecting-ip', '203.0.113.60')
      .set('CF-Connecting-IP', '203.0.113.63')
      .expect(429);
    await request(app)
      .get('/mcp')
      .set('x-reportflow-connecting-ip', 'not-an-ip')
      .set('CF-Connecting-IP', '203.0.113.64')
      .expect(404);
  });

  it('壊れた JSON も IP の枠に入り、上限の次は 429 になる', async () => {
    const app = buildHttpApp({
      mcpRateLimit: { windowMs: 60_000, limit: 1, ipLimit: 1 },
      trustConnectingIpHeaders: true,
    });
    const ip = '203.0.113.70';
    const first = await request(app)
      .post('/mcp')
      .set('CF-Connecting-IP', ip)
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(first.status).toBe(400);
    const blocked = await request(app)
      .post('/')
      .set('CF-Connecting-IP', ip)
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toEqual({
      code: -32000,
      message: 'Too many requests',
    });
  });

  it('末尾スラッシュと大文字の /mcp も壊れた JSON を枠に入れる', async () => {
    const app = buildHttpApp({
      mcpRateLimit: { windowMs: 60_000, limit: 1, ipLimit: 1 },
      trustConnectingIpHeaders: true,
    });
    const slash = await request(app)
      .post('/mcp/')
      .set('CF-Connecting-IP', '203.0.113.71')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(slash.status).toBe(400);
    const slashBlocked = await request(app)
      .post('/mcp/')
      .set('CF-Connecting-IP', '203.0.113.71')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(slashBlocked.status).toBe(429);

    const upper = await request(app)
      .post('/MCP')
      .set('CF-Connecting-IP', '203.0.113.72')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(upper.status).toBe(400);
    const upperBlocked = await request(app)
      .post('/MCP')
      .set('CF-Connecting-IP', '203.0.113.72')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(upperBlocked.status).toBe(429);
  });

  it('接続元ヘッダを信用しないときは、ヘッダを変えても req.ip の枠に入る', async () => {
    const app = buildHttpApp({
      mcpRateLimit: { windowMs: 60_000, limit: 10, ipLimit: 2 },
      trustConnectingIpHeaders: false,
    });
    await request(app)
      .get('/')
      .set('x-reportflow-connecting-ip', '203.0.113.81')
      .set('CF-Connecting-IP', '203.0.113.82')
      .expect(404);
    await request(app)
      .get('/mcp')
      .set('x-reportflow-connecting-ip', '203.0.113.83')
      .set('CF-Connecting-IP', '203.0.113.84')
      .expect(404);
    const blocked = await request(app)
      .get('/')
      .set('x-reportflow-connecting-ip', '203.0.113.85')
      .set('CF-Connecting-IP', '203.0.113.86')
      .expect(429);
    expect(blocked.body.error).toEqual({
      code: -32000,
      message: 'Too many requests',
    });
  });

  it('CORS が終端する OPTIONS は、同じ IP が上限超過の後も 429 にならない', async () => {
    const app = buildLimited();
    const ip = '203.0.113.40';
    await request(app).get('/').set('CF-Connecting-IP', ip).expect(404);
    await request(app).get('/mcp').set('CF-Connecting-IP', ip).expect(404);
    await request(app).get('/').set('CF-Connecting-IP', ip).expect(429);
    const preflight = await request(app)
      .options('/mcp')
      .set('Origin', 'https://claude.ai')
      .set('Access-Control-Request-Method', 'POST')
      .set('CF-Connecting-IP', ip);
    expect(preflight.status).toBe(204);
    const plain = await request(app).options('/').set('CF-Connecting-IP', ip);
    expect(plain.status).toBe(204);
  });
});

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

describe('startHttpServer timeouts', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('default-timeouts: applies explicit Node defaults', async () => {
    server = await startHttpServer({ port: 0 });
    expect(server.requestTimeout).toBe(300_000);
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBe(70_000);
  });

  it('override-request: requestTimeoutMs overrides the default', async () => {
    server = await startHttpServer({ port: 0, requestTimeoutMs: 120_000 });
    expect(server.requestTimeout).toBe(120_000);
  });

  it('override-keepalive: keepAlive/headers overrides apply', async () => {
    server = await startHttpServer({
      port: 0,
      keepAliveTimeoutMs: 30_000,
      headersTimeoutMs: 40_000,
    });
    expect(server.keepAliveTimeout).toBe(30_000);
    expect(server.headersTimeout).toBe(40_000);
  });

  it('invalid-relation: equal keepAlive/headers rejects before listen', async () => {
    await expect(
      startHttpServer({
        port: 0,
        keepAliveTimeoutMs: 70_000,
        headersTimeoutMs: 70_000,
      }),
    ).rejects.toThrow(/keepAliveTimeout/);
    expect(server).toBeUndefined();
  });

  it('invalid-relation-gt: inverted keepAlive/headers rejects', async () => {
    await expect(
      startHttpServer({
        port: 0,
        keepAliveTimeoutMs: 80_000,
        headersTimeoutMs: 70_000,
      }),
    ).rejects.toThrow(/keepAliveTimeout/);
  });

  it('invalid-negative-timeout: rejects before listen', async () => {
    await expect(
      startHttpServer({ port: 0, requestTimeoutMs: -1 }),
    ).rejects.toThrow(/requestTimeoutMs/);
    expect(server).toBeUndefined();
  });

  it('invalid-nan-timeout: rejects non-finite values before listen', async () => {
    await expect(
      startHttpServer({ port: 0, headersTimeoutMs: Number.NaN }),
    ).rejects.toThrow(/headersTimeoutMs/);
  });

  it('startup-log: logs the three timeout values', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      server = await startHttpServer({ port: 0 });
      const startup = logSpy.mock.calls
        .map((args) => String(args[0]))
        .find((line) => line.includes('Streamable HTTP server listening'));
      expect(startup).toBeDefined();
      expect(startup).toContain('requestTimeout=300000');
      expect(startup).toContain('keepAliveTimeout=65000');
      expect(startup).toContain('headersTimeout=70000');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('bind-error: rejects with EADDRINUSE on a busy port', async () => {
    // Hold the port with the same listen path as production so IPv4/IPv6
    // family differences on macOS do not mask the collision.
    const holder = await startHttpServer({ port: 0 });
    const address = holder.address();
    if (!address || typeof address === 'string') {
      await closeServer(holder);
      throw new Error('expected TCP address');
    }

    try {
      await expect(
        startHttpServer({ port: address.port }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await closeServer(holder);
    }
  });
});
