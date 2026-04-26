import { startCallbackServer } from './auth-server.js';

const PORT = 53789;

const fetchCallback = async (
  query: string,
): Promise<{ status: number; body: string }> => {
  const res = await fetch(`http://127.0.0.1:${PORT}/callback?${query}`);
  return { status: res.status, body: await res.text() };
};

describe('auth-server', () => {
  it('resolves with code on valid callback', async () => {
    const promise = startCallbackServer({ port: PORT, expectedState: 'st-1' });
    // Give server a beat to start
    await new Promise((r) => setTimeout(r, 50));
    const httpResp = await fetchCallback('code=abc123&state=st-1');
    expect(httpResp.status).toEqual(200);
    await expect(promise).resolves.toEqual({ code: 'abc123' });
  });

  it('rejects when state mismatches', async () => {
    const promise = startCallbackServer({ port: PORT, expectedState: 'st-1' });
    await new Promise((r) => setTimeout(r, 50));
    const httpResp = await fetchCallback('code=abc&state=other');
    expect(httpResp.status).toEqual(400);
    await expect(promise).rejects.toThrow(/state mismatch/);
  });

  it('rejects when error param is present', async () => {
    const promise = startCallbackServer({ port: PORT, expectedState: 'st-1' });
    await new Promise((r) => setTimeout(r, 50));
    const httpResp = await fetchCallback(
      'error=access_denied&error_description=user+rejected',
    );
    expect(httpResp.status).toEqual(400);
    await expect(promise).rejects.toThrow(/access_denied/);
  });

  it('rejects when code is missing', async () => {
    const promise = startCallbackServer({ port: PORT, expectedState: 'st-1' });
    await new Promise((r) => setTimeout(r, 50));
    const httpResp = await fetchCallback('state=st-1');
    expect(httpResp.status).toEqual(400);
    await expect(promise).rejects.toThrow(/missing code/);
  });

  it('returns 404 for non-callback paths', async () => {
    const promise = startCallbackServer({ port: PORT, expectedState: 'st-1' });
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`http://127.0.0.1:${PORT}/other`);
    expect(res.status).toEqual(404);
    // Then complete with a valid callback so the promise resolves
    await fetchCallback('code=ok&state=st-1');
    await expect(promise).resolves.toEqual({ code: 'ok' });
  });

  it('rejects after timeout', async () => {
    const promise = startCallbackServer({
      port: PORT,
      expectedState: 'st-x',
      timeoutMs: 50,
    });
    await expect(promise).rejects.toThrow(/timeout/);
  });
});
