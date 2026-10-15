import {
  generatePdfSync,
  generatePdfsSync,
  getGenerationStatus,
  listDesigns,
  SYNC_GENERATION_TIMEOUT_MS,
} from './client';

jest.mock('./auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ Authorization: 'Bearer test-token' }),
  ),
}));
jest.mock('./file-helper', () => ({
  saveTempFile: jest.fn().mockResolvedValue('/tmp/out.zip'),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** abort されるまで応答しない fetch (タイムアウトの境界を測るため)。 */
const hangUntilAborted = () =>
  mockFetch.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  );

/**
 * 約束が `ms` 時点でまだ決着していないこと、`untilMs` までに timed out で
 * reject されることを確かめる。
 */
const expectTimeoutWindow = async (
  promise: Promise<unknown>,
  pendingAtMs: number,
  untilMs: number,
): Promise<void> => {
  let settled = false;
  const observed = promise.then(
    () => {
      settled = true;
      return undefined;
    },
    (err: unknown) => {
      settled = true;
      return err;
    },
  );
  await jest.advanceTimersByTimeAsync(pendingAtMs);
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(untilMs - pendingAtMs);
  const err = await observed;
  expect(settled).toBe(true);
  expect((err as Error).message).toContain(`timed out after ${untilMs}ms`);
};

describe('同期生成のタイムアウト (API の 504 (60 秒) を MCP が先に受け取る)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockFetch.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('SYNC_GENERATION_TIMEOUT_MS は API の同期タイムアウト (60 秒) より十分長い 125 秒', () => {
    expect(SYNC_GENERATION_TIMEOUT_MS).toBe(125_000);
    expect(SYNC_GENERATION_TIMEOUT_MS).toBeGreaterThan(120_000);
  });

  it('generatePdfSync (HTTP / skipSave) は 30 秒では打ち切らず 125 秒で打ち切る', async () => {
    hangUntilAborted();
    await expectTimeoutWindow(
      generatePdfSync({
        designId: '0eUDdgAjNXrrItA2',
        version: 1,
        content: { fileName: 'a.pdf', params: {} },
        skipSave: true,
      }),
      60_000,
      SYNC_GENERATION_TIMEOUT_MS,
    );
  });

  it('generatePdfSync (stdio) も 125 秒', async () => {
    hangUntilAborted();
    await expectTimeoutWindow(
      generatePdfSync({
        designId: '0eUDdgAjNXrrItA2',
        version: 1,
        content: { fileName: 'a.pdf', params: {} },
      }),
      60_000,
      SYNC_GENERATION_TIMEOUT_MS,
    );
  });

  it('generatePdfsSync も 125 秒', async () => {
    hangUntilAborted();
    await expectTimeoutWindow(
      generatePdfsSync({
        designId: '0eUDdgAjNXrrItA2',
        version: 1,
        contents: [{ fileName: 'a.pdf', params: {} }],
      }),
      60_000,
      SYNC_GENERATION_TIMEOUT_MS,
    );
  });

  // 対のテスト: 同期生成以外は既定の 30 秒のまま (延長を全体へ広げない)。
  it('同期生成以外 (listDesigns) は既定の 30 秒で打ち切る', async () => {
    hangUntilAborted();
    await expectTimeoutWindow(listDesigns(), 29_000, 30_000);
  });
});

describe('getGenerationStatus (PRJ-3-2018)', () => {
  beforeEach(() => mockFetch.mockReset());

  const jsonRes = (body: unknown, headers: Record<string, string> = {}) =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
      headers: new Headers(headers),
    }) as unknown as Response;

  it('GET /v1/file/status/{requestId} を呼び、Retry-After を秒数で添える', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes(
        { requestId: 'AbC123dEf456GhI7', status: 'processing', files: [] },
        { 'Retry-After': '2' },
      ),
    );

    const result = await getGenerationStatus('AbC123dEf456GhI7');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/file\/status\/AbC123dEf456GhI7$/);
    expect(init.method).toBeUndefined();
    expect(result).toEqual({
      requestId: 'AbC123dEf456GhI7',
      status: 'processing',
      files: [],
      retryAfterSeconds: 2,
    });
  });

  it('Retry-After が無い / 秒数でなければ retryAfterSeconds を付けない', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({ requestId: 'r', status: 'completed', files: [] }),
    );
    expect(await getGenerationStatus('r')).not.toHaveProperty(
      'retryAfterSeconds',
    );

    mockFetch.mockResolvedValueOnce(
      jsonRes(
        { requestId: 'r', status: 'processing', files: [] },
        { 'Retry-After': 'soon' },
      ),
    );
    expect(await getGenerationStatus('r')).not.toHaveProperty(
      'retryAfterSeconds',
    );
  });

  it('requestId はパスへエスケープして埋め込む', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonRes({ requestId: 'a/b', status: 'completed', files: [] }),
    );
    await getGenerationStatus('a/b');
    expect(mockFetch.mock.calls[0][0]).toMatch(/\/v1\/file\/status\/a%2Fb$/);
  });
});
