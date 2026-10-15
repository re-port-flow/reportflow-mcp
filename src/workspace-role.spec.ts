import {
  capabilitiesFor,
  clearWorkspaceRoleCache,
  parseWorkspaceRole,
  resolveWorkspaceAuthorization,
  resolveWorkspaceRole,
  WORKSPACE_ROLE_CACHE_TTL_MS,
  WORKSPACE_ROLE_TIMEOUT_MS,
  type RoleResolution,
} from './workspace-role';
import { PUBLIC_CAPABILITIES } from './workspace-permission';
import { AuthRequiredError } from './auth';
import { runWithHttpAuth } from './auth-context';

// `getAuthHeaders` は HTTP モードの AsyncLocalStorage / stdio の keychain を触る。
// ここで検査したいのは「上流の応答をどう分類するか」なので、ヘッダー取得は差し替える。
jest.mock('./auth', () => {
  const actual = jest.requireActual<typeof import('./auth')>('./auth');
  return {
    ...actual,
    getAuthHeaders: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAuthHeaders } = require('./auth') as {
  getAuthHeaders: jest.Mock;
};

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/**
 * `decodeJwtPayload` が読める最小の JWT（署名は検証されない）。
 * workspace_id クレームだけを載せる。
 */
const tokenFor = (workspaceId?: string): string => {
  const payload = Buffer.from(
    JSON.stringify(
      workspaceId === undefined ? {} : { workspace_id: workspaceId },
    ),
    'utf8',
  ).toString('base64url');
  return `header.${payload}.signature`;
};

const WS = 'ws-1';

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
    body: null,
  }) as unknown as Response;

/** JSON として読めない応答（CDN が API 応答を HTML に差し替える経路）。 */
const htmlResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    text: () => Promise.resolve('<!doctype html>'),
    headers: new Headers(),
    body: null,
  }) as unknown as Response;

const listBody = (
  items: Array<Record<string, unknown>>,
): { results: Array<Record<string, unknown>> } => ({ results: items });

const item = (
  workspaceId: string,
  authTypeCode: unknown = '003',
): Record<string, unknown> => ({
  workspaceId,
  name: 'Workspace',
  memberAuth: { authTypeCode, memberId: 'member-1' },
});

beforeEach(() => {
  jest.clearAllMocks();
  clearWorkspaceRoleCache();
  getAuthHeaders.mockResolvedValue({
    Authorization: `Bearer ${tokenFor(WS)}`,
  });
});

describe('parseWorkspaceRole（契約の実行時検証）', () => {
  it('バインド先 1 件 → resolved', () => {
    expect(parseWorkspaceRole(listBody([item(WS, '002')]), WS)).toEqual({
      status: 'resolved',
      role: 'WRITE',
      workspaceId: WS,
    });
  });

  it('空配列 → forbidden（非所属 / 未承認 / 削除済みを区別しない）', () => {
    expect(parseWorkspaceRole(listBody([]), WS)).toEqual({
      status: 'forbidden',
      reason: 'workspace-not-in-list',
    });
  });

  it('別ワークスペースだけが返る → forbidden（他ワークスペースのロールを拾わない）', () => {
    const result = parseWorkspaceRole(listBody([item('ws-other', '001')]), WS);
    expect(result.status).toBe('forbidden');
  });

  it('複数件あってもバインド先だけを見る', () => {
    const result = parseWorkspaceRole(
      listBody([item('ws-other', '001'), item(WS, '003')]),
      WS,
    );
    expect(result).toEqual({
      status: 'resolved',
      role: 'READ',
      workspaceId: WS,
    });
  });

  it('同じ workspaceId が重複 → unavailable（どちらを採るか根拠が無い）', () => {
    const result = parseWorkspaceRole(
      listBody([item(WS, '001'), item(WS, '003')]),
      WS,
    );
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'contract:duplicate-workspace',
    });
  });

  it.each([
    [null, 'contract:body-not-object'],
    ['<!doctype html>', 'contract:body-not-object'],
    [{ items: [] }, 'contract:results-not-array'],
    [{ results: {} }, 'contract:results-not-array'],
  ])('契約外の body (%s) は unavailable', (body, reason) => {
    expect(parseWorkspaceRole(body, WS)).toEqual({
      status: 'unavailable',
      reason,
    });
  });

  it('memberAuth 欠損 → unavailable（権限不足と混同しない）', () => {
    const result = parseWorkspaceRole(
      listBody([{ workspaceId: WS, name: 'Workspace' }]),
      WS,
    );
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'contract:memberAuth-missing',
    });
  });

  it('authTypeCode が文字列でない → unavailable', () => {
    expect(parseWorkspaceRole(listBody([item(WS, 3)]), WS)).toEqual({
      status: 'unavailable',
      reason: 'contract:authTypeCode-not-string',
    });
  });

  it('未知のロールコードは resolved + UNKNOWN（上流は正常、値だけが未知）', () => {
    expect(parseWorkspaceRole(listBody([item(WS, '009')]), WS)).toEqual({
      status: 'resolved',
      role: 'UNKNOWN',
      workspaceId: WS,
    });
  });
});

describe('capabilitiesFor（解決できなければ public のみ）', () => {
  it.each([
    [{ status: 'unauthenticated', reason: 'no-token' }],
    [{ status: 'forbidden', reason: 'upstream-403' }],
    [{ status: 'unavailable', reason: 'upstream-503' }],
    [{ status: 'resolved', role: 'UNKNOWN', workspaceId: WS }],
    [{ status: 'resolved', role: 'UNREAD', workspaceId: WS }],
  ] as Array<[RoleResolution]>)('%o → public のみ', (resolution) => {
    expect([...capabilitiesFor(resolution)]).toEqual([...PUBLIC_CAPABILITIES]);
  });

  it('resolved + READ は workspace.read / workspace.generate を含む', () => {
    const capabilities = capabilitiesFor({
      status: 'resolved',
      role: 'READ',
      workspaceId: WS,
    });
    expect(capabilities.has('workspace.read')).toBe(true);
    expect(capabilities.has('workspace.generate')).toBe(true);
    expect(capabilities.has('workspace.write')).toBe(false);
  });
});

describe('HTTP モードは stdio のトークンストアへ落ちない', () => {
  // `tools/list` は Bearer 必須ではない。ここが無いと、未認証のリモート要求が
  // コンテナに保存された stdio 用トークンのロールを引き継いでしまう。
  it('per-request の Bearer が無ければ、トークンストアも上流も触らずに unauthenticated', async () => {
    expect(await resolveWorkspaceRole('http')).toEqual({
      status: 'unauthenticated',
      reason: 'no-bearer',
    });
    expect(getAuthHeaders).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Bearer があれば通常どおり解決する', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, listBody([item(WS, '003')])));

    const result = await runWithHttpAuth({ accessToken: tokenFor(WS) }, () =>
      resolveWorkspaceRole('http'),
    );

    expect(result).toEqual({ status: 'resolved', role: 'READ', workspaceId: WS });
  });

  it('stdio モードでは従来どおりトークンストア経路を使う', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, listBody([item(WS, '001')])));

    await resolveWorkspaceRole('stdio');

    expect(getAuthHeaders).toHaveBeenCalled();
  });
});

describe('resolveWorkspaceRole（上流エラーの分類）', () => {
  it('正常系: /workspace/list を app-key + Bearer 付きで 1 回だけ引く', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, listBody([item(WS, '001')])));

    const result = await resolveWorkspaceRole('stdio');

    expect(result).toEqual({
      status: 'resolved',
      role: 'ADMIN',
      workspaceId: WS,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/workspace/list');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${tokenFor(WS)}`);
    // reposts-api の VerifyVersion ガードは app-key 欠落を 412 で門前払いする。
    expect(headers.get('app-key')).toBeTruthy();
  });

  it('トークンが無い（AuthRequiredError）→ unauthenticated、上流は叩かない', async () => {
    getAuthHeaders.mockRejectedValue(new AuthRequiredError('トークン未保存'));

    expect(await resolveWorkspaceRole('stdio')).toEqual({
      status: 'unauthenticated',
      reason: 'auth-required',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Authorization ヘッダーが Bearer でない → unauthenticated', async () => {
    getAuthHeaders.mockResolvedValue({ Authorization: 'Basic xyz' });

    expect(await resolveWorkspaceRole('stdio')).toEqual({
      status: 'unauthenticated',
      reason: 'no-token',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('workspace_id クレームが無いトークン → unauthenticated', async () => {
    getAuthHeaders.mockResolvedValue({
      Authorization: `Bearer ${tokenFor(undefined)}`,
    });

    expect(await resolveWorkspaceRole('stdio')).toEqual({
      status: 'unauthenticated',
      reason: 'no-workspace-claim',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'unauthenticated', 'upstream-401'],
    [403, 'forbidden', 'upstream-403'],
    [429, 'unavailable', 'upstream-429'],
    [500, 'unavailable', 'upstream-500'],
    [503, 'unavailable', 'upstream-503'],
    [404, 'unavailable', 'upstream-404'],
    [412, 'unavailable', 'upstream-412'],
  ])('上流 %s → %s', async (status, expectedStatus, reason) => {
    mockFetch.mockResolvedValue(jsonResponse(status, { message: 'nope' }));

    expect(await resolveWorkspaceRole('stdio')).toEqual({
      status: expectedStatus,
      reason,
    });
  });

  it('JSON として読めない応答 → unavailable（権限不足に潰さない）', async () => {
    mockFetch.mockResolvedValue(htmlResponse());

    expect(await resolveWorkspaceRole('stdio')).toEqual({
      status: 'unavailable',
      reason: 'upstream-unreachable',
    });
  });

  it('通信断 / タイムアウト → unavailable', async () => {
    mockFetch.mockRejectedValue(new Error('The operation was aborted'));

    expect(await resolveWorkspaceRole('stdio')).toEqual({
      status: 'unavailable',
      reason: 'upstream-unreachable',
    });
  });

  it('タイムアウトは 5 秒（応答を待たせすぎない）', () => {
    expect(WORKSPACE_ROLE_TIMEOUT_MS).toBe(5_000);
  });
});

describe('キャッシュ（ST-1 判断4: 60 秒 / token 単位 / 単一フライト）', () => {
  it('TTL は 60 秒', () => {
    expect(WORKSPACE_ROLE_CACHE_TTL_MS).toBe(60_000);
  });

  it('成功はキャッシュされ 2 回目は上流を叩かない', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, listBody([item(WS, '002')])));

    await resolveWorkspaceRole('stdio');
    const second = await resolveWorkspaceRole('stdio');

    expect(second).toEqual({
      status: 'resolved',
      role: 'WRITE',
      workspaceId: WS,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('同時呼び出しは 1 本の fetch に束ねる（単一フライト）', async () => {
    let release: (value: Response) => void = () => undefined;
    mockFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const inflight = Promise.all([
      resolveWorkspaceRole('stdio'),
      resolveWorkspaceRole('stdio'),
      resolveWorkspaceRole('stdio'),
    ]);
    release(jsonResponse(200, listBody([item(WS, '001')])));
    const results = await inflight;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toEqual({
        status: 'resolved',
        role: 'ADMIN',
        workspaceId: WS,
      });
    }
  });

  it.each([
    [500, 'unavailable'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
  ])('失敗 (%s) は負キャッシュしない（復旧後に権限が戻る）', async (status) => {
    mockFetch.mockResolvedValueOnce(jsonResponse(status, { message: 'nope' }));
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, listBody([item(WS, '001')])),
    );

    await resolveWorkspaceRole('stdio');
    const second = await resolveWorkspaceRole('stdio');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(second).toEqual({
      status: 'resolved',
      role: 'ADMIN',
      workspaceId: WS,
    });
  });

  it('TTL 経過後は引き直し、降格が反映される', async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, listBody([item(WS, '002')])),
      );
      expect(await resolveWorkspaceRole('stdio')).toMatchObject({ role: 'WRITE' });

      jest.setSystemTime(Date.now() + WORKSPACE_ROLE_CACHE_TTL_MS + 1);
      mockFetch.mockResolvedValueOnce(
        jsonResponse(200, listBody([item(WS, '003')])),
      );
      expect(await resolveWorkspaceRole('stdio')).toMatchObject({ role: 'READ' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('トークンが変われば別エントリとして引き直す（ワークスペース切り替え）', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, listBody([item(WS, '001')])),
    );
    expect(await resolveWorkspaceRole('stdio')).toMatchObject({ workspaceId: WS });

    getAuthHeaders.mockResolvedValue({
      Authorization: `Bearer ${tokenFor('ws-2')}`,
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, listBody([item('ws-2', '003')])),
    );
    expect(await resolveWorkspaceRole('stdio')).toEqual({
      status: 'resolved',
      role: 'READ',
      workspaceId: 'ws-2',
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('clearWorkspaceRoleCache で次回は引き直す（authenticate force=true 相当）', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, listBody([item(WS, '001')])));

    await resolveWorkspaceRole('stdio');
    clearWorkspaceRoleCache();
    await resolveWorkspaceRole('stdio');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('resolveWorkspaceAuthorization', () => {
  it('解決結果と capability を一緒に返す', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, listBody([item(WS, '003')])));

    const { capabilities, resolution } = await resolveWorkspaceAuthorization('stdio');

    expect(resolution).toEqual({
      status: 'resolved',
      role: 'READ',
      workspaceId: WS,
    });
    expect(capabilities.has('workspace.generate')).toBe(true);
    expect(capabilities.has('workspace.write')).toBe(false);
  });

  it('上流障害では public のみへ fail-closed する', async () => {
    mockFetch.mockResolvedValue(jsonResponse(503, {}));

    const { capabilities, resolution } = await resolveWorkspaceAuthorization('stdio');

    expect(resolution.status).toBe('unavailable');
    expect([...capabilities]).toEqual([...PUBLIC_CAPABILITIES]);
  });
});
