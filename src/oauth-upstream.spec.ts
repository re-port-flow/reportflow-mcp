import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ACCESS_CLIENT_ID_ENV,
  ACCESS_CLIENT_SECRET_ENV,
  AccessServiceAuthConfigError,
  accessAuthHeaders,
  accessAuthHeadersForUrl,
  callOAuthUpstream,
  classifyUpstreamBody,
  errorNameOf,
  isAccessBoundaryUrl,
  resolveAccessServiceAuth,
  upstreamPathOf,
} from './oauth-upstream';

// 実発行値ではないダミー。Client ID は Cloudflare の実物と同じ形 (末尾 `.access`)
// にして、「ID と Secret を入れ違えた」ケースが読み分けられるようにする。
const DUMMY_CLIENT_ID = 'a1b2c3d4e5f6.access';
const DUMMY_CLIENT_SECRET = 'dummy-service-token-secret-not-real';

describe('resolveAccessServiceAuth', () => {
  it('両方未設定なら null (production 相当: Access ヘッダーを載せない)', () => {
    expect(resolveAccessServiceAuth({})).toBeNull();
  });

  it('両方が空白のみなら null (空文字を設定した tfvars / secret 未投入と同じ扱い)', () => {
    expect(
      resolveAccessServiceAuth({
        [ACCESS_CLIENT_ID_ENV]: '   ',
        [ACCESS_CLIENT_SECRET_ENV]: '\t\n',
      }),
    ).toBeNull();
  });

  it('両方設定なら前後の空白を落として返す', () => {
    expect(
      resolveAccessServiceAuth({
        [ACCESS_CLIENT_ID_ENV]: ` ${DUMMY_CLIENT_ID} `,
        [ACCESS_CLIENT_SECRET_ENV]: `${DUMMY_CLIENT_SECRET}\n`,
      }),
    ).toEqual({
      clientId: DUMMY_CLIENT_ID,
      clientSecret: DUMMY_CLIENT_SECRET,
    });
  });

  // 片方だけ設定された状態は「誰も通れない」ので、リクエスト時ではなく
  // 設定を読んだ時点で落とす (= 起動失敗させる)。
  it.each([
    [
      'Client ID のみ',
      { [ACCESS_CLIENT_ID_ENV]: DUMMY_CLIENT_ID },
      DUMMY_CLIENT_ID,
      ACCESS_CLIENT_SECRET_ENV,
    ],
    [
      'Client Secret のみ',
      { [ACCESS_CLIENT_SECRET_ENV]: DUMMY_CLIENT_SECRET },
      DUMMY_CLIENT_SECRET,
      ACCESS_CLIENT_ID_ENV,
    ],
  ])(
    '%s なら AccessServiceAuthConfigError で落ちる',
    (_label, env, presentValue, missingEnvName) => {
      let caught: unknown;
      try {
        resolveAccessServiceAuth(env as NodeJS.ProcessEnv);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AccessServiceAuthConfigError);
      const message = (caught as Error).message;
      // 欠けている側の**環境変数名**は出す (直し方が分かる)。
      expect(message).toContain(missingEnvName);
      // **値そのものは出さない。** 例外は Cloudflare Workers Logs に残る。
      expect(message).not.toContain(presentValue);
    },
  );
});

describe('accessAuthHeaders', () => {
  it('null なら空 (従来どおりヘッダーを載せない)', () => {
    expect(accessAuthHeaders(null)).toEqual({});
  });

  it('Cloudflare が受ける 2 ヘッダー名で載せる', () => {
    expect(
      accessAuthHeaders({
        clientId: DUMMY_CLIENT_ID,
        clientSecret: DUMMY_CLIENT_SECRET,
      }),
    ).toEqual({
      'CF-Access-Client-Id': DUMMY_CLIENT_ID,
      'CF-Access-Client-Secret': DUMMY_CLIENT_SECRET,
    });
  });
});

describe('classifyUpstreamBody', () => {
  const registerArgs = (
    over: Partial<Parameters<typeof classifyUpstreamBody>[0]>,
  ): Parameters<typeof classifyUpstreamBody>[0] => ({
    status: 201,
    contentType: 'application/json',
    text: JSON.stringify({ client_id: 'generated' }),
    requiredField: 'client_id',
    ...over,
  });

  it('DCR 成功 (201 + client_id) は status と本文をそのまま通す', () => {
    const body = JSON.stringify({ client_id: 'generated' });
    expect(classifyUpstreamBody(registerArgs({ text: body }))).toEqual({
      ok: true,
      status: 201,
      body,
    });
  });

  it('token 成功 (200 + access_token) も通す', () => {
    const body = JSON.stringify({ access_token: 'at', token_type: 'Bearer' });
    expect(
      classifyUpstreamBody({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        text: body,
        requiredField: 'access_token',
      }),
    ).toEqual({ ok: true, status: 200, body });
  });

  // Content-Type を**合否には使わない**ことの固定 (実装コメントの根拠)。
  // 経路が正しい JSON に別の Content-Type を付けただけで正常な DCR を
  // 502 にしないため。
  it('Content-Type が無くても JSON として読めて必須項目があれば通す', () => {
    const body = JSON.stringify({ client_id: 'generated' });
    expect(
      classifyUpstreamBody(registerArgs({ contentType: null, text: body })),
    ).toEqual({ ok: true, status: 201, body });
  });

  it('3xx は redirect として落とす', () => {
    expect(
      classifyUpstreamBody(registerArgs({ status: 302, text: '' })),
    ).toEqual({ ok: false, rejection: 'redirect' });
  });

  it('200 + text/html (Access ログイン画面) は non_json_content_type で落とす', () => {
    expect(
      classifyUpstreamBody(
        registerArgs({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          text: '<!DOCTYPE html><html><body>Sign in</body></html>',
        }),
      ),
    ).toEqual({ ok: false, rejection: 'non_json_content_type' });
  });

  it('200 + application/json だが壊れた JSON は invalid_json で落とす', () => {
    expect(
      classifyUpstreamBody(
        registerArgs({ status: 200, text: '{"client_id":' }),
      ),
    ).toEqual({ ok: false, rejection: 'invalid_json' });
  });

  it('2xx + 空 body は empty_body で落とす', () => {
    expect(
      classifyUpstreamBody(registerArgs({ status: 200, text: '   ' })),
    ).toEqual({ ok: false, rejection: 'empty_body' });
  });

  // `JSON.parse('null')` は例外を投げずに null を返す。parse 成否を値で
  // 判定していると成功扱いに転ぶので、明示的に固定する。
  it.each(['null', '"a string"', '123', '[{"client_id":"x"}]'])(
    '2xx でオブジェクトでない JSON (%s) は invalid_json で落とす',
    (text) => {
      expect(classifyUpstreamBody(registerArgs({ status: 200, text }))).toEqual(
        { ok: false, rejection: 'invalid_json' },
      );
    },
  );

  it.each([
    ['項目そのものが無い', JSON.stringify({ client_secret: 'x' })],
    ['空文字', JSON.stringify({ client_id: '' })],
    ['空白のみ', JSON.stringify({ client_id: '   ' })],
    ['文字列でない', JSON.stringify({ client_id: 12345 })],
  ])('2xx で必須項目が %s なら missing_required_field で落とす', (_l, text) => {
    expect(classifyUpstreamBody(registerArgs({ status: 200, text }))).toEqual({
      ok: false,
      rejection: 'missing_required_field',
    });
  });

  // RFC 6749 §5.2 / RFC 7591 §3.2.2 の正規エラー応答。ここを 502 に
  // 変換すると、クライアントは「やり直せば直る」失敗と区別できなくなる。
  it('4xx の OAuth JSON エラーは status と本文を維持する', () => {
    const body = JSON.stringify({
      error: 'invalid_grant',
      error_description: 'code expired',
    });
    expect(
      classifyUpstreamBody({
        status: 400,
        contentType: 'application/json',
        text: body,
        requiredField: 'access_token',
      }),
    ).toEqual({ ok: true, status: 400, body });
  });

  it('4xx で JSON として読めない本文 (Access の HTML) は転送しない', () => {
    expect(
      classifyUpstreamBody({
        status: 403,
        contentType: 'text/html',
        text: '<html>Forbidden</html>',
        requiredField: 'access_token',
      }),
    ).toEqual({ ok: false, rejection: 'non_json_error_body' });
  });

  it('5xx も JSON なら維持し、非 JSON なら落とす', () => {
    const body = JSON.stringify({ error: 'temporarily_unavailable' });
    expect(
      classifyUpstreamBody({
        status: 503,
        contentType: 'application/json',
        text: body,
        requiredField: 'access_token',
      }),
    ).toEqual({ ok: true, status: 503, body });
    expect(
      classifyUpstreamBody({
        status: 503,
        contentType: 'text/html',
        text: '<html>502 Bad Gateway</html>',
        requiredField: 'access_token',
      }),
    ).toEqual({ ok: false, rejection: 'non_json_error_body' });
  });

  it('application/problem+json のような +json も JSON として扱う', () => {
    expect(
      classifyUpstreamBody(
        registerArgs({
          status: 200,
          contentType: 'application/problem+json',
          text: 'not json at all',
        }),
      ),
    ).toEqual({ ok: false, rejection: 'invalid_json' });
  });
});

// ─── callOAuthUpstream: 実 fetch / 実サーバー相手の経路 ─────────────────────
// 他のテストは `global.fetch` を差し替えて分岐を固定するが、それだと
// **`AbortSignal.timeout()` の中断そのもの**は一度も起きない（mock が
// 用意済みの TimeoutError を返すだけ）。ここは実 fetch・実サーバーで、
// 「シグナルが中断を起こし、それが timeout として分類される」ことを見る。
/**
 * 条件が満たされるまで待つ。**固定の sleep にしない**——ソケットが閉じた
 * ことがサーバー側へ届くのは `callOAuthUpstream` が返った後で、その遅れは
 * 環境によって変わる。満たされないまま尽きたら失敗させる（黙って通さない）。
 */
const waitUntil = async (
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitUntil: 条件が ${timeoutMs}ms 以内に満たされなかった`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * chunk 境界に跨いだ UTF-8 の 1 文字。**decode を chunk ごとに独立して
 * 行うと U+FFFD に化ける**ので、割る位置を多バイト文字の途中に取る。
 */
const CHUNKED_OK_BODY = Buffer.from(
  JSON.stringify({ client_id: 'a日' }),
  'utf8',
);
/** 最初の非 ASCII バイトの**直後**。= 多バイト文字の途中。 */
const CHUNKED_OK_SPLIT_AT = CHUNKED_OK_BODY.findIndex((b) => b >= 0x80) + 1;

describe('callOAuthUpstream (実 fetch / 実サーバー)', () => {
  let server: http.Server;
  let baseUrl: string;
  let errorSpy: jest.SpyInstance;

  /**
   * 応答が「サーバー側から見て」どう終わったかを path ごとに記録する。
   *
   * **cancel したことはクライアント側からは観測できない**（どちらの経路でも
   * 返り値は `body_too_large`）。`writableFinished === false` で閉じたことが、
   * クライアントが読み切らずに切ったことの証拠になる。
   */
  const closedUnfinished = new Map<string, boolean>();

  /** 終端しないまま chunk を送り続ける。クライアントが切るまで止まらない。 */
  const streamUntilClientLeaves = (
    path: string,
    res: http.ServerResponse,
  ): void => {
    res.on('close', () => {
      closedUnfinished.set(path, !res.writableFinished);
    });
    // cancel でソケットが落ちるので EPIPE / ECONNRESET が来る。拾わないと
    // unhandled 'error' でテストプロセスごと落ちる。
    res.on('error', () => {});

    const chunk = 'a'.repeat(16 * 1024);
    const pump = (): void => {
      if (res.destroyed || res.writableEnded) return;
      if (res.write(chunk)) {
        setImmediate(pump);
        return;
      }
      res.once('drain', pump);
    };
    pump();
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/never-responds') {
        // 応答を返さない。AbortSignal.timeout が実際に中断するのを待つ。
        return;
      }
      if (req.url === '/chunked-huge') {
        // **`content-length` を付けない** (Node が chunked にする)。宣言値による
        // 早期拒否は効かないので、実測の上限だけが効く経路になる。
        res.writeHead(200, { 'content-type': 'application/json' });
        streamUntilClientLeaves('/chunked-huge', res);
        return;
      }
      if (req.url === '/huge-with-body') {
        // 宣言長は上限超え、かつ**本文も送り続ける**。読まずに落ちることと、
        // 読み残しを解放して切ることの両方を見る。
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(1024 * 1024),
        });
        streamUntilClientLeaves('/huge-with-body', res);
        return;
      }
      if (req.url === '/redirect-with-body') {
        // Access のログイン画面への転送。**本文も送ってくる**ので、読まずに
        // 落とす経路でも読み残しを解放していることを見る。
        res.writeHead(302, {
          location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login',
          'content-type': 'text/html',
        });
        streamUntilClientLeaves('/redirect-with-body', res);
        return;
      }
      if (req.url === '/chunked-ok') {
        // `content-length` 無し・複数 chunk・多バイト文字を chunk 境界で割る。
        // **上限の実測化で正常な応答まで落ちないこと**を固定する (対のテスト)。
        res.writeHead(201, { 'content-type': 'application/json' });
        res.write(CHUNKED_OK_BODY.subarray(0, CHUNKED_OK_SPLIT_AT));
        // **`setImmediate` では足りない**（実測）。同じイベントループの巡りで
        // 書くと 2 つの chunk が 1 つの TCP セグメントに乗り、reader へは
        // 1 回の `read()` で届く。すると「chunk 境界に跨いだ文字」が
        // そもそも起きず、この検査が何も見ないまま通る。間を空けて分ける。
        setTimeout(() => {
          res.end(CHUNKED_OK_BODY.subarray(CHUNKED_OK_SPLIT_AT));
        }, 30);
        return;
      }
      if (req.url === '/huge') {
        // 宣言長だけを上限超えにして、**本文は 1 バイトも送らない**。
        // 本文を読まずに落ちることの確認なので、読もうとすれば
        // timeout になり、この差でテストが空振りしないことも分かる。
        //
        // `flushHeaders()` が要る: `writeHead` だけではヘッダーが送出されず、
        // `fetch` が解決しないまま timeout になる（実測）。
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(1024 * 1024),
        });
        res.flushHeaders();
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  const loggedLines = (): string =>
    errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');

  it('AbortSignal.timeout の実際の中断を timeout として分類する', async () => {
    const result = await callOAuthUpstream({
      endpoint: 'register',
      url: `${baseUrl}/never-responds`,
      body: '{}',
      requiredField: 'client_id',
      accessAuth: null,
      // 実際に中断させる。15 秒待たないための上書き。
      timeoutMs: 150,
    });

    expect(result).toEqual({ ok: false, rejection: 'timeout' });
    expect(loggedLines()).toContain('rejection=timeout');
    // 例外の種別だけをログする（message は出さない）。
    expect(loggedLines()).toContain('error=TimeoutError');
  }, 10_000);

  it('宣言された本文長が上限を超える応答は読まずに落とす', async () => {
    const result = await callOAuthUpstream({
      endpoint: 'register',
      url: `${baseUrl}/huge`,
      body: '{}',
      requiredField: 'client_id',
      accessAuth: null,
      timeoutMs: 2_000,
    });

    expect(result).toEqual({ ok: false, rejection: 'body_too_large' });
    expect(loggedLines()).toContain('rejection=body_too_large');
  }, 10_000);

  // 上限を「宣言値」でしか見ていないと、宣言しない相手には効かない。
  // **`content-length` の無い chunked 応答**で、実測の上限が効くことを見る。
  it('content-length が無い chunked 応答も実測バイト数で body_too_large にする', async () => {
    const result = await callOAuthUpstream({
      endpoint: 'register',
      url: `${baseUrl}/chunked-huge`,
      body: '{}',
      requiredField: 'client_id',
      accessAuth: null,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ ok: false, rejection: 'body_too_large' });
    expect(loggedLines()).toContain('rejection=body_too_large');
    // サーバーは終端していないので、切ったのはクライアント側。
    await waitUntil(() => closedUnfinished.get('/chunked-huge') === true);
  }, 15_000);

  // 宣言値で早期拒否する経路でも、読み残しを掴んだままにしない。
  it('宣言長超過で落とすときも読み残しのストリームを解放する', async () => {
    const result = await callOAuthUpstream({
      endpoint: 'register',
      url: `${baseUrl}/huge-with-body`,
      body: '{}',
      requiredField: 'client_id',
      accessAuth: null,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ ok: false, rejection: 'body_too_large' });
    await waitUntil(() => closedUnfinished.get('/huge-with-body') === true);
  }, 15_000);

  // redirect も「読まずに落とす」経路。同じく掴んだままにしない。
  it('redirect を落とすときも読み残しのストリームを解放する', async () => {
    const result = await callOAuthUpstream({
      endpoint: 'register',
      url: `${baseUrl}/redirect-with-body`,
      body: '{}',
      requiredField: 'client_id',
      accessAuth: null,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ ok: false, rejection: 'redirect' });
    // Location も本文もログに出ていない。
    expect(loggedLines()).toContain('rejection=redirect');
    expect(loggedLines()).not.toContain('cloudflareaccess.com');
    await waitUntil(() => closedUnfinished.get('/redirect-with-body') === true);
  }, 15_000);

  // 対のテスト: 上限の実測化が**正常な応答を落とすようになっていない**こと。
  // chunk 境界で割った多バイト文字が壊れていないことも同時に見る。
  it('content-length が無い複数 chunk の正常な DCR 応答は通す (文字化けしない)', async () => {
    // 割る位置が本当に多バイト文字の途中であることを固定する
    // (ASCII だけの本文になっていたら、この検査は何も見ていない)。
    expect(CHUNKED_OK_SPLIT_AT).toBeGreaterThan(0);
    expect(CHUNKED_OK_BODY[CHUNKED_OK_SPLIT_AT]).toBeGreaterThanOrEqual(0x80);

    const result = await callOAuthUpstream({
      endpoint: 'register',
      url: `${baseUrl}/chunked-ok`,
      body: '{}',
      requiredField: 'client_id',
      accessAuth: null,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      ok: true,
      status: 201,
      body: JSON.stringify({ client_id: 'a日' }),
    });
    expect(loggedLines()).toBe('');
  }, 15_000);
});

// 上の実サーバー版は「2 回の `res.write` が 2 回の `read()` になる」ことを
// **TCP と fetch 実装のタイミングに任せている**。実測で `setImmediate` だと
// 1 回にまとめられたので間隔を空けたが、それは**この環境でそうなった**という
// だけで、結合も再分割もされうる（PR #134 の CodeRabbit 指摘）。
//
// そこで、chunk の切れ目を**こちらで決める**版を別に置く。実サーバー版は
// 経路全体（実 fetch・実 HTTP・chunked 転送）を通す価値があるので残す。
describe('callOAuthUpstream (chunk 境界を固定した UTF-8 分割)', () => {
  const realFetch = global.fetch;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = realFetch;
    errorSpy.mockRestore();
  });

  it('多バイト文字の途中で 2 chunk に割れても文字化けしない', () => {
    // 割る位置が本当に多バイト文字の途中であることを固定する
    // (ASCII だけの本文になっていたら、この検査は何も見ていない)。
    expect(CHUNKED_OK_SPLIT_AT).toBeGreaterThan(0);
    expect(CHUNKED_OK_BODY[CHUNKED_OK_SPLIT_AT]).toBeGreaterThanOrEqual(0x80);

    // **ちょうど 2 回の `read()` になる**ストリームを作る。
    global.fetch = jest.fn(() =>
      Promise.resolve({
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new Uint8Array(CHUNKED_OK_BODY.subarray(0, CHUNKED_OK_SPLIT_AT)),
            );
            controller.enqueue(
              new Uint8Array(CHUNKED_OK_BODY.subarray(CHUNKED_OK_SPLIT_AT)),
            );
            controller.close();
          },
        }),
      }),
    ) as unknown as typeof fetch;

    return expect(
      callOAuthUpstream({
        endpoint: 'register',
        url: 'https://example.invalid/api/v1/oauth/register',
        body: '{}',
        requiredField: 'client_id',
        accessAuth: null,
      }),
    ).resolves.toEqual({
      ok: true,
      status: 201,
      body: JSON.stringify({ client_id: 'a日' }),
    });
  });
});

describe('upstreamPathOf', () => {
  it('パスだけを返す (host も query も落とす)', () => {
    expect(
      upstreamPathOf(
        'https://stg.re-port-flow.com/api/v1/oauth/token?secret=leaked',
      ),
    ).toBe('/api/v1/oauth/token');
  });

  it('URL として読めない値でもログを壊さない', () => {
    expect(upstreamPathOf('not a url')).toBe('(unparsable)');
  });
});

describe('errorNameOf', () => {
  it('Error の name を返す', () => {
    const err = new Error('boom');
    err.name = 'TimeoutError';
    expect(errorNameOf(err)).toBe('TimeoutError');
  });

  it.each([
    ['文字列', 'boom'],
    ['undefined', undefined],
    ['null', null],
    ['数値', 42],
    ['name を持たないオブジェクト', { message: 'boom' }],
    ['name が文字列でないオブジェクト', { name: 123 }],
  ])('name を読めない値 (%s) は unknown', (_l, value) => {
    expect(errorNameOf(value)).toBe('unknown');
  });

  // **`instanceof Error` では絞らない**（realm を跨ぐと DOMException が
  // 外れて timeout が network_error に化ける。実装コメント参照）。
  // `name` が文字列のオブジェクトは、プロトタイプ鎖に関わらず読む。
  it('DOMException のような Error 以外の throwable でも name を読む', () => {
    expect(errorNameOf(new DOMException('aborted', 'TimeoutError'))).toBe(
      'TimeoutError',
    );
  });

  it('プロトタイプ鎖に依存せず name を読む (cross-realm 相当)', () => {
    expect(errorNameOf({ name: 'TimeoutError' })).toBe('TimeoutError');
  });

  it('name が空文字の Error も unknown', () => {
    const err = new Error('boom');
    err.name = '';
    expect(errorNameOf(err)).toBe('unknown');
  });

  // message は取らない (上流由来の文字列がログへ出る経路を作らない)。
  it('message を返さない', () => {
    expect(errorNameOf(new Error('<html>Access login</html>'))).not.toContain(
      'html',
    );
  });
});

// PRJ-3-1580: どのホストが Access 境界の内側かの判定。ここを間違えると
// **Access と無関係のホストへ資格情報を送る**ので、境界の外側へ倒れる条件を
// 明示的に固定する。
describe('isAccessBoundaryUrl', () => {
  const saved = process.env['REPORTFLOW_AUTH_URL'];

  afterEach(() => {
    if (saved === undefined) delete process.env['REPORTFLOW_AUTH_URL'];
    else process.env['REPORTFLOW_AUTH_URL'] = saved;
  });

  // test-setup.ts の既定は http://localhost:3000/api/v1
  it('ホストが一致すれば境界の内側 (パスは問わない)', () => {
    expect(isAccessBoundaryUrl('http://localhost:3000/api/v1/public/x')).toBe(
      true,
    );
    expect(isAccessBoundaryUrl('http://localhost:3000/anything')).toBe(true);
  });

  it('port が違えば別ホスト (content-service は境界の外)', () => {
    expect(isAccessBoundaryUrl('http://localhost:3002/v1/file/designs')).toBe(
      false,
    );
  });

  it('別ドメインは境界の外', () => {
    expect(isAccessBoundaryUrl('https://evil.example/api/v1')).toBe(false);
  });

  // **scheme を跨いだ一致は起こらない** (PR #136 の CodeRabbit 指摘)。
  // `URL.host` は scheme を含まず、既定ポートは省略されるので、host で比較すると
  // https の基準に平文 http の要求が一致してしまい、Client Secret が平文で出る。
  describe('scheme を区別する', () => {
    it('基準が https なら同ホストの http は境界の外', () => {
      process.env['REPORTFLOW_AUTH_URL'] = 'https://re-port-flow.com/api/v1';
      expect(isAccessBoundaryUrl('https://re-port-flow.com/api/v1/x')).toBe(
        true,
      );
      expect(isAccessBoundaryUrl('http://re-port-flow.com/api/v1/x')).toBe(
        false,
      );
    });

    it('基準が http なら同ホストの https は境界の外', () => {
      process.env['REPORTFLOW_AUTH_URL'] = 'http://localhost:3000/api/v1';
      expect(isAccessBoundaryUrl('http://localhost:3000/x')).toBe(true);
      expect(isAccessBoundaryUrl('https://localhost:3000/x')).toBe(false);
    });

    // origin は既定ポートを省略するので、明示しても同一 origin になる。
    it('既定ポートの明示は同じ origin として扱う', () => {
      process.env['REPORTFLOW_AUTH_URL'] = 'https://re-port-flow.com/api/v1';
      expect(isAccessBoundaryUrl('https://re-port-flow.com:443/x')).toBe(true);
    });

    it('http(s) 以外のスキームは境界の外', () => {
      process.env['REPORTFLOW_AUTH_URL'] = 'https://re-port-flow.com/api/v1';
      expect(isAccessBoundaryUrl('ftp://re-port-flow.com/x')).toBe(false);
      expect(isAccessBoundaryUrl('file:///etc/passwd')).toBe(false);
    });

    it('基準が http(s) 以外なら誰も境界の内側にしない', () => {
      process.env['REPORTFLOW_AUTH_URL'] = 'ftp://re-port-flow.com/api/v1';
      expect(isAccessBoundaryUrl('ftp://re-port-flow.com/api/v1/x')).toBe(
        false,
      );
      expect(isAccessBoundaryUrl('https://re-port-flow.com/api/v1/x')).toBe(
        false,
      );
    });
  });

  // **fail-safe**: 判定できないときは資格情報を送らない側へ倒す。
  it('URL として読めない要求先は境界の外として扱う', () => {
    expect(isAccessBoundaryUrl('not a url')).toBe(false);
    expect(isAccessBoundaryUrl('')).toBe(false);
  });

  it('基準側 (REPORTFLOW_AUTH_URL) が読めない値なら誰も内側にしない', () => {
    process.env['REPORTFLOW_AUTH_URL'] = 'not a url';
    expect(isAccessBoundaryUrl('https://re-port-flow.com/api/v1')).toBe(false);
    expect(isAccessBoundaryUrl('not a url')).toBe(false);
  });
});

describe('accessAuthHeadersForUrl', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved[ACCESS_CLIENT_ID_ENV] = process.env[ACCESS_CLIENT_ID_ENV];
    saved[ACCESS_CLIENT_SECRET_ENV] = process.env[ACCESS_CLIENT_SECRET_ENV];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('境界の内側 + 2 値ありでのみヘッダーを返す', () => {
    const env = {
      [ACCESS_CLIENT_ID_ENV]: DUMMY_CLIENT_ID,
      [ACCESS_CLIENT_SECRET_ENV]: DUMMY_CLIENT_SECRET,
    } as NodeJS.ProcessEnv;

    expect(
      accessAuthHeadersForUrl('http://localhost:3000/api/v1/x', env),
    ).toEqual({
      'CF-Access-Client-Id': DUMMY_CLIENT_ID,
      'CF-Access-Client-Secret': DUMMY_CLIENT_SECRET,
    });
    expect(
      accessAuthHeadersForUrl('http://localhost:3002/v1/file', env),
    ).toEqual({});
  });

  it('2 値が無ければ境界の内側でも空', () => {
    expect(
      accessAuthHeadersForUrl('http://localhost:3000/api/v1/x', {}),
    ).toEqual({});
  });

  // 境界の外では解決自体を行わないので、半端な設定が content-service への
  // 要求を巻き添えで落とさない。
  it('片方だけの設定は境界の内側でだけ失敗する', () => {
    const half = {
      [ACCESS_CLIENT_ID_ENV]: DUMMY_CLIENT_ID,
    } as NodeJS.ProcessEnv;

    expect(() =>
      accessAuthHeadersForUrl('http://localhost:3000/api/v1/x', half),
    ).toThrow(AccessServiceAuthConfigError);
    expect(
      accessAuthHeadersForUrl('http://localhost:3002/v1/file', half),
    ).toEqual({});
  });
});

// PRJ-3-1581 の CodeRabbit 指摘。
//
// `readBodyWithLimit` は上限超過を検出した時点で reader を cancel する。
// そこで素の `reader.cancel()` を await していたため、cancel が reject すると
// **確定済みの `body_too_large` が呼び出し側の catch で `network_error` に
// 化けて**いた。運用側は「上限を超えた」と「上流に届かなかった」で次の手が
// 違うので、分類が塗り替わるのは実害になる。
describe('callOAuthUpstream (上限超過時に cancel が失敗するストリーム)', () => {
  const realFetch = global.fetch;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = realFetch;
    errorSpy.mockRestore();
  });

  /**
   * 上限 (64 KiB) を必ず超える chunked ストリーム。**`content-length` を付けない**
   * ——宣言値による早期拒否ではなく、`readBodyWithLimit` の実測での打ち切りを
   * 通らせるため。reader の `cancel` は reject させる。
   */
  const oversizedStreamWithFailingCancel = (): ReadableStream<Uint8Array> => {
    const chunk = new Uint8Array(32 * 1024).fill(0x61); // 'a'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    // reader は `getReader()` のたびに新しく作られるので、prototype 側を差し替える。
    const realGetReader = stream.getReader.bind(stream);
    stream.getReader = (() => {
      const reader = realGetReader();
      reader.cancel = () => Promise.reject(new TypeError('cancel failed'));
      return reader;
    }) as typeof stream.getReader;
    return stream;
  };

  const callWithBody = (body: ReadableStream<Uint8Array>) => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body,
      }),
    ) as unknown as typeof fetch;

    return callOAuthUpstream({
      endpoint: 'register',
      url: 'https://example.invalid/api/v1/oauth/register',
      body: '{}',
      requiredField: 'client_id',
      accessAuth: null,
    });
  };

  it('cancel が reject しても body_too_large のまま (network_error に化けない)', async () => {
    await expect(
      callWithBody(oversizedStreamWithFailingCancel()),
    ).resolves.toEqual({
      ok: false,
      rejection: 'body_too_large',
    });
  });

  it('ログの rejection も body_too_large で出る', async () => {
    await callWithBody(oversizedStreamWithFailingCancel());
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('rejection=body_too_large');
    expect(logged).not.toContain('rejection=network_error');
  });
});
