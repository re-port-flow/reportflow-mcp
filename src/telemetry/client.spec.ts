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
    expect((init.headers as Record<string, string>)[TELEMETRY_SECRET_HEADER]).toBe(
      's3cret',
    );
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
    expect((init.headers as Record<string, string>)[TELEMETRY_SECRET_HEADER]).toBe(
      'env-secret',
    );
  });
});
