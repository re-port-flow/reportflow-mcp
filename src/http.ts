const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      message?: string;
      error_description?: string;
    };
    return body.message ?? body.error_description ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

function withTimeout(
  signal: AbortSignal | null | undefined,
  ms: number,
): [AbortSignal, () => void] {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${ms}ms`)),
    ms,
  );

  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort);
    }
  }

  const clear = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
  return [controller.signal, clear];
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const [timeoutSignal, clearTimer] = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: timeoutSignal });
    if (!res.ok) {
      const msg = await parseErrorMessage(res);
      throw new HttpError(res.status, `[${res.status}] ${msg}`);
    }
    return await (res.json() as Promise<T>);
  } finally {
    clearTimer();
  }
}

export async function fetchBinary(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<ArrayBuffer> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const [timeoutSignal, clearTimer] = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: timeoutSignal });
    if (!res.ok) {
      const msg = await parseErrorMessage(res);
      throw new HttpError(res.status, `[${res.status}] ${msg}`);
    }
    return await res.arrayBuffer();
  } finally {
    clearTimer();
  }
}
