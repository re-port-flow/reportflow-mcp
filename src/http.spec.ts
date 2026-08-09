import {
  fetchJson,
  fetchBinary,
  fetchBinaryWithHeaders,
  fetchHeadersOnly,
} from './http.js';

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
      makeRes({ message: 'boom' }, { ok: false, status: 500, statusText: 'ISE' })
        .res,
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

  it('throws HttpError on non-ok', async () => {
    mockFetch.mockResolvedValueOnce(
      makeRes({ message: 'bad' }, { ok: false, status: 500, statusText: 'ISE' })
        .res,
    );
    await expect(fetchHeadersOnly('https://x')).rejects.toThrow('[500] bad');
  });
});
