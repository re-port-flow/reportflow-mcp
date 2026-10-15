import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../server';
import { adminAuthorizationOptions } from '../integration/helpers/createTestClient';
import { A2A_SKILLS } from './skills';

jest.mock('../telemetry/index', () => ({
  telemetryClientFromEnv: () => ({ emit: jest.fn() }),
  withTelemetry: (
    _tc: unknown,
    _name: string,
    fn: (...args: unknown[]) => unknown,
  ) => fn,
}));

/**
 * A2A の skill id は MCP ツール名そのもの (skills.ts)。HTTP モードに存在しない
 * ツール名をカードに載せると「広告しているのに呼ぶと必ず失敗する skill」になる。
 * ADMIN (= 全ツールが見えるロール) の HTTP モードで実際に登録されるツールと突き合わせる。
 */
describe('A2A_SKILLS', () => {
  it('すべての skill id が HTTP モードで登録される MCP ツール名である', async () => {
    const server = createMcpServer({
      mode: 'http',
      ...adminAuthorizationOptions(),
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    await client.close();

    const toolNames = new Set(tools.map((t) => t.name));
    const missing = A2A_SKILLS.map((s) => s.id).filter(
      (id) => !toolNames.has(id),
    );
    expect(missing).toEqual([]);

    // 機械可読の呼び出し例 (JSON) は、そのツールの必須引数を全部持つこと。
    // 例どおりに送ると必ず失敗する、を防ぐ (generate_pdf_sync の version 欠落で実際に起きた)。
    const requiredByTool = new Map(
      tools.map((t) => [t.name, t.inputSchema.required ?? []]),
    );
    const incomplete: string[] = [];
    for (const skill of A2A_SKILLS) {
      for (const example of skill.examples) {
        if (!example.startsWith('{')) continue;
        const parsed = JSON.parse(example) as {
          skill: string;
          arguments: Record<string, unknown>;
        };
        expect(parsed.skill).toBe(skill.id);
        for (const key of requiredByTool.get(skill.id) ?? []) {
          if (!(key in parsed.arguments)) incomplete.push(`${skill.id}.${key}`);
        }
      }
    }
    expect(incomplete).toEqual([]);
  });

  it('skill id は重複しない', () => {
    const ids = A2A_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('非同期の一括生成を公開するなら、その結果を確かめる get_generation_status も公開する', () => {
    const ids = new Set(A2A_SKILLS.map((s) => s.id));
    expect(ids.has('generate_pdfs_async')).toBe(true);
    expect(ids.has('get_generation_status')).toBe(true);
  });
});
