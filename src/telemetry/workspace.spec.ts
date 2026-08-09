import { runWithHttpAuth } from '../auth-context.js';
import {
  recordCredentialWorkspace,
  resolveInvocationWorkspaceId,
  runWithInvocationWorkspace,
  type InvocationWorkspace,
} from './workspace.js';

/** workspace_id クレームだけを持つ最小の JWT（署名は検証しないのでダミー）。 */
const jwtWithWorkspace = (workspaceId: string): string => {
  const body = Buffer.from(
    JSON.stringify({ workspace_id: workspaceId }),
  ).toString('base64url');
  return `header.${body}.signature`;
};

/** workspace_id を持たない JWT。 */
const jwtWithoutWorkspace = (): string =>
  `header.${Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')}.sig`;

// beforeEach でのリセットは不要 — 設計上プロセス幅の可変状態を持たず、記録先は
// 呼び出しスコープのスロットだけなので、テスト間で状態が漏れない。

describe('resolveInvocationWorkspaceId — stdio (資格情報経路)', () => {
  it('呼び出し中に auth 層が記録した workspace を返す', async () => {
    const slot: InvocationWorkspace = {};

    await runWithInvocationWorkspace(slot, async () => {
      recordCredentialWorkspace('from-credentials');
    });

    expect(resolveInvocationWorkspaceId(slot)).toBe('from-credentials');
  });

  it('資格情報を読まなかった呼び出しは undefined', () => {
    expect(resolveInvocationWorkspaceId({})).toBeUndefined();
  });

  // `authenticate force=true` は「破棄 (undefined) → OAuth 交換 → 新 workspace 保存」、
  // 401 リトライは「拒否された資格情報 → refresh した資格情報」の順に記録する。
  // どちらも応答を生んだのは最後に確立された資格情報。
  it('同一呼び出し内で複数回記録されたら最後の値を採る', async () => {
    const slot: InvocationWorkspace = {};

    await runWithInvocationWorkspace(slot, async () => {
      recordCredentialWorkspace('ws-A');
      recordCredentialWorkspace(undefined);
      recordCredentialWorkspace('ws-B');
    });

    expect(resolveInvocationWorkspaceId(slot)).toBe('ws-B');
  });

  // プロセス幅のキャッシュを持たないことの担保。持っていると、呼び出し前の
  // 資格情報読み込みが「この呼び出しの帰属先」として漏れてくる。
  it('呼び出しスコープ外の記録はどのスロットにも入らない', async () => {
    recordCredentialWorkspace('outside-any-invocation');

    const slot: InvocationWorkspace = {};
    await runWithInvocationWorkspace(slot, async () => undefined);

    expect(resolveInvocationWorkspaceId(slot)).toBeUndefined();
  });

  // 設計の核: 並行する `authenticate force=true` が別ワークスペースを保存しても、
  // 進行中の呼び出しの帰属先は変わらない。
  it('並行呼び出しが互いのスロットを汚さない', async () => {
    const slotA: InvocationWorkspace = {};
    const slotB: InvocationWorkspace = {};

    // 「A が資格情報を読む → B が別ワークスペースを確立する → A が解決する」の順に
    // なるよう待ち合わせる。共有キャッシュ経由だと A が B の値を拾ってしまう。
    let releaseA = (): void => {};
    const aCanResolve = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = runWithInvocationWorkspace(slotA, async () => {
      recordCredentialWorkspace('ws-A');
      await aCanResolve;
      return resolveInvocationWorkspaceId(slotA);
    });

    const b = runWithInvocationWorkspace(slotB, async () => {
      recordCredentialWorkspace('ws-B');
      releaseA();
      return resolveInvocationWorkspaceId(slotB);
    });

    await expect(b).resolves.toBe('ws-B');
    await expect(a).resolves.toBe('ws-A');
  });
});

describe('resolveInvocationWorkspaceId — HTTP (per-request Bearer 経路)', () => {
  it('リクエストの Bearer トークンから解決する', async () => {
    await expect(
      runWithHttpAuth(
        { accessToken: jwtWithWorkspace('from-bearer') },
        async () => resolveInvocationWorkspaceId({}),
      ),
    ).resolves.toBe('from-bearer');
  });

  it('資格情報側の記録より per-request の値を優先する', async () => {
    // 同一プロセスが複数ワークスペースのリクエストを捌くため、ここが逆転すると
    // 別ワークスペースの利用として集計されてしまう。
    await expect(
      runWithHttpAuth(
        { accessToken: jwtWithWorkspace('from-bearer') },
        async () =>
          resolveInvocationWorkspaceId({ workspaceId: 'from-credentials' }),
      ),
    ).resolves.toBe('from-bearer');
  });

  // Codex P1 (PR #96): HTTP コンテキストがある限りローカル資格情報へは落とさない。
  // サーバープロセスのトークンは無関係なワークスペースのものであり得る。
  it('Bearer に workspace_id が無くてもローカル資格情報へフォールバックしない', async () => {
    await expect(
      runWithHttpAuth({ accessToken: jwtWithoutWorkspace() }, async () =>
        resolveInvocationWorkspaceId({ workspaceId: 'from-credentials' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('壊れた Bearer でもフォールバックせず undefined', async () => {
    await expect(
      runWithHttpAuth({ accessToken: 'not-a-jwt' }, async () =>
        resolveInvocationWorkspaceId({ workspaceId: 'from-credentials' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('HTTP コンテキストの外では資格情報側の記録を読む', async () => {
    await runWithHttpAuth(
      { accessToken: jwtWithWorkspace('from-bearer') },
      async () => resolveInvocationWorkspaceId({}),
    );

    expect(
      resolveInvocationWorkspaceId({ workspaceId: 'from-credentials' }),
    ).toBe('from-credentials');
  });
});
