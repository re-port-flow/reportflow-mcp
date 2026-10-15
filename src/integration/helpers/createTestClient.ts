import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../../server';
import {
  capabilitiesForRole,
  type WorkspaceRole,
} from '../../workspace-permission';
import {
  capabilitiesFor,
  type WorkspaceAuthorization,
} from '../../workspace-role';

export type TestClientHandle = {
  client: Client;
  cleanup: () => Promise<void>;
};

/**
 * ロールを固定した認可結果を作る (PRJ-3-1584 / ST-3)。
 *
 * e2e ではトークンストアもネットワークも無いため、実 resolver は必ず
 * `unauthenticated` (= public のみ) に落ちる。ロール別のカタログと call ガードを
 * 検証するには、**カタログの初期状態と call ガードの両方**へ同じ答えを渡す必要が
 * あるので、ここで 1 つにまとめる。
 */
export const fixedAuthorization = (
  role: WorkspaceRole,
): WorkspaceAuthorization => ({
  capabilities: capabilitiesForRole(role),
  resolution: { status: 'resolved', role, workspaceId: 'ws-e2e' },
});

/**
 * 未認証 (Bearer 無し / トークン未保存) の認可結果。
 *
 * capability は**本番と同じ解決経路** (`capabilitiesFor`) から作る。
 * `capabilitiesForRole('UNKNOWN')` と今は同じ集合になるが、別経路で書くと
 * 定義がずれた日に e2e が本番と違う集合を検証してしまう。
 */
export const unauthenticatedAuthorization = (): WorkspaceAuthorization => {
  const resolution: WorkspaceAuthorization['resolution'] = {
    status: 'unauthenticated',
    reason: 'no-token',
  };
  return { capabilities: capabilitiesFor(resolution), resolution };
};

/**
 * `createMcpServer` へロールを固定して渡すためのオプション断片。
 *
 * カタログの初期状態 (`capabilities`) と call ガードの解決関数
 * (`resolveAuthorization`) を**必ず同じ値**にするためのヘルパー。片方だけ渡すと
 * 「一覧には出るが呼ぶと拒否される」テスト環境が出来上がり、本番の挙動と乖離する。
 */
export const authorizationOptions = (
  authorization: WorkspaceAuthorization,
): {
  capabilities: WorkspaceAuthorization['capabilities'];
  resolveAuthorization: () => Promise<WorkspaceAuthorization>;
} => ({
  capabilities: authorization.capabilities,
  resolveAuthorization: () => Promise.resolve(authorization),
});

/** 既存テストの既定 (= 全ツールが見える ADMIN)。 */
export const adminAuthorizationOptions = () =>
  authorizationOptions(fixedAuthorization('ADMIN'));

export type CreateTestClientOptions = {
  /**
   * 接続時のワークスペースロール。既定は `ADMIN`
   * (= 全ツールが見える従来どおりの状態)。
   */
  role?: WorkspaceRole;
  /** ロールではなく認可結果そのものを渡す (未認証・解決失敗のケース用)。 */
  authorization?: WorkspaceAuthorization;
};

/**
 * InMemoryTransport で MCP Client / Server を接続する。
 * Server は既定で createMcpServer({ mode: 'stdio' })。mode を渡すと http
 * モードのサーバーにも接続できる (登録ツールがモードで変わるため)。
 * cleanup() で client を閉じる。
 */
export const createTestClient = async (
  mode: 'stdio' | 'http' = 'stdio',
  options: CreateTestClientOptions = {},
): Promise<TestClientHandle> => {
  const authorization =
    options.authorization ?? fixedAuthorization(options.role ?? 'ADMIN');
  const server = createMcpServer({
    mode,
    capabilities: authorization.capabilities,
    resolveAuthorization: () => Promise.resolve(authorization),
  });
  const client = new Client(
    { name: 'e2e-test-client', version: '0.0.0' },
    { capabilities: { sampling: {} } },
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  // Sampling handler スタブ — suggest_params は呼ばないが、
  // 万が一 createSamplingMessage が飛んできても Method not found にならないように。
  client.setRequestHandler('sampling/createMessage', () => ({
    role: 'assistant' as const,
    content: { type: 'text' as const, text: 'stub' },
    model: 'stub',
    stopReason: 'endTurn' as const,
  }));

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const cleanup = async (): Promise<void> => {
    await client.close();
  };

  return { client, cleanup };
};
