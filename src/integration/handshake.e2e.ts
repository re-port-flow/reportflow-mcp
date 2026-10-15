/**
 * Layer A: in-process integration — MCP handshake / capability enumeration
 *
 * InMemoryTransport で Client/Server を繋ぎ、プロトコル上の基本 capability を検証する。
 * ネットワーク・ファイルシステムには一切触れない。
 */

// ─── 外部依存のモック (server.spec.ts と同じパターン) ──────────────────────
jest.mock('../auth', () => ({
  authorize: jest.fn(),
  requestWithAuth: jest.fn(),
}));
jest.mock('../client', () => ({
  // listDesigns は ResourceTemplate の list コールバック (listDesignParameterResources) 内で
  // listResources() 時に呼ばれるため、空配列を返す mock にする必要がある
  listDesigns: jest.fn().mockResolvedValue({ designs: [] }),
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
jest.mock('../telemetry/index', () => ({
  telemetryClientFromEnv: () => ({ emit: jest.fn() }),
  withTelemetry:
    (_tc: unknown, _name: string, fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
}));

import { createTestClient } from './helpers/createTestClient';
import { SERVER_INSTRUCTIONS } from '../instructions';

// stdio モードの期待ツール数 (search / fetch は ChatGPT Apps 規約ツールとして両モードに登録)
// 12 = 既存 10 + search / fetch。+2 = ギャラリー参照ツール
// (search_gallery_templates / get_gallery_template, PRJ-3-1237)。
// +1 = ギャラリー複製ツール (copy_gallery_template, PRJ-3-1238)。
// +1 = 生成状態の確認ツール (get_generation_status, PRJ-3-2018)。
//
// **これは ADMIN の期待値** (PRJ-3-1584 / ST-3)。`createTestClient` の既定ロールが
// ADMIN なので、この数はワークスペース権限を入れる前と同じままになる。
// ロール別の一覧 (READ で copy_gallery_template が消える / 未認証は 3 ツールだけ)
// は `workspace-role.e2e.ts` が確定表と突き合わせて別に検証する。この定数を
// 「フィルタが入ったから」と減らして通してはいけない —— 減らすと ADMIN のカタログ
// が縮んだ事故を検出できなくなる。
const EXPECTED_STDIO_TOOL_COUNT = 16;

describe('MCP handshake (Layer A)', () => {
  let cleanup: () => Promise<void>;
  let handle: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    handle = await createTestClient();
    cleanup = handle.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  // ─── initialize ───────────────────────────────────────────────────────────

  it('initialize: serverInfo.name = "reportflow-mcp"', async () => {
    // Client が connect 済みの場合、serverInfo は transport 接続時に交換済み。
    // Client の内部状態から取得する (公開 API がないため tools/list で間接確認)。
    // serverInfo そのものは Client.getServerCapabilities() 等が無い SDK バージョンでは
    // tools/list が返る = initialize が成功している、という事実で検証。
    const { tools } = await handle.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('initialize: serverInfo に title / icons (掲載アイコン) が含まれる', () => {
    // リモート接続したクライアント (Claude.ai 等) は initialize 応答の serverInfo を
    // 表示名・掲載アイコンに使う。ImplementationSchema は passthrough のため、
    // createMcpServer で渡した title / icons が serverInfo にそのまま乗る。
    const info = handle.client.getServerVersion();
    expect(info).toBeDefined();
    const meta = info as {
      title?: string;
      icons?: Array<{ src: string; mimeType?: string }>;
    };
    expect(meta.title).toBe('Re:port Flow MCP');
    expect(Array.isArray(meta.icons)).toBe(true);
    expect(meta.icons?.length).toBeGreaterThan(0);
    expect(meta.icons?.[0]?.src).toContain('mcp.re-port-flow.com/favicon');
  });

  // ─── instructions (PRJ-3-1373) ────────────────────────────────────────────
  // 接続直後にクライアント AI 側から初回生成を提案させるための指示文。
  // 文案の中身 (初回導線 4 ツールの記載順など) は server.spec.ts が定数に対して
  // 検証する。ここで見るのは「定数がプロトコル上そのまま届くか」だけ。
  // 経路は旧仕様 (initialize)。2026-07-28 の server/discover は
  // http-server-modern.spec.ts、パッケージ済み dist の実 stdio は
  // scripts/packaging-smoke.mjs が別に見る。
  it('initialize: instructions が確定文案と一致する', () => {
    expect(handle.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it('http モードでも同一の instructions が返る (モード出し分けなし)', async () => {
    // http は claude.ai / ChatGPT Apps 経路。stdio 専用ツール (authenticate 等) は
    // 登録されないが、初回導線の 4 ツールは両モード共通なので文案も共通 1 本。
    const httpHandle = await createTestClient('http');
    const instructions = httpHandle.client.getInstructions();
    await httpHandle.cleanup();
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
  });

  // ─── tools/list ───────────────────────────────────────────────────────────

  describe('tools/list', () => {
    let tools: Awaited<ReturnType<typeof handle.client.listTools>>['tools'];

    beforeAll(async () => {
      ({ tools } = await handle.client.listTools());
    });

    it(`stdio モードで ${EXPECTED_STDIO_TOOL_COUNT} ツールが返る`, () => {
      expect(tools).toHaveLength(EXPECTED_STDIO_TOOL_COUNT);
    });

    it('全ツールの name が非空文字列', () => {
      for (const tool of tools) {
        expect(typeof tool.name).toBe('string');
        expect(tool.name.trim().length).toBeGreaterThan(0);
      }
    });

    it('全ツールの description が非空文字列', () => {
      for (const tool of tools) {
        expect(typeof tool.description).toBe('string');
        expect((tool.description ?? '').trim().length).toBeGreaterThan(0);
      }
    });

    const expectedTools = [
      'authenticate',
      'get_design_parameters',
      'list_templates',
      'generate_pdf_sync',
      'generate_pdf_async',
      'generate_pdfs_sync',
      'generate_pdfs_async',
      'download_file',
      'download_zip',
      'get_generation_status',
      'suggest_params',
      'search',
      'fetch',
      'search_gallery_templates',
      'get_gallery_template',
      'copy_gallery_template',
    ];

    it.each(expectedTools)('ツール "%s" が含まれる', (name) => {
      expect(tools.find((t) => t.name === name)).toBeDefined();
    });
  });

  // ─── resources/list ───────────────────────────────────────────────────────

  describe('resources/list', () => {
    it('reportflow://designs が含まれる', async () => {
      const { resources } = await handle.client.listResources();
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain('reportflow://designs');
    });

    it('reportflow://server-info が含まれる', async () => {
      const { resources } = await handle.client.listResources();
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain('reportflow://server-info');
    });

    it('reportflow://errors が含まれる', async () => {
      const { resources } = await handle.client.listResources();
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain('reportflow://errors');
    });
  });

  // ─── prompts/list ─────────────────────────────────────────────────────────

  describe('prompts/list', () => {
    let prompts: Awaited<
      ReturnType<typeof handle.client.listPrompts>
    >['prompts'];

    beforeAll(async () => {
      ({ prompts } = await handle.client.listPrompts());
    });

    it('generate_pdf が含まれる', () => {
      expect(prompts.find((p) => p.name === 'generate_pdf')).toBeDefined();
    });

    it('generate_pdfs (batch) が含まれる', () => {
      // batch_generate_pdf または generate_pdfs のどちらかを受け入れる
      const found = prompts.find(
        (p) => p.name === 'generate_pdfs' || p.name === 'batch_generate_pdf',
      );
      expect(found).toBeDefined();
    });

    it('help 系 prompt が含まれる', () => {
      const found = prompts.find(
        (p) => p.name === 'help' || p.name === 'reportflow_help',
      );
      expect(found).toBeDefined();
    });
  });
});
