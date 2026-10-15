import {
  isContainerDisconnectBody,
  isRetryableMethod,
  parseInstanceCount,
  parseJsonRpcMethod,
  pickFirstInstanceName,
  pickOtherInstanceName,
} from './retry-policy';

describe('isRetryableMethod', () => {
  it('method-initialize: idempotent methods are allowed', () => {
    expect(isRetryableMethod('initialize')).toBe(true);
  });

  it('method-server-discover: read-only discover is allowed', () => {
    expect(isRetryableMethod('server/discover')).toBe(true);
  });

  it('method-tools-list: idempotent methods are allowed', () => {
    expect(isRetryableMethod('tools/list')).toBe(true);
  });

  it('method-tools-call: non-idempotent methods are rejected', () => {
    expect(isRetryableMethod('tools/call')).toBe(false);
  });

  it('method-notification: verified safe notification is allowed', () => {
    expect(isRetryableMethod('notifications/initialized')).toBe(true);
  });

  it('method-notification-cancelled: unverified notifications are rejected', () => {
    expect(isRetryableMethod('notifications/cancelled')).toBe(false);
  });

  it('method-notification-prefix: prefix alone is not enough', () => {
    expect(isRetryableMethod('notifications/progress')).toBe(false);
  });

  it('method-unknown: unknown methods are rejected', () => {
    expect(isRetryableMethod('foo/bar')).toBe(false);
  });

  it('method-undefined: missing methods are rejected', () => {
    expect(isRetryableMethod(undefined)).toBe(false);
  });
});

describe('parseJsonRpcMethod', () => {
  it('method-initialize payload parses', () => {
    expect(
      parseJsonRpcMethod(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      ),
    ).toBe('initialize');
  });

  it('parse-broken-json: returns undefined', () => {
    expect(parseJsonRpcMethod('{oops')).toBeUndefined();
  });

  it('parse-batch: batches are out of scope', () => {
    expect(
      parseJsonRpcMethod(JSON.stringify([{ method: 'tools/list' }])),
    ).toBeUndefined();
  });

  it('parse-empty: empty string is undefined', () => {
    expect(parseJsonRpcMethod('')).toBeUndefined();
  });
});

describe('isContainerDisconnectBody', () => {
  it('body-closed: detects connection-closed wording', () => {
    expect(
      isContainerDisconnectBody(
        'Error proxying request to container abc: Container port connection closed unexpectedly.',
      ),
    ).toBe(true);
  });

  it('body-suddenly: detects sudden-disconnect wording', () => {
    expect(
      isContainerDisconnectBody('Container suddenly disconnected, try again'),
    ).toBe(true);
  });

  it('body-other-500: unrelated 500 bodies are ignored', () => {
    expect(isContainerDisconnectBody('Internal server error')).toBe(false);
  });
});

describe('pickOtherInstanceName', () => {
  it('pick-0: switches to the other instance', () => {
    expect(pickOtherInstanceName('instance-0')).toBe('instance-1');
  });

  it('pick-1: reverse direction', () => {
    expect(pickOtherInstanceName('instance-1')).toBe('instance-0');
  });

  it('pick-unknown: unexpected names fall back to instance-0', () => {
    expect(pickOtherInstanceName('instance-9')).toBe('instance-0');
  });
});

describe('parseInstanceCount', () => {
  it('count-1: staging value selects single instance', () => {
    expect(parseInstanceCount('1')).toBe(1);
  });

  it('count-1-trim: surrounding whitespace is ignored', () => {
    expect(parseInstanceCount(' 1 ')).toBe(1);
  });

  it('count-2: production value keeps two instances', () => {
    expect(parseInstanceCount('2')).toBe(2);
  });

  it('count-unset: missing value keeps the previous two-instance routing', () => {
    expect(parseInstanceCount(undefined)).toBe(2);
  });
});

describe('pickFirstInstanceName', () => {
  it('first-single: one instance always routes to instance-0', () => {
    expect(pickFirstInstanceName(1, () => 0.99)).toBe('instance-0');
  });

  it('first-two-low: two instances route below 0.5 to instance-0', () => {
    expect(pickFirstInstanceName(2, () => 0.49)).toBe('instance-0');
  });

  it('first-two-high: two instances route 0.5 and above to instance-1', () => {
    expect(pickFirstInstanceName(2, () => 0.5)).toBe('instance-1');
  });
});
