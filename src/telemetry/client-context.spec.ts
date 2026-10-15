import type { TelemetryClient, TelemetryEvent } from './client.js';
import { withClientContext } from './client-context.js';

class RecordingClient implements TelemetryClient {
  events: TelemetryEvent[] = [];
  track(event: TelemetryEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
}

describe('withClientContext', () => {
  it('integration.mcp.invoked に client を足す', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => ({ name: 'cursor-vscode' }));

    wrapped.track({
      event: 'integration.mcp.invoked',
      properties: { tool: 'list_templates', success: true },
    });

    expect(base.events[0].properties).toMatchObject({
      tool: 'list_templates',
      success: true,
      client: 'cursor',
    });
  });

  // 実名は外部入力なので**どのイベントにも載せない**。
  // 種別が判定できた場合でも、名前の周りに任意の文字列が付いてくる
  // （`alice smith cursor` は cursor と判定される）ため、載せれば漏れる。
  it.each([
    ['cursor-vscode'],
    ['alice smith cursor'],
    ['Alice Smith'],
    ['123-45-6789'],
  ])('実名 (%p) は properties に載せない', (name) => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => ({ name }));

    wrapped.track({
      event: 'integration.mcp.invoked',
      properties: { tool: 'x', success: true },
    });

    expect(base.events[0].properties).not.toHaveProperty('clientName');
    // 名前の断片がイベントのどこにも残らないこと
    const serialized = JSON.stringify(base.events[0]).toLowerCase();
    for (const part of name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)) {
      if (part === 'cursor') continue; // 種別として正当に残る語
      expect(serialized).not.toContain(part);
    }
  });

  it('integration.mcp.connected にも足す', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => ({ name: 'claude-ai' }));

    wrapped.track({
      event: 'integration.mcp.connected',
      properties: { via: 'oauth' },
    });

    expect(base.events[0].properties).toMatchObject({
      via: 'oauth',
      client: 'claude',
    });
  });

  // gallery 系は Schema §3.4 が properties を定義しているので勝手に足さない。
  it('対象外のイベントは properties を素通しする', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => ({ name: 'claude-ai' }));

    wrapped.track({
      event: 'integration.mcp.gallery.searched',
      properties: { resultCount: 3 },
    });

    expect(base.events[0].properties).toEqual({ resultCount: 3 });
    expect(base.events[0].properties).not.toHaveProperty('client');
  });

  it('workspaceId や timestamp などのトップレベル項目を保つ', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => ({ name: 'claude-ai' }));

    wrapped.track({
      event: 'integration.mcp.invoked',
      workspaceId: 'ws1',
      timestamp: 1_700_000_000_000,
      properties: { tool: 'generate_pdf_sync', success: true },
    });

    expect(base.events[0]).toMatchObject({
      event: 'integration.mcp.invoked',
      workspaceId: 'ws1',
      timestamp: 1_700_000_000_000,
    });
  });

  it('呼び出し側が入れた client を上書きしない', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => ({ name: 'claude-ai' }));

    wrapped.track({
      event: 'integration.mcp.invoked',
      properties: {
        tool: 'x',
        success: true,
        client: 'preset',
        clientNameOmitted: false,
      },
    });

    expect(base.events[0].properties).toMatchObject({
      client: 'preset',
      clientNameOmitted: false,
    });
  });

  // 「ハンドシェイク前で名前が無い」と「未知のクライアントが名乗ってきた」を
  // 区別する。畳むと `other` の中身が分からず PATTERNS を育てる手掛かりが消える。
  it('種別を判定できない名前は clientNameOmitted で件数だけ残す', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => ({
      name: 'some-new-agent',
    }));

    wrapped.track({
      event: 'integration.mcp.invoked',
      properties: { tool: 'x', success: true },
    });

    expect(base.events[0].properties).not.toHaveProperty('clientName');
    expect(JSON.stringify(base.events[0])).not.toContain('some-new-agent');
    expect(base.events[0].properties).toMatchObject({
      client: 'other',
      clientNameOmitted: true,
    });
  });

  // 種別が判定できたなら `client` が答えなので、omitted は付けない（ノイズ）。
  it('種別を判定できたときは clientNameOmitted を付けない', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => ({ name: 'claude-ai' }));

    wrapped.track({
      event: 'integration.mcp.invoked',
      properties: { tool: 'x', success: true },
    });

    expect(base.events[0].properties).toMatchObject({ client: 'claude' });
    expect(base.events[0].properties).not.toHaveProperty('clientNameOmitted');
  });

  it('ハンドシェイク前は clientNameOmitted を付けない（名前が無いだけ）', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => undefined);

    wrapped.track({
      event: 'integration.mcp.invoked',
      properties: { tool: 'x', success: true },
    });

    expect(base.events[0].properties).not.toHaveProperty('clientNameOmitted');
  });

  it('ハンドシェイク前（undefined）でも other として送る', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => undefined);

    wrapped.track({
      event: 'integration.mcp.invoked',
      properties: { tool: 'x', success: true },
    });

    expect(base.events[0].properties).toMatchObject({ client: 'other' });
    // 名前を名乗っていないので omitted も付けない
    expect(base.events[0].properties).not.toHaveProperty('clientName');
    expect(base.events[0].properties).not.toHaveProperty('clientNameOmitted');
  });

  // initialize は server 生成より後に完了する。生成時に 1 回読む実装だと
  // 常に undefined になるので、track のたびに解決していることを固定する。
  it('client 情報を track のたびに解決する（遅延解決）', () => {
    const base = new RecordingClient();
    let info: { name?: unknown } | undefined = undefined;
    const wrapped = withClientContext(base, () => info);

    wrapped.track({
      event: 'integration.mcp.invoked',
      properties: { tool: 'a', success: true },
    });
    info = { name: 'cursor' };
    wrapped.track({
      event: 'integration.mcp.invoked',
      properties: { tool: 'b', success: true },
    });

    expect(base.events[0].properties).toMatchObject({ client: 'other' });
    expect(base.events[1].properties).toMatchObject({ client: 'cursor' });
  });

  it('resolver が throw しても計測を落とさない', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => {
      throw new Error('boom');
    });

    expect(() =>
      wrapped.track({
        event: 'integration.mcp.invoked',
        properties: { tool: 'x', success: true },
      }),
    ).not.toThrow();
    expect(base.events).toHaveLength(1);
    expect(base.events[0].properties).toMatchObject({ client: 'other' });
  });

  it('properties が無いイベントでも足せる', () => {
    const base = new RecordingClient();
    const wrapped = withClientContext(base, () => ({ name: 'zed' }));

    wrapped.track({ event: 'integration.mcp.connected' });

    expect(base.events[0].properties).toMatchObject({ client: 'zed' });
  });

  it('flush を委譲する', async () => {
    const base = new RecordingClient();
    const spy = jest.spyOn(base, 'flush');
    await withClientContext(base, () => undefined).flush();
    expect(spy).toHaveBeenCalled();
  });
});
