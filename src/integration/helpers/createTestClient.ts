import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../../server';

export type TestClientHandle = {
  client: Client;
  cleanup: () => Promise<void>;
};

/**
 * InMemoryTransport で MCP Client / Server を接続する。
 * Server は createMcpServer({ mode: 'stdio' }) を使用。
 * cleanup() で client を閉じる。
 */
export const createTestClient = async (): Promise<TestClientHandle> => {
  const server = createMcpServer({ mode: 'stdio' });
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
