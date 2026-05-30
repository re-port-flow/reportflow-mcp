import { startCallbackServer } from './auth-server.js';

const fetchCallback = async (
  port: number,
  query: string,
): Promise<{ status: number; body: string }> => {
  const res = await fetch(`http://127.0.0.1:${port}/callback?${query}`);
  return { status: res.status, body: await res.text() };
};

type StartedServer = {
  port: number;
  promise: ReturnType<typeof startCallbackServer>;
};

// Boot the callback server on an OS-assigned port (port: 0) so parallel jest
// workers can't collide on a fixed port. Resolves once the server is listening
// with the actually-bound port.
const startServer = (
  opts: Omit<Parameters<typeof startCallbackServer>[0], 'port' | 'onListening'>,
): Promise<StartedServer> =>
  new Promise((resolve, reject) => {
    const promise = startCallbackServer({
      ...opts,
      port: 0,
      onListening: (port) => resolve({ port, promise }),
    });
    promise.catch((err) => reject(err));
  });

describe('auth-server', () => {
  it('resolves with code on valid callback', async () => {
    const { port, promise } = await startServer({ expectedState: 'st-1' });
    const httpResp = await fetchCallback(port, 'code=abc123&state=st-1');
    expect(httpResp.status).toEqual(200);
    await expect(promise).resolves.toEqual({ code: 'abc123' });
  });

  it('rejects when state mismatches', async () => {
    const { port, promise } = await startServer({ expectedState: 'st-1' });
    const httpResp = await fetchCallback(port, 'code=abc&state=other');
    expect(httpResp.status).toEqual(400);
    await expect(promise).rejects.toThrow(/state mismatch/);
  });

  it('rejects when error param is present', async () => {
    const { port, promise } = await startServer({ expectedState: 'st-1' });
    const httpResp = await fetchCallback(
      port,
      'error=access_denied&error_description=user+rejected',
    );
    expect(httpResp.status).toEqual(400);
    await expect(promise).rejects.toThrow(/access_denied/);
  });

  it('rejects when code is missing', async () => {
    const { port, promise } = await startServer({ expectedState: 'st-1' });
    const httpResp = await fetchCallback(port, 'state=st-1');
    expect(httpResp.status).toEqual(400);
    await expect(promise).rejects.toThrow(/missing code/);
  });

  it('returns 404 for non-callback paths', async () => {
    const { port, promise } = await startServer({ expectedState: 'st-1' });
    const res = await fetch(`http://127.0.0.1:${port}/other`);
    expect(res.status).toEqual(404);
    // Then complete with a valid callback so the promise resolves
    await fetchCallback(port, 'code=ok&state=st-1');
    await expect(promise).resolves.toEqual({ code: 'ok' });
  });

  it('rejects after timeout', async () => {
    // This test does not issue HTTP requests, so we don't need the bound port.
    // Skip the startServer helper to avoid a race where a slow OS port bind
    // could let the 50ms timeout fire before onListening, surfacing as a throw
    // at `await startServer(...)` instead of via the rejects.toThrow assertion.
    const promise = startCallbackServer({
      port: 0,
      expectedState: 'st-x',
      timeoutMs: 50,
    });
    await expect(promise).rejects.toThrow(/timeout/);
  });
});
