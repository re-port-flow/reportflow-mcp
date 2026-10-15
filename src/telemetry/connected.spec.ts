import type { TelemetryClient, TelemetryEvent } from './client.js';
import { MCP_CONNECTED_EVENT, trackMcpConnected } from './connected.js';

class RecordingClient implements TelemetryClient {
  events: TelemetryEvent[] = [];
  track(event: TelemetryEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
}

describe('trackMcpConnected', () => {
  it('workspaceId 付きで integration.mcp.connected を送る', () => {
    const client = new RecordingClient();
    trackMcpConnected(client, { workspaceId: 'ws1' });

    expect(client.events).toHaveLength(1);
    expect(client.events[0]).toMatchObject({
      event: MCP_CONNECTED_EVENT,
      workspaceId: 'ws1',
      properties: { via: 'oauth' },
    });
    expect(typeof client.events[0].timestamp).toBe('number');
  });

  // 空文字は collector が未設定と同じ空文字として blob3 に書くので、
  // 「付けた」と誤読される。gallery-demand.ts と同じ扱い。
  it.each([[undefined], ['']])(
    'workspaceId が %p のときはキー自体を付けない',
    (workspaceId) => {
      const client = new RecordingClient();
      trackMcpConnected(client, {
        workspaceId: workspaceId as string | undefined,
      });

      expect(client.events[0]).not.toHaveProperty('workspaceId');
    },
  );

  // Schema §8 の追加手順を踏んでいない property は載せない。scope の内訳が要る
  // なら、`handleAuthenticate` の戻り値を構造化するところから別途やる。
  it('properties は via だけ（仕様外の項目を足さない）', () => {
    const client = new RecordingClient();
    trackMcpConnected(client, { workspaceId: 'ws1' });

    expect(client.events[0].properties).toEqual({ via: 'oauth' });
  });

  it('引数なしでも送れる', () => {
    const client = new RecordingClient();
    trackMcpConnected(client);

    expect(client.events[0]).toMatchObject({ event: MCP_CONNECTED_EVENT });
  });

  it('track が throw しても呼び出し側へ伝播させない（計測で応答を壊さない）', () => {
    const throwing: TelemetryClient = {
      track: () => {
        throw new Error('boom');
      },
      flush: async () => {},
    };

    expect(() =>
      trackMcpConnected(throwing, { workspaceId: 'ws1' }),
    ).not.toThrow();
  });
});
