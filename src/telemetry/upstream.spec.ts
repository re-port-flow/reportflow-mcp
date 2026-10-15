import {
  buildUpstreamProperties,
  createInvocationUpstream,
  errorClassOf,
  recordUpstreamFailure,
  recordUpstreamRequest,
  runWithInvocationUpstream,
} from './upstream.js';

describe('errorClassOf', () => {
  it('Error のクラス名を返す', () => {
    expect(errorClassOf(new TypeError('x'))).toBe('TypeError');
    expect(errorClassOf(new SyntaxError('x'))).toBe('SyntaxError');
  });

  it('Error でない値は Error に落とす', () => {
    expect(errorClassOf('boom')).toBe('Error');
    expect(errorClassOf(undefined)).toBe('Error');
    expect(errorClassOf({ name: 'FakeError' })).toBe('Error');
  });

  // `err.name` は型の上では任意の文字列で、`AbortSignal.abort(reason)` の reason は
  // 呼び出し側が作れる。テレメトリへ自由記述を流さない規則を形で担保する。
  it('識別子の形をしていない name は Error に落とす', () => {
    const withName = (name: string): Error => {
      const err = new Error('x');
      err.name = name;
      return err;
    };
    expect(errorClassOf(withName(''))).toBe('Error');
    expect(errorClassOf(withName('taro@example.com'))).toBe('Error');
    expect(errorClassOf(withName('1Error'))).toBe('Error');
    expect(errorClassOf(withName('a'.repeat(65)))).toBe('Error');
    // 上限ちょうど (64 文字) は通す
    expect(errorClassOf(withName('a'.repeat(64)))).toBe('a'.repeat(64));
  });
});

describe('recordUpstreamFailure / runWithInvocationUpstream', () => {
  it('スコープ内の記録がスロットへ入る', async () => {
    const slot = createInvocationUpstream();

    await runWithInvocationUpstream(slot, async () => {
      recordUpstreamFailure({ status: 404, errorClass: 'HttpError' });
    });

    expect(slot).toEqual({
      requestCount: 0,
      failureCount: 1,
      last: { status: 404, errorClass: 'HttpError' },
    });
  });

  it('最後に観測した 1 件を残し、件数を数える', async () => {
    const slot = createInvocationUpstream();

    await runWithInvocationUpstream(slot, async () => {
      recordUpstreamFailure({ status: 401, errorClass: 'HttpError' });
      recordUpstreamFailure({ errorClass: 'TypeError' });
    });

    expect(slot.failureCount).toBe(2);
    expect(slot.last).toEqual({ errorClass: 'TypeError' });
  });

  it('リクエストの本数を数える', async () => {
    const slot = createInvocationUpstream();

    await runWithInvocationUpstream(slot, async () => {
      recordUpstreamRequest();
      recordUpstreamRequest();
      recordUpstreamFailure({ status: 500, errorClass: 'HttpError' });
    });

    expect(slot.requestCount).toBe(2);
    expect(slot.failureCount).toBe(1);
  });

  // どのツール呼び出しにも属さない上流アクセス (起動時の処理等) は落とす。
  it('スコープ外の記録は何もしない', () => {
    expect(() =>
      recordUpstreamFailure({ status: 500, errorClass: 'HttpError' }),
    ).not.toThrow();
    expect(() => recordUpstreamRequest()).not.toThrow();
  });

  it('入れ子のスコープは内側のスロットへ書く', async () => {
    const outer = createInvocationUpstream();
    const inner = createInvocationUpstream();

    await runWithInvocationUpstream(outer, () =>
      runWithInvocationUpstream(inner, async () => {
        recordUpstreamFailure({ status: 500, errorClass: 'HttpError' });
      }),
    );

    expect(outer.failureCount).toBe(0);
    expect(inner.failureCount).toBe(1);
  });
});

describe('buildUpstreamProperties', () => {
  it('観測が無ければ件数だけを返す', () => {
    expect(buildUpstreamProperties(createInvocationUpstream())).toEqual({
      upstreamRequestCount: 0,
      upstreamFailureCount: 0,
    });
  });

  // 「上流を一度も呼ばずに失敗した」と「上流は応答したがツールが拒否した」は
  // 失敗件数だけでは同じ 0 に見える。
  it('リクエストを出したが失敗を観測しなかった場合を 0 件と区別できる', () => {
    expect(
      buildUpstreamProperties({ requestCount: 2, failureCount: 0 }),
    ).toEqual({ upstreamRequestCount: 2, upstreamFailureCount: 0 });
  });

  it('ステータスを観測できたときは status も返す', () => {
    expect(
      buildUpstreamProperties({
        requestCount: 4,
        failureCount: 3,
        last: { status: 412, errorClass: 'HttpError' },
      }),
    ).toEqual({
      upstreamRequestCount: 4,
      upstreamFailureCount: 3,
      lastUpstreamErrorClass: 'HttpError',
      lastUpstreamStatus: 412,
    });
  });

  // 「取れなかった」を「0 だった」に化けさせない。
  it('ステータスを観測できなかったときは status キーを出さない', () => {
    const props = buildUpstreamProperties({
      requestCount: 1,
      failureCount: 1,
      last: { errorClass: 'TypeError' },
    });

    expect(props).toEqual({
      upstreamRequestCount: 1,
      upstreamFailureCount: 1,
      lastUpstreamErrorClass: 'TypeError',
    });
    expect('lastUpstreamStatus' in props).toBe(false);
  });
});
