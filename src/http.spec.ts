import {
  fetchJson,
  fetchJsonWithHeaders,
  fetchBinary,
  fetchBinaryWithHeaders,
  fetchHeadersOnly,
  formatHttpErrorMessage,
  HttpError,
} from './http.js';
import {
  createInvocationUpstream,
  runWithInvocationUpstream,
  type InvocationUpstream,
} from './telemetry/upstream.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

type ResOverrides = {
  ok?: boolean;
  status?: number;
  statusText?: string;
};

const makeRes = (
  body: Record<string, unknown>,
  { ok = true, status = 200, statusText = 'OK' }: ResOverrides = {},
): { res: Response; cancel: jest.Mock } => {
  const cancel = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  const res = {
    ok,
    status,
    statusText,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    headers: new Headers({ 'File-URL': 'https://files.example/x.pdf' }),
    body: { cancel },
  } as unknown as Response;
  return { res, cancel };
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('http/fetchJson', () => {
  it('returns parsed JSON on success', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({ a: 1 }).res);
    await expect(fetchJson('https://x')).resolves.toEqual({ a: 1 });
  });

  it('throws HttpError using body.message on non-ok', async () => {
    mockFetch.mockResolvedValueOnce(
      makeRes(
        { message: 'boom' },
        { ok: false, status: 500, statusText: 'ISE' },
      ).res,
    );
    await expect(fetchJson('https://x')).rejects.toThrow('[500] boom');
  });

  it('falls back to error_description when message is absent', async () => {
    mockFetch.mockResolvedValueOnce(
      makeRes(
        { error_description: 'desc' },
        { ok: false, status: 400, statusText: 'Bad' },
      ).res,
    );
    await expect(fetchJson('https://x')).rejects.toThrow('[400] desc');
  });

  it('falls back to statusText when the error body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response);
    await expect(fetchJson('https://x')).rejects.toThrow('[502] Bad Gateway');
  });

  it('aborts immediately when given an already-aborted signal', async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return signal.aborted
        ? Promise.reject(new Error('aborted'))
        : Promise.resolve(makeRes({}).res);
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      fetchJson('https://x', { signal: ac.signal }),
    ).rejects.toThrow();
  });

  it('resolves normally while a live caller signal stays unaborted', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({ ok: true }).res);
    const ac = new AbortController();
    await expect(
      fetchJson('https://x', { signal: ac.signal }),
    ).resolves.toEqual({ ok: true });
  });

  it('propagates a live caller abort to the in-flight request', async () => {
    // withTimeout が caller signal に abort リスナーを登録し、abort が発火すると
    // 内部 controller (fetch に渡す signal) へ伝播することを実際に検証する。
    mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new Error('aborted by caller')),
        );
      });
    });
    const ac = new AbortController();
    const promise = fetchJson('https://x', { signal: ac.signal });
    ac.abort();
    await expect(promise).rejects.toThrow('aborted by caller');
  });
});

// ─── 構造化エラー本文 (PRJ-3-2017) ──────────────────────────────────────────
// content-service は `{ statusCode, code, message, error, details, docsUrl }` を返す。
// ツールは `エラー: ${err.message}` をそのまま LLM に渡すので、message に
// code / details / retryAfter / docsUrl が載ることを HTTP 層で固定する。
describe('http — 構造化エラー本文 (PRJ-3-2017)', () => {
  const errorRes = (
    body: unknown,
    status: number,
    headers: Record<string, string> = {},
  ): Response =>
    ({
      ok: false,
      status,
      statusText: 'ERR',
      json: () => Promise.resolve(body),
      headers: new Headers(headers),
    }) as unknown as Response;

  const thrown = async (res: Response): Promise<HttpError> => {
    mockFetch.mockResolvedValueOnce(res);
    const err = await fetchJson('https://x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  };

  it('code / message / docsUrl を文言とプロパティの両方に載せる', async () => {
    const err = await thrown(
      errorRes(
        {
          statusCode: 403,
          code: 'PLAN_PAGE_LIMIT_EXCEEDED',
          message: 'Monthly page limit reached (100 pages).',
          error: 'Forbidden',
          details: [],
          docsUrl:
            'https://doc.re-port-flow.com/en/docs/guides/error-codes#plan_page_limit_exceeded',
        },
        403,
      ),
    );
    expect(err.status).toBe(403);
    expect(err.code).toBe('PLAN_PAGE_LIMIT_EXCEEDED');
    expect(err.details).toEqual([]);
    expect(err.retryAfter).toBeUndefined();
    expect(err.message).toBe(
      '[403] PLAN_PAGE_LIMIT_EXCEEDED: Monthly page limit reached (100 pages).\n' +
        'Docs: https://doc.re-port-flow.com/en/docs/guides/error-codes#plan_page_limit_exceeded',
    );
  });

  it('details は先頭 3 件を field / expected つきで並べ、残りは件数だけ出す', async () => {
    const err = await thrown(
      errorRes(
        {
          code: 'PARAMS_TYPE_MISMATCH',
          message: 'params has values of the wrong type.',
          details: [
            {
              field: 'params.amount',
              expected: 'number',
              code: 'PARAMS_TYPE_MISMATCH',
              message: 'must be a number',
            },
            { field: 'params.date', message: 'must be a date' },
            { message: 'no field here' },
            { field: 'params.x', message: 'fourth' },
            { field: 'params.y', message: 'fifth' },
            // 形の崩れた項目は捨てる (推測で埋めない)
            { field: 'params.z' },
            null,
            'str',
          ],
        },
        400,
      ),
    );
    expect(err.details).toHaveLength(5);
    expect(err.details[0]).toEqual({
      field: 'params.amount',
      expected: 'number',
      code: 'PARAMS_TYPE_MISMATCH',
      message: 'must be a number',
    });
    expect(err.details[2]).toEqual({ message: 'no field here' });
    expect(err.message).toBe(
      '[400] PARAMS_TYPE_MISMATCH: params has values of the wrong type.\n' +
        'Details: params.amount: must be a number (expected: number); ' +
        'params.date: must be a date; no field here (+2 more)',
    );
  });

  it('バリデーションエラーの配列 message は "; " で連結する', async () => {
    const err = await thrown(
      errorRes(
        {
          code: 'VALIDATION_FAILED',
          message: ['fileName must not contain / \\ : * ? " < > |', 42],
          details: [{ field: 'content.fileName', message: 'bad' }],
        },
        400,
      ),
    );
    expect(err.message).toBe(
      '[400] VALIDATION_FAILED: fileName must not contain / \\ : * ? " < > |\n' +
        'Details: content.fileName: bad',
    );
  });

  it('本文の retryAfter を再試行秒数として載せる (409 FILE_NOT_READY)', async () => {
    const err = await thrown(
      errorRes(
        {
          code: 'FILE_NOT_READY',
          message: 'File is still being generated.',
          retryAfter: 2,
        },
        409,
        { 'Retry-After': '9' },
      ),
    );
    // 本文の値を優先する
    expect(err.retryAfter).toBe(2);
    expect(err.message).toBe(
      '[409] FILE_NOT_READY: File is still being generated.\nRetry after: 2 seconds',
    );
  });

  it('本文に retryAfter が無ければ Retry-After ヘッダーの秒数を使う', async () => {
    const err = await thrown(
      errorRes({ code: 'RATE_LIMITED', message: 'Too many.' }, 429, {
        'Retry-After': ' 30 ',
      }),
    );
    expect(err.retryAfter).toBe(30);
  });

  it.each([
    ['HTTP-date 形式', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }, -1],
    ['負の本文値', {}, -5],
    ['NaN の本文値', {}, Number.NaN],
  ])(
    '秒数として読めない値は捨てる (%s)',
    async (_label, headers, bodyValue) => {
      const err = await thrown(
        errorRes(
          { code: 'RATE_LIMITED', message: 'm', retryAfter: bodyValue },
          429,
          headers,
        ),
      );
      expect(err.retryAfter).toBeUndefined();
      expect(err.message).not.toContain('Retry after');
    },
  );

  it('https 以外の docsUrl は載せない', async () => {
    const err = await thrown(
      errorRes(
        { code: 'X', message: 'm', docsUrl: 'javascript:alert(1)' },
        400,
      ),
    );
    expect(err.docsUrl).toBeUndefined();
    expect(err.message).toBe('[400] X: m');
  });

  it('JSON がオブジェクトでなければ statusText を使う', async () => {
    const err = await thrown(errorRes(['not', 'an', 'object'], 500));
    expect(err.message).toBe('[500] ERR');
    expect(err.code).toBeUndefined();
  });

  it('非 JSON 本文でも Retry-After ヘッダーは読む', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      headers: new Headers({ 'Retry-After': '5' }),
    } as unknown as Response);
    const err = (await fetchJson('https://x').catch(
      (e: unknown) => e,
    )) as HttpError;
    expect(err.retryAfter).toBe(5);
    expect(err.message).toBe(
      '[503] Service Unavailable\nRetry after: 5 seconds',
    );
  });

  it('formatHttpErrorMessage: code 無し・details 3 件ちょうどは件数注記を付けない', () => {
    expect(
      formatHttpErrorMessage(400, 'bad', {
        details: [{ message: 'a' }, { message: 'b' }, { message: 'c' }],
      }),
    ).toBe('[400] bad\nDetails: a; b; c');
  });
});

describe('http/fetchJsonWithHeaders', () => {
  it('returns parsed JSON and response headers on success', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({ status: 'processing' }).res);
    const { data, headers } = await fetchJsonWithHeaders<{ status: string }>(
      'https://x',
    );
    expect(data).toEqual({ status: 'processing' });
    expect(headers.get('File-URL')).toEqual('https://files.example/x.pdf');
  });
});

describe('http/fetchBinary', () => {
  it('returns the ArrayBuffer on success', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({}).res);
    const buf = await fetchBinary('https://x');
    expect(buf.byteLength).toEqual(8);
  });

  it('throws HttpError on non-ok', async () => {
    mockFetch.mockResolvedValueOnce(
      makeRes({ message: 'nope' }, { ok: false, status: 404, statusText: 'NF' })
        .res,
    );
    await expect(fetchBinary('https://x')).rejects.toThrow('[404] nope');
  });
});

describe('http/fetchBinaryWithHeaders', () => {
  it('returns data and response headers on success', async () => {
    mockFetch.mockResolvedValueOnce(makeRes({}).res);
    const { data, headers } = await fetchBinaryWithHeaders('https://x');
    expect(data.byteLength).toEqual(8);
    expect(headers.get('File-URL')).toEqual('https://files.example/x.pdf');
  });
});

describe('http/fetchHeadersOnly', () => {
  it('cancels the body stream and returns headers on success', async () => {
    const { res, cancel } = makeRes({});
    mockFetch.mockResolvedValueOnce(res);
    const headers = await fetchHeadersOnly('https://x');
    expect(headers.get('File-URL')).toEqual('https://files.example/x.pdf');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  // 対のテスト (PRJ-3-1582): 応答は既に手元にあるので、解放に失敗しただけで
  // 呼び出しを失敗させない。素の `res.body?.cancel()` に戻すとここが落ちる。
  it('still returns headers when cancelling the body rejects', async () => {
    const { res, cancel } = makeRes({});
    cancel.mockRejectedValueOnce(new TypeError('already released'));
    mockFetch.mockResolvedValueOnce(res);
    const headers = await fetchHeadersOnly('https://x');
    expect(headers.get('File-URL')).toEqual('https://files.example/x.pdf');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('throws HttpError on non-ok', async () => {
    mockFetch.mockResolvedValueOnce(
      makeRes({ message: 'bad' }, { ok: false, status: 500, statusText: 'ISE' })
        .res,
    );
    await expect(fetchHeadersOnly('https://x')).rejects.toThrow('[500] bad');
  });
});

// 上流失敗の記録 (`telemetry/upstream.ts`)。**本番でこの値を作るのはここ**なので、
// interceptor 側のテスト（スロットへ直接書く）とは別に、HTTP 層が実際に記録する
// ことを固定する。
describe('http — 上流失敗の記録', () => {
  const capture = async (
    run: () => Promise<unknown>,
  ): Promise<InvocationUpstream> => {
    const slot = createInvocationUpstream();
    await runWithInvocationUpstream(slot, async () => {
      await expect(run()).rejects.toThrow();
    });
    return slot;
  };

  it('!ok 応答はステータスを記録する', async () => {
    mockFetch.mockResolvedValueOnce(
      makeRes({ message: 'no' }, { ok: false, status: 403, statusText: 'F' })
        .res,
    );

    const slot = await capture(() => fetchJson('https://x'));

    expect(slot.requestCount).toBe(1);
    expect(slot.failureCount).toBe(1);
    expect(slot.last).toEqual({ status: 403, errorClass: 'HttpError' });
  });

  // 応答が返っていないのでステータスは観測できていない。
  it('応答が返らなかったときはステータスを持たない', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const slot = await capture(() => fetchJson('https://x'));

    expect(slot.failureCount).toBe(1);
    expect(slot.last).toEqual({ errorClass: 'TypeError' });
  });

  // CDN が API 応答を SPA の HTML (200) に差し替える経路
  // (`gallery-client.ts` の getGalleryTemplateBySlug 参照)。
  it('2xx だが本文を読めなかったときはステータスと読み取り側のクラス名を記録する', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response);

    const slot = await capture(() => fetchJson('https://x'));

    expect(slot.failureCount).toBe(1);
    expect(slot.last).toEqual({ status: 200, errorClass: 'SyntaxError' });
  });

  it('binary / headers-only ヘルパーも同じ経路で記録する', async () => {
    mockFetch.mockResolvedValueOnce(
      makeRes({}, { ok: false, status: 404, statusText: 'NF' }).res,
    );
    const binary = await capture(() => fetchBinaryWithHeaders('https://x'));
    expect(binary.last).toEqual({ status: 404, errorClass: 'HttpError' });

    mockFetch.mockResolvedValueOnce(
      makeRes({}, { ok: false, status: 502, statusText: 'BG' }).res,
    );
    const headersOnly = await capture(() => fetchHeadersOnly('https://x'));
    expect(headersOnly.last).toEqual({ status: 502, errorClass: 'HttpError' });
  });

  // 「上流を一度も呼ばずに失敗した」と区別できるよう本数は数える。
  it('成功したリクエストは本数だけ数え、失敗は記録しない', async () => {
    const slot = createInvocationUpstream();
    mockFetch.mockResolvedValueOnce(makeRes({ a: 1 }).res);

    await runWithInvocationUpstream(slot, () => fetchJson('https://x'));

    expect(slot).toEqual({ requestCount: 1, failureCount: 0 });
  });

  it('上流を呼ばなかった呼び出しは本数 0 のまま', async () => {
    const slot = createInvocationUpstream();

    await runWithInvocationUpstream(slot, async () => undefined);

    expect(slot).toEqual({ requestCount: 0, failureCount: 0 });
  });

  // 呼び出しスコープ外 (どのツール呼び出しにも属さない上流アクセス) で
  // 失敗しても throw の挙動は変わらない。
  it('スコープ外でも従来どおり HttpError を投げる', async () => {
    mockFetch.mockResolvedValueOnce(
      makeRes(
        { message: 'boom' },
        { ok: false, status: 500, statusText: 'ISE' },
      ).res,
    );
    await expect(fetchJson('https://x')).rejects.toThrow('[500] boom');
  });
});

// ─── Cloudflare Access Service Auth (PRJ-3-1580) ─────────────────────────────
//
// test-setup.ts の既定:
//   REPORTFLOW_AUTH_URL      = http://localhost:3000/api/v1  … Access 境界
//   REPORTFLOW_API_BASE_URL  = http://localhost:3002         … content-service
// ホストが port まで違うので、「境界だけに載る」ことを実際に区別できる。
describe('http/Access service auth', () => {
  const ACCESS_URL =
    'http://localhost:3000/api/v1/ws-1/my/templates/x/duplicate';
  const CONTENT_URL = 'http://localhost:3002/v1/file/designs';
  const ID = 'RF_ACCESS_CLIENT_ID';
  const SECRET = 'RF_ACCESS_CLIENT_SECRET';

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [ID, SECRET, 'REPORTFLOW_AUTH_URL']) {
      saved[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const setAuth = (): void => {
    process.env[ID] = 'svc-token-id.access';
    process.env[SECRET] = 'svc-token-secret';
  };

  /** 直近の fetch に渡ったヘッダーを、形に依存せず読む。 */
  const sentHeaders = (): Headers => {
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    return new Headers(init.headers);
  };

  // ケース 1 相当 (seam レベル): 境界ホスト + 2 値あり → 載る
  it('境界ホストへは 2 値が揃っているときヘッダーを載せる', async () => {
    setAuth();
    mockFetch.mockResolvedValueOnce(makeRes({ ok: 1 }).res);

    await fetchJson(ACCESS_URL, { headers: { Accept: 'application/json' } });

    const headers = sentHeaders();
    expect(headers.get('CF-Access-Client-Id')).toBe('svc-token-id.access');
    expect(headers.get('CF-Access-Client-Secret')).toBe('svc-token-secret');
    // 呼び出し側のヘッダーは残る。
    expect(headers.get('Accept')).toBe('application/json');
  });

  // ケース 2: 境界ホスト + 2 値なし → 載らない (production 相当の従来動作)
  it('2 値が無ければ境界ホストでも載せない', async () => {
    delete process.env[ID];
    delete process.env[SECRET];
    mockFetch.mockResolvedValueOnce(makeRes({ ok: 1 }).res);

    await fetchJson(ACCESS_URL, { headers: { Accept: 'application/json' } });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(sentHeaders().get('CF-Access-Client-Id')).toBeNull();
    // 載せないときは呼び出し側の headers を**そのまま**渡す (従来動作の維持)。
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init.redirect).toBeUndefined();
  });

  // ケース 3: 片方だけ → fail-fast。例外に**値が入らない**
  it('片方だけ設定されていれば要求を出さずに落ちる (値は例外に出ない)', async () => {
    process.env[ID] = 'svc-token-id.access';
    delete process.env[SECRET];

    await expect(fetchJson(ACCESS_URL)).rejects.toThrow(
      'Cloudflare Access service auth is half-configured',
    );
    // 要求そのものを出していない。
    expect(mockFetch).not.toHaveBeenCalled();

    await expect(fetchJson(ACCESS_URL)).rejects.not.toThrow(
      /svc-token-id\.access/,
    );
  });

  // ケース 4 (**対のテスト**): content-service へは載せない。
  // これが落ちなくなると「Access と無関係のホストへ資格情報を送る」退行を
  // 検知できない。
  it('content-service ホストへは 2 値があっても載せない', async () => {
    setAuth();
    mockFetch.mockResolvedValueOnce(makeRes({ ok: 1 }).res);

    await fetchJson(CONTENT_URL, {
      headers: { Authorization: 'Bearer t' },
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(sentHeaders().get('CF-Access-Client-Id')).toBeNull();
    expect(sentHeaders().get('CF-Access-Client-Secret')).toBeNull();
    expect(init.headers).toEqual({ Authorization: 'Bearer t' });
    // 追従の既定も変えない。
    expect(init.redirect).toBeUndefined();
  });

  it('片方だけ設定されていても content-service への要求は巻き添えにしない', async () => {
    process.env[ID] = 'svc-token-id.access';
    delete process.env[SECRET];
    mockFetch.mockResolvedValueOnce(makeRes({ ok: 1 }).res);

    await expect(fetchJson(CONTENT_URL)).resolves.toEqual({ ok: 1 });
  });

  // ケース 6: REPORTFLOW_AUTH_URL の override に判定が追従する
  it('REPORTFLOW_AUTH_URL を上書きすると判定の基準もそちらへ移る', async () => {
    setAuth();
    process.env['REPORTFLOW_AUTH_URL'] = 'https://override.example/api/v1';

    mockFetch.mockResolvedValueOnce(makeRes({ ok: 1 }).res);
    await fetchJson('https://override.example/api/v1/public/templates');
    expect(sentHeaders().get('CF-Access-Client-Id')).toBe(
      'svc-token-id.access',
    );

    // 元の既定ホストは境界から外れる。
    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce(makeRes({ ok: 1 }).res);
    await fetchJson(ACCESS_URL);
    expect(sentHeaders().get('CF-Access-Client-Id')).toBeNull();
  });

  // ケース 7: 呼び出し側が自分で CF-Access-* を渡しても、解決済みの値が勝つ
  it('呼び出し側の CF-Access-* を解決済みの値で上書きする', async () => {
    setAuth();
    mockFetch.mockResolvedValueOnce(makeRes({ ok: 1 }).res);

    await fetchJson(ACCESS_URL, {
      headers: {
        'CF-Access-Client-Id': 'attacker-id',
        'CF-Access-Client-Secret': 'attacker-secret',
      },
    });

    expect(sentHeaders().get('CF-Access-Client-Id')).toBe(
      'svc-token-id.access',
    );
    expect(sentHeaders().get('CF-Access-Client-Secret')).toBe(
      'svc-token-secret',
    );
  });

  // ケース 8: 3xx を追従せず、res.json() まで進ませない
  it('身元を載せた要求では redirect を追従せず 3xx をエラーにする', async () => {
    setAuth();
    const json = jest.fn();
    const cancel = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: 'Found',
      json,
      headers: new Headers({
        location: 'https://monepla.cloudflareaccess.com/cdn-cgi/access/login/x',
        'content-type': 'text/html; charset=utf-8',
      }),
      body: { cancel },
    } as unknown as Response);

    const err = await fetchJson(ACCESS_URL).catch((e: unknown) => e);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('manual');
    // Access のログイン HTML を JSON として読もうとしない。
    expect(json).not.toHaveBeenCalled();
    // 読まない本文は解放する。
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((err as Error).message).toContain('[302] upstream redirected');
    // ケース 8/9: Location も本文も秘密も文面へ入れない。
    expect((err as Error).message).not.toContain('cloudflareaccess.com');
    expect((err as Error).message).not.toContain('svc-token-id.access');
    expect((err as Error).message).not.toContain('svc-token-secret');
  });

  it('身元を載せない経路では 3xx を従来どおり扱う (追従の既定を変えない)', async () => {
    delete process.env[ID];
    delete process.env[SECRET];
    mockFetch.mockResolvedValueOnce(
      makeRes({ message: 'moved' }, { ok: false, status: 302 }).res,
    );

    await expect(fetchJson(CONTENT_URL)).rejects.toThrow('[302] moved');
  });

  it('身元を載せた要求でも 2xx / 4xx は従来どおり通る', async () => {
    setAuth();
    mockFetch.mockResolvedValueOnce(makeRes({ a: 1 }).res);
    await expect(fetchJson(ACCESS_URL)).resolves.toEqual({ a: 1 });

    mockFetch.mockResolvedValueOnce(
      makeRes({ message: 'nope' }, { ok: false, status: 403 }).res,
    );
    await expect(fetchJson(ACCESS_URL)).rejects.toThrow('[403] nope');
  });

  // ケース 9: ログに秘密を出さない
  it('ヘッダーを載せてもログへ秘密を出さない', async () => {
    setAuth();
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
      (m) => jest.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      mockFetch.mockResolvedValueOnce(makeRes({ a: 1 }).res);
      await fetchJson(ACCESS_URL);

      mockFetch.mockResolvedValueOnce(
        makeRes({ message: 'nope' }, { ok: false, status: 403 }).res,
      );
      await fetchJson(ACCESS_URL).catch(() => undefined);

      const printed = spies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((arg) => String(arg))
        .join('\n');
      expect(printed).not.toContain('svc-token-id.access');
      expect(printed).not.toContain('svc-token-secret');
      expect(printed).not.toContain('CF-Access-Client-Secret');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

// PR #136 の CodeRabbit 指摘の end-to-end 版。判定関数の単体テストだけでなく、
// **実際に平文 http の要求へ資格情報が載らないこと**を送信経路で固定する。
describe('http/Access service auth は scheme を跨がない', () => {
  const ID = 'RF_ACCESS_CLIENT_ID';
  const SECRET = 'RF_ACCESS_CLIENT_SECRET';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [ID, SECRET, 'REPORTFLOW_AUTH_URL']) {
      saved[key] = process.env[key];
    }
    process.env[ID] = 'svc-token-id.access';
    process.env[SECRET] = 'svc-token-secret';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const sentHeaders = (): Headers => {
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    return new Headers(init.headers);
  };

  it('基準が https のとき、同ホストの平文 http へは載せない', async () => {
    process.env['REPORTFLOW_AUTH_URL'] = 'https://re-port-flow.com/api/v1';
    mockFetch.mockResolvedValueOnce(makeRes({ ok: 1 }).res);

    await fetchJson(
      'http://re-port-flow.com/api/v1/ws/my/templates/x/duplicate',
    );

    const headers = sentHeaders();
    expect(headers.get('CF-Access-Client-Id')).toBeNull();
    expect(headers.get('CF-Access-Client-Secret')).toBeNull();
    // 平文経路なので追従の既定も変えない。
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBeUndefined();
  });

  it('基準が https で要求も https なら従来どおり載せる', async () => {
    process.env['REPORTFLOW_AUTH_URL'] = 'https://re-port-flow.com/api/v1';
    mockFetch.mockResolvedValueOnce(makeRes({ ok: 1 }).res);

    await fetchJson(
      'https://re-port-flow.com/api/v1/ws/my/templates/x/duplicate',
    );

    expect(sentHeaders().get('CF-Access-Client-Id')).toBe(
      'svc-token-id.access',
    );
  });
});
