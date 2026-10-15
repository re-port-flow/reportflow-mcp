import {
  buildContainerErrorLog,
  isAbnormalContainerStop,
  isRolloutExit,
  truncateForLog,
} from './container-log';

describe('isRolloutExit', () => {
  it('rollout-lowercase: picks up the library wording', () => {
    expect(
      isRolloutExit('runtime signalled the container to exit: 0'),
    ).toBe(true);
  });

  it('rollout-uppercase: absorbs case differences', () => {
    expect(
      isRolloutExit(
        'Runtime signalled the container to exit due to a new version rollout: 0',
      ),
    ).toBe(true);
  });

  it('rollout-unrelated: does not false-positive on disconnects', () => {
    expect(
      isRolloutExit('Container port connection closed unexpectedly.'),
    ).toBe(false);
  });

  it('rollout-exit-code: unexpected exit codes are not rollouts', () => {
    expect(
      isRolloutExit('container exited with unexpected exit code: 137'),
    ).toBe(false);
  });

  it('rollout-empty: empty string is not a rollout', () => {
    expect(isRolloutExit('')).toBe(false);
  });
});

describe('truncateForLog', () => {
  it('truncate-short: leaves short strings alone', () => {
    expect(truncateForLog('abcdefghij')).toBe('abcdefghij');
  });

  it('truncate-boundary: exactly max chars are unchanged', () => {
    const value = 'x'.repeat(200);
    expect(truncateForLog(value)).toBe(value);
  });

  it('truncate-long: cuts and appends ellipsis', () => {
    const value = 'x'.repeat(201);
    const truncated = truncateForLog(value);
    expect(truncated).toBe(`${'x'.repeat(200)}…`);
    expect(truncated.length).toBe(201);
  });
});

describe('buildContainerErrorLog', () => {
  it('build-error: keeps Error name and message', () => {
    expect(buildContainerErrorLog(new TypeError('boom'))).toEqual({
      event: 'container_error',
      errorName: 'TypeError',
      message: 'boom',
    });
  });

  it('build-non-error: stringifies non-Error values', () => {
    expect(buildContainerErrorLog('plain string')).toEqual({
      event: 'container_error',
      errorName: 'UnknownError',
      message: 'plain string',
    });
  });

  it('build-null: stringifies null', () => {
    expect(buildContainerErrorLog(null)).toEqual({
      event: 'container_error',
      errorName: 'UnknownError',
      message: 'null',
    });
  });

  it('build-long-message: truncates long Error messages', () => {
    const log = buildContainerErrorLog(new Error('x'.repeat(500)));
    expect(log.message.length).toBe(201);
  });
});

describe('isAbnormalContainerStop', () => {
  it('treats sleepAfter-style stop as normal', () => {
    // Library: callOnStop({ exitCode: 0, reason: 'exit' }) on idle expiry.
    expect(isAbnormalContainerStop(0, 'exit')).toBe(false);
  });

  it('treats non-zero exit as abnormal', () => {
    expect(isAbnormalContainerStop(137, 'exit')).toBe(true);
  });

  it('treats non-exit reason as abnormal', () => {
    expect(isAbnormalContainerStop(0, 'runtime_signal')).toBe(true);
  });
});
