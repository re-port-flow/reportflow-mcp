import {
  denialMessage,
  denialResult,
  guardToolHandler,
  TOOL_DENIED_EVENT,
  trackToolDenied,
  type GuardedToolResult,
  type ToolDenial,
} from './tool-guard';
import { UnknownCapabilitySubjectError } from './workspace-permission';
import type { TelemetryClient } from './telemetry/index';
import type { RoleResolution, WorkspaceAuthorization } from './workspace-role';

const capturingTelemetry = () => {
  const events: Parameters<TelemetryClient['track']>[0][] = [];
  const client: TelemetryClient = {
    track: (event) => {
      events.push(event);
    },
    flush: () => Promise.resolve(),
  };
  return { client, events };
};

const authorization = (
  resolution: RoleResolution,
  capabilities: string[],
): WorkspaceAuthorization =>
  ({
    resolution,
    capabilities: new Set(capabilities),
  }) as WorkspaceAuthorization;

const READ_AUTH = authorization(
  { status: 'resolved', role: 'READ', workspaceId: 'ws-1' },
  ['public', 'workspace.read', 'workspace.generate'],
);
const ADMIN_AUTH = authorization(
  { status: 'resolved', role: 'ADMIN', workspaceId: 'ws-1' },
  ['public', 'workspace.read', 'workspace.generate', 'workspace.write'],
);
const UNAUTH = authorization(
  { status: 'unauthenticated', reason: 'no-token' },
  ['public'],
);
const UNAVAILABLE = authorization(
  { status: 'unavailable', reason: 'upstream-503' },
  ['public'],
);
const FORBIDDEN = authorization(
  { status: 'forbidden', reason: 'workspace-not-in-list' },
  ['public'],
);

const denialFor = (resolution: RoleResolution): ToolDenial => ({
  toolName: 'copy_gallery_template',
  requiredCapability: 'workspace.write',
  resolution,
});

describe('denialMessage（原因ごとに文言を分ける）', () => {
  it('resolved: 自分のロールと必要権限を伝える（次の一手が決まる）', () => {
    const text = denialMessage(
      denialFor({ status: 'resolved', role: 'READ', workspaceId: 'ws-1' }),
      'http',
    );
    expect(text).toContain('copy_gallery_template');
    expect(text).toContain('READ');
    // 仕様変更（情報設計 用語統一 2026-09）
    expect(text).toContain('閲覧者 (READ)');
    expect(text).toContain('編集者 (WRITE) 以上');
  });

  it('unauthenticated: 経路別の再認証手順を出す', () => {
    expect(
      denialMessage(
        denialFor({ status: 'unauthenticated', reason: 'no-token' }),
        'http',
      ),
    ).toContain('OAuth トークンを再取得');
    expect(
      denialMessage(
        denialFor({ status: 'unauthenticated', reason: 'no-token' }),
        'stdio',
      ),
    ).toContain('authenticate ツール');
  });

  it('forbidden: 所属・存在を推測させない一般的な文言に留める', () => {
    const text = denialMessage(
      denialFor({ status: 'forbidden', reason: 'workspace-not-in-list' }),
      'http',
    );
    expect(text).toContain('確認できませんでした');
    // 「そのワークスペースは存在しない」「あなたは除籍された」等は書かない。
    expect(text).not.toContain('除籍');
    expect(text).not.toContain('存在しません');
  });

  it('unavailable: 権限不足ではないと明示する（障害中に権限設定を疑わせない）', () => {
    const text = denialMessage(
      denialFor({ status: 'unavailable', reason: 'upstream-503' }),
      'http',
    );
    expect(text).toContain('権限不足ではなく');
    expect(text).toContain('再試行');
  });

  it('reason（内部識別子）は利用者向け文言に出さない', () => {
    for (const resolution of [
      { status: 'unauthenticated', reason: 'upstream-401' },
      { status: 'forbidden', reason: 'workspace-not-in-list' },
      { status: 'unavailable', reason: 'contract:duplicate-workspace' },
    ] as RoleResolution[]) {
      const text = denialMessage(denialFor(resolution), 'http');
      expect(text).not.toContain('upstream-');
      expect(text).not.toContain('contract:');
      expect(text).not.toContain('workspace-not-in-list');
    }
  });
});

describe('denialResult', () => {
  it('isError: true のテキスト応答を返す（プロトコルエラーにしない）', () => {
    const result = denialResult(
      denialFor({ status: 'resolved', role: 'READ', workspaceId: 'ws-1' }),
      'http',
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text.startsWith('エラー: ')).toBe(true);
  });
});

describe('trackToolDenied', () => {
  it('tool / 必要 capability / status / role / reason を送る', () => {
    const { client, events } = capturingTelemetry();

    trackToolDenied(
      client,
      denialFor({ status: 'resolved', role: 'READ', workspaceId: 'ws-1' }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe(TOOL_DENIED_EVENT);
    expect(events[0].properties).toMatchObject({
      tool: 'copy_gallery_template',
      requiredCapability: 'workspace.write',
      resolutionStatus: 'resolved',
      resolvedRole: 'READ',
      reason: 'capability-denied',
    });
  });

  it('resolved のときだけ workspace を帰属させる（未認証の注入を防ぐ）', () => {
    const { client, events } = capturingTelemetry();

    trackToolDenied(
      client,
      denialFor({ status: 'resolved', role: 'READ', workspaceId: 'ws-1' }),
    );
    trackToolDenied(
      client,
      denialFor({ status: 'unauthenticated', reason: 'no-token' }),
    );

    expect(events[0].workspaceId).toBe('ws-1');
    expect(events[1].workspaceId).toBeUndefined();
  });

  it('トークンや個人情報を含むキーを持たない', () => {
    const { client, events } = capturingTelemetry();
    trackToolDenied(
      client,
      denialFor({ status: 'unauthenticated', reason: 'upstream-401' }),
    );

    const serialized = JSON.stringify(events[0]);
    for (const forbidden of ['token', 'Bearer', 'email', 'authorization']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('guardToolHandler', () => {
  const upstream = jest.fn();
  global.fetch = upstream as unknown as typeof fetch;

  const handler = jest.fn(
    async (): Promise<GuardedToolResult> => ({
      content: [{ type: 'text', text: 'ok' }],
    }),
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const guarded = (
    toolName: string,
    auth: WorkspaceAuthorization,
    telemetry: TelemetryClient,
  ) =>
    guardToolHandler(toolName, handler, {
      mode: 'http',
      telemetry,
      resolve: () => Promise.resolve(auth),
    });

  it('capability を満たせば handler をそのまま呼ぶ', async () => {
    const { client } = capturingTelemetry();

    const result = await guarded(
      'copy_gallery_template',
      ADMIN_AUTH,
      client,
    )({});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
  });

  it('READ が copy_gallery_template を直接呼んでも handler は 0 回・上流 fetch も 0 回', async () => {
    const { client, events } = capturingTelemetry();

    const result = await guarded(
      'copy_gallery_template',
      READ_AUTH,
      client,
    )({});

    expect(handler).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(events.map((event) => event.event)).toEqual([TOOL_DENIED_EVENT]);
  });

  it('READ は PDF 生成ツールを実行できる（ST-1 判断1 = 案A）', async () => {
    const { client } = capturingTelemetry();

    await guarded('generate_pdf_sync', READ_AUTH, client)({});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('READ は download_file を実行できる（ST-1 判断2 = 参照 capability）', async () => {
    const { client } = capturingTelemetry();

    await guarded('download_file', READ_AUTH, client)({});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['未認証', UNAUTH],
    ['非所属 / 未承認', FORBIDDEN],
    ['上流障害', UNAVAILABLE],
  ])(
    '%s では workspace 系ツールを handler へ通さない',
    async (_label, auth) => {
      const { client } = capturingTelemetry();

      const result = await guarded('list_templates', auth, client)({});

      expect(handler).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    },
  );

  it.each([
    ['未認証', UNAUTH],
    ['上流障害', UNAVAILABLE],
  ])(
    '%s でも公開ギャラリーツールは通る（ST-1 判断3）',
    async (_label, auth) => {
      const { client } = capturingTelemetry();

      await guarded('search_gallery_templates', auth, client)({});

      expect(handler).toHaveBeenCalledTimes(1);
    },
  );

  it('onAuthorized は解決のたびに呼ばれ、例外を投げてもツールを壊さない', async () => {
    const { client } = capturingTelemetry();
    const onAuthorized = jest.fn(() => {
      throw new Error('list_changed 送信に失敗');
    });

    const result = await guardToolHandler('list_templates', handler, {
      mode: 'stdio',
      telemetry: client,
      onAuthorized,
      resolve: () => Promise.resolve(READ_AUTH),
    })({});

    expect(onAuthorized).toHaveBeenCalledWith(READ_AUTH);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
  });

  it('表に無いツール名は包む時点で throw する（実行時に既定許可へ落ちない）', () => {
    const { client } = capturingTelemetry();
    expect(() =>
      guardToolHandler('not_in_table', handler, {
        mode: 'http',
        telemetry: client,
      }),
    ).toThrow(UnknownCapabilitySubjectError);
  });
});
