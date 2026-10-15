import { discardBody } from './discard-body.js';

/**
 * The mocks here carry a **real `ReadableStream`** rather than a hand-made
 * object with a `cancel` function. A stream is the only shape that actually
 * holds a connection, so a lighter mock would pass even if `discardBody` did
 * nothing (lesson from PR #134).
 */
const streamBody = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'));
      controller.close();
    },
  });

describe('discardBody', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('cancels an unread body', async () => {
    const body = streamBody();
    const cancel = jest.spyOn(body, 'cancel');
    await discardBody({ body });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('leaves the stream unusable afterwards (the cancel really happened)', async () => {
    const body = streamBody();
    await discardBody({ body });
    expect(body.locked).toBe(false);
    // A cancelled stream yields nothing; `done` on the first read proves the
    // body was released rather than merely marked.
    const first = await body.getReader().read();
    expect(first.done).toBe(true);
  });

  it('does nothing when there is no body (204 and friends)', async () => {
    await expect(discardBody({ body: null })).resolves.toBeUndefined();
  });

  // 対のテスト: a failing cancel must not propagate, or it would overwrite a
  // conclusion the caller has already reached (`redirect`, an HttpError, or a
  // successful telemetry send).
  it('swallows a rejecting cancel', async () => {
    const body = streamBody();
    jest.spyOn(body, 'cancel').mockRejectedValue(new Error('cancel boom'));
    await expect(discardBody({ body })).resolves.toBeUndefined();
  });

  it('swallows a synchronously throwing cancel', async () => {
    const body = streamBody();
    jest.spyOn(body, 'cancel').mockImplementation(() => {
      throw new TypeError('already released');
    });
    await expect(discardBody({ body })).resolves.toBeUndefined();
  });
});
