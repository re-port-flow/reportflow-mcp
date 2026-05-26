import { getHttpAuthContext, runWithHttpAuth } from './auth-context';

describe('auth-context', () => {
  it('getHttpAuthContext は run スコープ外では undefined を返す', () => {
    expect(getHttpAuthContext()).toBeUndefined();
  });

  it('runWithHttpAuth 内で同期的に context が取れる', async () => {
    const ctx = await runWithHttpAuth({ accessToken: 'tkn-1' }, async () => {
      return getHttpAuthContext();
    });
    expect(ctx).toEqual({ accessToken: 'tkn-1' });
  });

  it('await を挟んでも context が維持される', async () => {
    const ctx = await runWithHttpAuth(
      { accessToken: 'tkn-async' },
      async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return getHttpAuthContext();
      },
    );
    expect(ctx?.accessToken).toBe('tkn-async');
  });

  it('入れ子で内側の context が優先され、抜けると元に戻る', async () => {
    const result = await runWithHttpAuth({ accessToken: 'outer' }, async () => {
      const before = getHttpAuthContext()?.accessToken;
      const inner = await runWithHttpAuth(
        { accessToken: 'inner' },
        async () => getHttpAuthContext()?.accessToken,
      );
      const after = getHttpAuthContext()?.accessToken;
      return { before, inner, after };
    });
    expect(result).toEqual({
      before: 'outer',
      inner: 'inner',
      after: 'outer',
    });
  });
});
