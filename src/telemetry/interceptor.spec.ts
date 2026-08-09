import { runWithHttpAuth } from '../auth-context.js';
import type { TelemetryClient, TelemetryEvent } from './client.js';
import { withTelemetry } from './interceptor.js';
import { recordCredentialWorkspace } from './workspace.js';

class RecordingClient implements TelemetryClient {
  events: TelemetryEvent[] = [];
  track(event: TelemetryEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
}

/**
 * 既定の resolver は認証コンテキスト (HTTP の Bearer / 資格情報の記録) を読む。
 * テストではそれを踏ませないよう明示的に注入する。
 */
const noWorkspace = (): string | undefined => undefined;

const ok = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

describe('withTelemetry', () => {
  it('emits integration.mcp.invoked with success=true on normal return', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'list_templates',
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      noWorkspace,
    );

    await wrapped({});

    expect(client.events).toHaveLength(1);
    expect(client.events[0].event).toBe('integration.mcp.invoked');
    expect(client.events[0].properties?.tool).toBe('list_templates');
    expect(client.events[0].properties?.success).toBe(true);
    expect(client.events[0].properties?.errorClass).toBeUndefined();
    expect(typeof client.events[0].properties?.durationMs).toBe('number');
  });

  it('emits success=false + errorClass when result.isError is true', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'generate_pdf_sync',
      async () => ({
        isError: true as const,
        content: [{ type: 'text' as const, text: 'boom' }],
      }),
      noWorkspace,
    );

    await wrapped({});

    expect(client.events[0].properties?.success).toBe(false);
    expect(client.events[0].properties?.errorClass).toBe('ToolError');
  });

  it('emits success=false + Error class name on thrown errors and rethrows', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'authenticate',
      async () => {
        throw new TypeError('nope');
      },
      noWorkspace,
    );

    await expect(wrapped({})).rejects.toThrow('nope');
    expect(client.events[0].properties?.success).toBe(false);
    expect(client.events[0].properties?.errorClass).toBe('TypeError');
  });

  it('omits workspaceId when the auth context provides none', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', ok, noWorkspace);

    await wrapped({});

    expect(client.events[0].workspaceId).toBeUndefined();
  });

  // PRJ-3-1093: workspace はツール入力ではなく認証コンテキストに属する。
  // ここが空のままだと MCP 経由の利用をワークスペース単位で集計できない。
  it('attaches the workspaceId resolved from the auth context', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'generate_pdf_sync',
      ok,
      () => '0eLHZZ8PxpU4Z5r7',
    );

    await wrapped({});

    expect(client.events[0].workspaceId).toBe('0eLHZZ8PxpU4Z5r7');
  });

  // PRJ-3-1117 (仕様変更): 以前はツール入力の workspaceId を最優先していたが、
  // 帰属は認証コンテキストのみから決めるようにした。入力は呼び出し側が申告する
  // 値であり、他ワークスペース宛のイベントを作れてしまう (今日 `workspaceId` を
  // 入力に持つツールは無いので、本番挙動は変わらない)。
  it('ignores a workspaceId supplied in the tool input', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'list_templates',
      ok,
      () => 'from-auth-context',
    );

    await wrapped({ workspaceId: 'from-input' });

    expect(client.events[0].workspaceId).toBe('from-auth-context');
  });

  it('does not fall back to the tool input when the auth context has none', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', ok, noWorkspace);

    await wrapped({ workspaceId: 'from-input' });

    expect(client.events[0].workspaceId).toBeUndefined();
  });

  it('always calls the resolver, even when the input carries a workspaceId', async () => {
    const client = new RecordingClient();
    let calls = 0;
    const wrapped = withTelemetry(client, 'list_templates', ok, () => {
      calls += 1;
      return 'from-auth-context';
    });

    await wrapped({ workspaceId: 'from-input' });

    expect(calls).toBe(1);
    expect(client.events[0].workspaceId).toBe('from-auth-context');
  });

  // PRJ-3-1117 (仕様変更): 以前は失敗イベントにも workspace を付けていた。
  // HTTP モードの workspace_id は署名検証していない Bearer JWT の claim で、
  // 上流 API が拒否するまでは通るため、未認証の第三者が任意のワークスペース宛に
  // イベントを注入できてしまう。理由の詳細は interceptor.ts のコメント。
  it('omits the workspaceId when the tool returns isError', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'generate_pdf_sync',
      async () => ({
        isError: true as const,
        content: [{ type: 'text' as const, text: 'boom' }],
      }),
      () => '0eLHZZ8PxpU4Z5r7',
    );

    await wrapped({});

    expect(client.events[0].workspaceId).toBeUndefined();
    expect(client.events[0].properties?.success).toBe(false);
  });

  it('omits the workspaceId when the tool throws', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'generate_pdf_sync',
      async () => {
        throw new Error('boom');
      },
      () => '0eLHZZ8PxpU4Z5r7',
    );

    await expect(wrapped({})).rejects.toThrow('boom');
    expect(client.events[0].workspaceId).toBeUndefined();
    expect(client.events[0].properties?.success).toBe(false);
  });

  // telemetry の解決失敗でツール実行を壊さないこと。
  it('still emits (without workspaceId) when the resolver throws', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', ok, () => {
      throw new Error('auth context unavailable');
    });

    const result = await wrapped({});

    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(client.events).toHaveLength(1);
    expect(client.events[0].workspaceId).toBeUndefined();
    expect(client.events[0].properties?.success).toBe(true);
  });

  // 解決は同期・I/O 無しであること (Codex P2)。ハンドラ完了後に
  // await が挟まると、遅い keychain 等でツール応答が止まる。
  it('resolves the workspace synchronously after the handler settles', async () => {
    const client = new RecordingClient();
    let resolvedAt = 0;
    let handlerFinishedAt = 0;

    const wrapped = withTelemetry(
      client,
      'list_templates',
      async () => {
        handlerFinishedAt = Date.now();
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
      () => {
        resolvedAt = Date.now();
        return 'ws';
      },
    );

    await wrapped({});

    expect(resolvedAt).toBeGreaterThanOrEqual(handlerFinishedAt);
    expect(client.events[0].workspaceId).toBe('ws');
  });
});

// 既定の resolver + 実物の `recordCredentialWorkspace` で本番配線を通す
// (auth.ts の `rememberWorkspace` がこの関数を呼ぶ)。
describe('withTelemetry — 資格情報からの帰属 (既定の resolver)', () => {
  it('この呼び出しが読んだ資格情報の workspace を載せる (cold start を含む)', async () => {
    const client = new RecordingClient();
    // 起動直後の stdio プロセスでは、ハンドラ内の `getAuthHeaders()` で初めて
    // 資格情報が読まれる。開始時点を見る実装だと初回呼び出しが未帰属になる。
    const wrapped = withTelemetry(client, 'list_templates', async () => {
      recordCredentialWorkspace('ws-A');
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    });

    await wrapped({});

    expect(client.events[0].workspaceId).toBe('ws-A');
  });

  it('資格情報を読まずに成功した呼び出しは未帰属', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', ok);

    await wrapped({});

    expect(client.events[0].workspaceId).toBeUndefined();
  });

  // `authenticate force=true`: 破棄 → OAuth 交換 → 新 workspace 保存。
  // 401 リトライ: 拒否された資格情報 → refresh した資格情報。
  it('呼び出し中に資格情報が切り替わったら最後に確立された workspace を載せる', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'authenticate', async () => {
      recordCredentialWorkspace(undefined);
      recordCredentialWorkspace('ws-B');
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    });

    await wrapped({});

    expect(client.events[0].workspaceId).toBe('ws-B');
  });

  // HTTP モードは per-request の Bearer が答え (資格情報の記録は使わない)。
  // 解決はハンドラ完了後に行うため、その時点でもリクエストの ALS コンテキストが
  // 生きていることを固定する。
  it('HTTP モードではリクエストの Bearer から帰属先を決める', async () => {
    const client = new RecordingClient();
    const payload = Buffer.from(
      JSON.stringify({ workspace_id: 'from-bearer' }),
    ).toString('base64url');
    const wrapped = withTelemetry(client, 'search', ok);

    await runWithHttpAuth({ accessToken: `header.${payload}.sig` }, () =>
      wrapped({}),
    );

    expect(client.events[0].workspaceId).toBe('from-bearer');
  });

  it('並行呼び出しの帰属先が互いに混ざらない', async () => {
    const client = new RecordingClient();

    // 「A が資格情報を読む → B が別ワークスペースを確立する → A が完了する」の順に
    // なるよう待ち合わせる。プロセス幅のキャッシュを見る実装だと A が B に付く。
    let releaseA = (): void => {};
    const aCanFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const toolA = withTelemetry(client, 'tool_a', async () => {
      recordCredentialWorkspace('ws-A');
      await aCanFinish;
      return { content: [{ type: 'text' as const, text: 'a' }] };
    });
    const toolB = withTelemetry(client, 'tool_b', async () => {
      recordCredentialWorkspace('ws-B');
      releaseA();
      return { content: [{ type: 'text' as const, text: 'b' }] };
    });

    const a = toolA({});
    await toolB({});
    await a;

    const byTool = new Map(
      client.events.map((e) => [e.properties?.tool, e.workspaceId]),
    );
    expect(byTool.get('tool_a')).toBe('ws-A');
    expect(byTool.get('tool_b')).toBe('ws-B');
  });
});
