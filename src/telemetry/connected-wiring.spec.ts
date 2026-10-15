// `integration.mcp.connected` と client 種別が **createMcpServer の配線として**
// 効いているかを見る (PRJ-3-1438 / ST-1)。
//
// `server.spec.ts` は `withTelemetry` をパススルーにモックしているので、
// テレメトリの中身はあちらでは検証されない。ここは実物の interceptor と
// client-context を通し、注入した TelemetryClient に何が届くかを見る。
//
// 帰属は**実物の `recordCredentialWorkspace`** で駆動する — 本番では
// `authorize()` が交換直後にこれを呼ぶ (`auth.ts` の `rememberWorkspace`)。
// `interceptor.spec.ts` が既定 resolver を実物で通すのと同じ組み方。

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../server.js';
import { adminAuthorizationOptions } from '../integration/helpers/createTestClient.js';
import type { TelemetryClient, TelemetryEvent } from './client.js';
import { MCP_CONNECTED_EVENT } from './connected.js';
import { MCP_INVOKED_EVENT } from './interceptor.js';
import { recordCredentialWorkspace } from './workspace.js';

const mockHandleAuthenticate = jest.fn();

jest.mock('../tools/authenticate', () => ({
  authenticateTool: {
    name: 'authenticate',
    description: 'test',
  },
  handleAuthenticate: (input: unknown) => mockHandleAuthenticate(input),
}));
jest.mock('../auth', () => ({
  authorize: jest.fn(),
  requestWithAuth: jest.fn(),
  getAuthWorkspaceId: jest.fn(),
}));
jest.mock('../client', () => ({
  listDesigns: jest.fn(),
  getDesignParameters: jest.fn(),
  generatePdfSync: jest.fn(),
  generatePdfAsync: jest.fn(),
  generatePdfsSync: jest.fn(),
  generatePdfsAsync: jest.fn(),
  downloadFile: jest.fn(),
  downloadZip: jest.fn(),
  getGenerationStatus: jest.fn(),
}));
jest.mock('../roots/index', () => ({
  resolveDefaultOutputDir: jest.fn(),
  resolveAllowedRoots: jest.fn(),
}));
jest.mock('../sampling/request', () => ({
  requestSamplingText: jest.fn(),
}));

class RecordingClient implements TelemetryClient {
  events: TelemetryEvent[] = [];
  track(event: TelemetryEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
}

const connect = async (telemetry: TelemetryClient, clientName: string) => {
  const server = createMcpServer({
    mode: 'stdio',
    telemetry,
    ...adminAuthorizationOptions(),
  });
  const client = new Client({ name: clientName, version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
};

const okResult = { content: [{ type: 'text' as const, text: '✅ 認証完了' }] };
const errResult = {
  content: [{ type: 'text' as const, text: '認証失敗: nope' }],
  isError: true as const,
};

/** 本番の `authorize()` と同じく、成功時に呼び出しスコープへ帰属を記録する。 */
const authorizesInto = (workspaceId: string | undefined) => {
  mockHandleAuthenticate.mockImplementation(async () => {
    recordCredentialWorkspace(workspaceId);
    return okResult;
  });
};

const connectedEvents = (telemetry: RecordingClient): TelemetryEvent[] =>
  telemetry.events.filter((e) => e.event === MCP_CONNECTED_EVENT);

beforeEach(() => {
  mockHandleAuthenticate.mockReset();
});

describe('createMcpServer のテレメトリ配線', () => {
  it('authenticate 成功時に integration.mcp.connected を workspace 付きで送る', async () => {
    authorizesInto('ws-123');
    const telemetry = new RecordingClient();
    const { client, close } = await connect(telemetry, 'claude-ai');

    await client.callTool({ name: 'authenticate', arguments: {} });
    await close();

    const connected = connectedEvents(telemetry);
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({
      workspaceId: 'ws-123',
      properties: { via: 'oauth', client: 'claude' },
    });
  });

  it('authenticate 失敗時は connected を送らない', async () => {
    mockHandleAuthenticate.mockResolvedValue(errResult);
    const telemetry = new RecordingClient();
    const { client, close } = await connect(telemetry, 'claude-ai');

    await client.callTool({ name: 'authenticate', arguments: {} });
    await close();

    expect(connectedEvents(telemetry)).toHaveLength(0);
  });

  // 旧 TokenSet に workspaceId が無く JWT にも claim が無いと、auth 層は
  // undefined を記録する。帰属が取れないことは「接続しなかった」ではない。
  it('workspace を確定できなくても connected は送る（帰属だけ落とす）', async () => {
    authorizesInto(undefined);
    const telemetry = new RecordingClient();
    const { client, close } = await connect(telemetry, 'cursor-vscode');

    await client.callTool({ name: 'authenticate', arguments: {} });
    await close();

    const connected = connectedEvents(telemetry);
    expect(connected).toHaveLength(1);
    expect(connected[0]).not.toHaveProperty('workspaceId');
    expect(connected[0].properties).toMatchObject({ client: 'cursor' });
  });

  // 帰属を保存済み資格情報から読み直す実装だと、並行する認証が確立した
  // ワークスペースを拾い得る (PRJ-3-1117 が設計から消した競合)。
  // 呼び出しスコープから読んでいる限り、A の connected は A に帰属する。
  it('並行する authenticate の workspace が混ざらない', async () => {
    const telemetry = new RecordingClient();
    let releaseA = (): void => {};
    const aMayFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // A: 先に交換を終えて待つ。B: 別ワークスペースを確立して A を進める。
    mockHandleAuthenticate.mockImplementation(
      async (input: { force?: boolean }) => {
        if (input.force === true) {
          recordCredentialWorkspace('ws-B');
          releaseA();
        } else {
          recordCredentialWorkspace('ws-A');
          await aMayFinish;
        }
        return okResult;
      },
    );

    const a = await connect(telemetry, 'claude-ai');
    const b = await connect(telemetry, 'claude-ai');

    await Promise.all([
      a.client.callTool({ name: 'authenticate', arguments: {} }),
      b.client.callTool({ name: 'authenticate', arguments: { force: true } }),
    ]);
    await Promise.all([a.close(), b.close()]);

    expect(
      connectedEvents(telemetry)
        .map((e) => e.workspaceId)
        .sort(),
    ).toEqual(['ws-A', 'ws-B']);
  });

  // ST-1 の受け入れ基準「client 種別で集計できる」の本体。
  it('integration.mcp.invoked に initialize で名乗った client 種別が載る', async () => {
    authorizesInto('ws-123');
    const telemetry = new RecordingClient();
    const { client, close } = await connect(telemetry, 'cursor-vscode');

    await client.callTool({ name: 'authenticate', arguments: {} });
    await close();

    const invoked = telemetry.events.filter(
      (e) => e.event === MCP_INVOKED_EVENT,
    );
    expect(invoked.length).toBeGreaterThan(0);
    expect(invoked[0].properties).toMatchObject({
      tool: 'authenticate',
      client: 'cursor',
    });
    // 実名は載せない（外部入力なので properties に通さない）
    expect(invoked[0].properties).not.toHaveProperty('clientName');
  });
});
