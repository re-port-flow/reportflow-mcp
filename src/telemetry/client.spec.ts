import {
  createTelemetryClient,
  telemetryClientFromEnv,
  TELEMETRY_SECRET_HEADER,
  type TelemetryEvent,
} from './client.js';

const sampleEvent: TelemetryEvent = {
  event: 'integration.mcp.invoked',
  properties: { tool: 'list_templates', success: true },
};

const okResponse = { ok: true, status: 204 } as Response;

/**
 * Builds a Response-like object carrying a **real `ReadableStream`** body.
 *
 * A mock that only exposes `text()` / `json()` is a shape production never
 * produces, so it cannot detect a held connection (lesson from PR #134). The
 * stream here behaves like the real one: `cancel()` is the only way to release
 * it without reading.
 */
const streamResponse = (
  init: { ok?: boolean; status?: number } = {},
): {
  res: Response;
  cancel: jest.SpyInstance<Promise<void>, [reason?: unknown]>;
} => {
  const { ok = true, status = 204 } = init;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"accepted":true}'));
      controller.close();
    },
  });
  const cancel = jest.spyOn(body, 'cancel');
  return { res: { ok, status, body } as unknown as Response, cancel };
};

describe('createTelemetryClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a no-op client when no endpoint is configured', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse);
    const client = createTelemetryClient({});
    client.track(sampleEvent);
    await client.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only endpoint as unconfigured (no-op)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse);
    const client = createTelemetryClient({ endpointUrl: '   ' });
    client.track(sampleEvent);
    await client.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs the event to the trimmed endpoint without a secret header', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse);
    const client = createTelemetryClient({
      endpointUrl: '  https://t.example/events  ',
    });
    client.track(sampleEvent);
    await client.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://t.example/events');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers[TELEMETRY_SECRET_HEADER]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual(sampleEvent);
  });

  it('adds the shared-secret header when configured', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse);
    const client = createTelemetryClient({
      endpointUrl: 'https://t.example/events',
      sharedSecret: 's3cret',
    });
    client.track(sampleEvent);
    await client.flush();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>)[TELEMETRY_SECRET_HEADER],
    ).toBe('s3cret');
  });

  it('warns on a non-success response but never throws', async () => {
    const warn = jest.fn();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false, status: 500 } as Response);
    const client = createTelemetryClient({
      endpointUrl: 'https://t.example/events',
      logger: { warn },
    });
    client.track(sampleEvent);
    await client.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('non-success response');
  });

  it('warns when fetch rejects and swallows the error', async () => {
    const warn = jest.fn();
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('boom'));
    const client = createTelemetryClient({
      endpointUrl: 'https://t.example/events',
      logger: { warn },
    });
    client.track(sampleEvent);
    await client.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('send failed: boom');
  });

  it('warns with String(err) when a non-Error is thrown', async () => {
    const warn = jest.fn();
    jest.spyOn(global, 'fetch').mockRejectedValue('kaput');
    const client = createTelemetryClient({
      endpointUrl: 'https://t.example/events',
      logger: { warn },
    });
    client.track(sampleEvent);
    await client.flush();
    expect(warn.mock.calls[0][0]).toContain('send failed: kaput');
  });
});

// PRJ-3-1582: the collector's response body is never used, so the stream has to
// be released explicitly — otherwise the connection is held until GC on every
// tool call.
describe('telemetry response stream release', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const track = async (res: Response, warn: jest.Mock): Promise<void> => {
    jest.spyOn(global, 'fetch').mockResolvedValue(res);
    const client = createTelemetryClient({
      endpointUrl: 'https://t.example/events',
      logger: { warn },
    });
    client.track(sampleEvent);
    await client.flush();
  };

  it('cancels the body on a success response and warns about nothing', async () => {
    const warn = jest.fn();
    const { res, cancel } = streamResponse({ ok: true, status: 204 });
    await track(res, warn);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('cancels the body on a non-success response and keeps the existing warning', async () => {
    const warn = jest.fn();
    const { res, cancel } = streamResponse({ ok: false, status: 401 });
    await track(res, warn);
    expect(cancel).toHaveBeenCalledTimes(1);
    // The wording is grepped by operators; releasing the stream must not
    // change it.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      '[telemetry] non-success response: status=401 event=integration.mcp.invoked',
    );
  });

  it('tolerates a null body (204 with no content)', async () => {
    const warn = jest.fn();
    await track({ ok: true, status: 204, body: null } as Response, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  // 対のテスト: releasing the stream must not be able to turn a *sent* event
  // into a reported failure. Without the try/catch inside `discardBody`, the
  // rejection lands in the outer catch and warns "send failed".
  it('does not report a send failure when cancel() rejects', async () => {
    const warn = jest.fn();
    const { res, cancel } = streamResponse({ ok: true, status: 204 });
    cancel.mockRejectedValue(new Error('cancel boom'));
    await expect(track(res, warn)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still reports a send failure when fetch itself rejects', async () => {
    const warn = jest.fn();
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));
    const client = createTelemetryClient({
      endpointUrl: 'https://t.example/events',
      logger: { warn },
    });
    client.track(sampleEvent);
    await client.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('send failed: fetch failed');
  });
});

describe('telemetryClientFromEnv', () => {
  let savedUrl: string | undefined;
  let savedSecret: string | undefined;

  beforeAll(() => {
    savedUrl = process.env.TELEMETRY_ENDPOINT_URL;
    savedSecret = process.env.TELEMETRY_SHARED_SECRET;
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.TELEMETRY_ENDPOINT_URL;
    else process.env.TELEMETRY_ENDPOINT_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.TELEMETRY_SHARED_SECRET;
    else process.env.TELEMETRY_SHARED_SECRET = savedSecret;
    jest.restoreAllMocks();
  });

  it('builds a no-op client when TELEMETRY_ENDPOINT_URL is unset', async () => {
    delete process.env.TELEMETRY_ENDPOINT_URL;
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse);
    const client = telemetryClientFromEnv();
    client.track(sampleEvent);
    await client.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds an HTTP client from env when the endpoint is set', async () => {
    process.env.TELEMETRY_ENDPOINT_URL = 'https://t.example/events';
    process.env.TELEMETRY_SHARED_SECRET = 'env-secret';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse);
    const client = telemetryClientFromEnv();
    client.track(sampleEvent);
    await client.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>)[TELEMETRY_SECRET_HEADER],
    ).toBe('env-secret');
  });
});
