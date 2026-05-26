// Fire-and-forget HTTP client for the Report Flow event telemetry collector.
//
// Schema spec: developer-docs/docs/internals/event-telemetry-schema.md (PRJ-3-375).
// TODO(PRJ-3-379): replace the locally-defined types with imports from
// @monepla/report-flow-core/telemetry once that subpath is published.

export const TELEMETRY_SECRET_HEADER = 'X-Telemetry-Secret';
export const TELEMETRY_DEFAULT_TIMEOUT_MS = 2000;

export type TelemetryPropertyValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<string | number | boolean | null>;

export type TelemetryProperties = Record<string, TelemetryPropertyValue>;

export interface TelemetryEvent {
  event: string;
  userId?: string;
  workspaceId?: string;
  properties?: TelemetryProperties;
  timestamp?: number;
}

export interface TelemetryClientOptions {
  endpointUrl: string;
  sharedSecret?: string;
  timeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
}

export interface TelemetryClient {
  track(event: TelemetryEvent): void;
  /** Resolves once any spawned background sends settle (test-only). */
  flush(): Promise<void>;
}

class NoopTelemetryClient implements TelemetryClient {
  track(): void {}
  async flush(): Promise<void> {}
}

class HttpTelemetryClient implements TelemetryClient {
  private readonly endpoint: string;
  private readonly secret?: string;
  private readonly timeoutMs: number;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly inflight = new Set<Promise<void>>();

  constructor(opts: TelemetryClientOptions) {
    this.endpoint = opts.endpointUrl;
    this.secret = opts.sharedSecret;
    this.timeoutMs = opts.timeoutMs ?? TELEMETRY_DEFAULT_TIMEOUT_MS;
    this.logger = opts.logger ?? console;
  }

  track(event: TelemetryEvent): void {
    const send = this.send(event);
    this.inflight.add(send);
    void send.finally(() => this.inflight.delete(send));
  }

  async flush(): Promise<void> {
    await Promise.allSettled(Array.from(this.inflight));
  }

  private async send(event: TelemetryEvent): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.secret) headers[TELEMETRY_SECRET_HEADER] = this.secret;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(
          `[telemetry] non-success response: status=${res.status} event=${event.event}`,
        );
      }
    } catch (err: unknown) {
      // Captures synchronous throws from fetch (e.g., bad URL, fetch
      // undefined in non-fetch environments) and async rejections in one
      // place so the caller never sees a top-level Promise rejection.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[telemetry] send failed: ${message} event=${event.event}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export const createTelemetryClient = (
  options: Partial<TelemetryClientOptions>,
): TelemetryClient => {
  const endpoint = options.endpointUrl?.trim();
  if (!endpoint) return new NoopTelemetryClient();
  // Spread `options` first so the trimmed `endpointUrl` wins; an untrimmed
  // copy in `options.endpointUrl` would otherwise clobber it.
  return new HttpTelemetryClient({ ...options, endpointUrl: endpoint });
};

/**
 * Build a client from environment variables. Returns a no-op client when
 * `TELEMETRY_ENDPOINT_URL` is unset so MCP usage is never impacted by
 * misconfiguration.
 */
export const telemetryClientFromEnv = (): TelemetryClient =>
  createTelemetryClient({
    endpointUrl: process.env.TELEMETRY_ENDPOINT_URL,
    sharedSecret: process.env.TELEMETRY_SHARED_SECRET,
  });
