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
  const { data } = await fetchBinaryWithHeaders(url, init);
  return data;
}

/**
 * fetchBinary の拡張版。レスポンスヘッダーも返す。
 * content-service の sync エンドポイントが返す
 * `File-URL` / `Request-Id` / `X-File-Mapping` 等を読むために使う。
 *
 * 参照: developer-docs/openapi/content-service.yaml
 *   /v1/file/sync/single → 200 with headers (File-URL, Request-Id, X-File-Mapping)
 */
export async function fetchBinaryWithHeaders(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; headers: Headers }> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const [timeoutSignal, clearTimer] = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: timeoutSignal });
    if (!res.ok) {
      const msg = await parseErrorMessage(res);
      throw new HttpError(res.status, `[${res.status}] ${msg}`);
    }
    const data = await res.arrayBuffer();
    return { data, headers: res.headers };
  } finally {
    clearTimer();
  }
}

/**
 * レスポンス本文を読まずにヘッダーだけ取得する。
 * content-service の sync エンドポイントは `File-URL` / `Request-Id` /
 * `X-File-Mapping` をヘッダーで返すため、PDF バイト列が不要なケース (HTTP モードで
 * fileUrl のみ利用する場合) では本文をメモリにバッファせずに済む。
 * 本文ストリームは明示的に cancel してコネクションを解放する。
 */
export async function fetchHeadersOnly(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Headers> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const [timeoutSignal, clearTimer] = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: timeoutSignal });
    if (!res.ok) {
      const msg = await parseErrorMessage(res);
      throw new HttpError(res.status, `[${res.status}] ${msg}`);
    }
    // 本文は不要。バッファせずストリームを破棄する。
    await res.body?.cancel();
    return res.headers;
  } finally {
    clearTimer();
  }
}
