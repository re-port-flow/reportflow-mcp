/**
 * Layer A: in-process integration — resources/read validation
 *
 * MCP の resources/read で server://info, server://errors, designs://list の
 * コンテンツが正しく返ることを検証する。
 */

// ─── 外部依存のモック ────────────────────────────────────────────────────────
jest.mock('../auth', () => ({
  authorize: jest.fn(),
  requestWithAuth: jest
    .fn()
    .mockImplementation(
      (fn: (headers: Record<string, string>) => Promise<unknown>) =>
        fn({ Authorization: 'Bearer dummy-token' }),
    ),
}));
jest.mock('../roots/index', () => ({
  resolveDefaultOutputDir: jest.fn(),
  resolveAllowedRoots: jest.fn().mockResolvedValue([]),
}));
jest.mock('../sampling/request', () => ({
  requestSamplingText: jest.fn(),
}));
jest.mock('../telemetry/index', () => ({
  telemetryClientFromEnv: () => ({ emit: jest.fn() }),
  withTelemetry:
    (_tc: unknown, _name: string, fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
}));

import { createTestClient, TestClientHandle } from './helpers/createTestClient';

type FetchMockFn = jest.MockedFunction<typeof global.fetch>;

// SDK v2 では resources/read の contents が text / blob variant の判別 union に
// なったため、text variant を型安全に取り出す (blob variant なら空文字)。
const textOf = (content: { uri: string }): string =>
  'text' in content ? String((content as { text?: unknown }).text ?? '') : '';

// Fix 2: global.fetch を直接代入した場合 jest.restoreAllMocks() では復元できない。
// originalFetch を保持して afterEach で確実に復元する。
const originalFetch = global.fetch;

describe('resources/read (Layer A)', () => {
  let handle: TestClientHandle;

  beforeAll(async () => {
    handle = await createTestClient();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ─── reportflow://server-info ────────────────────────────────────────────

  describe('reportflow://server-info', () => {
    it('content が JSON で返り name と version を含む', async () => {
      const result = await handle.client.readResource({
        uri: 'reportflow://server-info',
      });

      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.mimeType).toBe('application/json');

      const parsed = JSON.parse(textOf(content)) as {
        name: string;
        version: string;
        capabilities: unknown;
      };
      expect(parsed.name).toBe('reportflow-mcp');
      expect(typeof parsed.version).toBe('string');
      expect(parsed.capabilities).toBeDefined();
    });
  });

  // ─── reportflow://errors ──────────────────────────────────────────────────

  describe('reportflow://errors', () => {
    it('エラーカタログ JSON が返る (AUTH / DESIGN / JOB / FILE カテゴリを含む)', async () => {
      const result = await handle.client.readResource({
        uri: 'reportflow://errors',
      });

      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.mimeType).toBe('application/json');

      const parsed = JSON.parse(textOf(content)) as {
        AUTH?: unknown;
        DESIGN?: unknown;
        JOB?: unknown;
        FILE?: unknown;
      };
      expect(parsed.AUTH).toBeDefined();
      expect(parsed.DESIGN).toBeDefined();
      expect(parsed.JOB).toBeDefined();
      expect(parsed.FILE).toBeDefined();
    });
  });

  // ─── reportflow://designs ─────────────────────────────────────────────────

  describe('reportflow://designs', () => {
    it('fetch mock を立てるとデザイン一覧が返る', async () => {
      const fetchMock = jest.fn() as FetchMockFn;
      global.fetch = fetchMock;

      const mockDesigns = {
        designs: [
          {
            id: 'design-resource-001',
            label: 'リソーステスト用テンプレート',
            latestVersion: 1,
            thumbnail: 'https://example.com/thumb.png',
            updatedAt: '2024-06-01T00:00:00Z',
          },
        ],
      };
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockDesigns), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const result = await handle.client.readResource({
        uri: 'reportflow://designs',
      });

      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      const parsed = JSON.parse(textOf(content)) as {
        designs: Array<{ id: string; label: string }>;
      };
      expect(parsed.designs).toHaveLength(1);
      expect(parsed.designs[0].id).toBe('design-resource-001');
      expect(parsed.designs[0].label).toBe('リソーステスト用テンプレート');
    });
  });
});
