import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { contentDtoSchema, createMcpServer } from './server';
import {
  TEMPLATE_LIST_WIDGET_URI,
  WIDGET_MIME_TYPE,
} from './widgets/template-list';

// ─── createMcpServer 用モック ──────────────────────────────────────────────
jest.mock('./auth', () => ({
  authorize: jest.fn(),
  requestWithAuth: jest.fn(),
}));
jest.mock('./client', () => ({
  listDesigns: jest.fn(),
  getDesignParameters: jest.fn(),
  generatePdfSync: jest.fn(),
  generatePdfAsync: jest.fn(),
  generatePdfsSync: jest.fn(),
  generatePdfsAsync: jest.fn(),
  downloadFile: jest.fn(),
  downloadZip: jest.fn(),
}));
jest.mock('./roots/index', () => ({
  resolveDefaultOutputDir: jest.fn(),
  resolveAllowedRoots: jest.fn(),
}));
jest.mock('./sampling/request', () => ({
  requestSamplingText: jest.fn(),
}));
// withTelemetry でラップされたツール名を記録する (テレメトリ計上対象の検証用)
const mockTelemetryWrappedTools: string[] = [];
jest.mock('./telemetry/index', () => ({
  telemetryClientFromEnv: () => ({ emit: jest.fn() }),
  withTelemetry: (
    _tc: unknown,
    name: string,
    fn: (...args: unknown[]) => unknown,
  ) => {
    mockTelemetryWrappedTools.push(name);
    return (...args: unknown[]) => fn(...args);
  },
}));

// ─── ToolAnnotations テスト (WS2c / Anthropic Directory 提出要件) ──────────
describe('Tool annotations (WS2c)', () => {
  /**
   * createMcpServer を InMemoryTransport 経由で Client に接続し、
   * tools/list レスポンスのアノテーションを検証する。
   */
  const getTools = async (
    mode: 'stdio' | 'http' = 'stdio',
    enableWidgets = false,
  ) => {
    const server = createMcpServer({ mode, enableWidgets });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    await client.close();
    return tools;
  };

  const findTool = (
    tools: Awaited<ReturnType<typeof getTools>>,
    name: string,
  ) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    return tool!;
  };

  describe('stdio モード', () => {
    let tools: Awaited<ReturnType<typeof getTools>>;

    beforeAll(async () => {
      tools = await getTools('stdio');
    });

    it('authenticate: title と openWorldHint=true, destructiveHint=false', () => {
      const tool = findTool(tools, 'authenticate');
      expect(tool.annotations?.title).toBe('Authenticate with Re:port Flow');
      expect(tool.annotations?.openWorldHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    });

    it('get_design_parameters: readOnlyHint=true, idempotentHint=true', () => {
      const tool = findTool(tools, 'get_design_parameters');
      expect(tool.annotations?.title).toBe('Get Template Parameters');
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
    });

    it('list_templates: readOnlyHint=true, idempotentHint=true', () => {
      const tool = findTool(tools, 'list_templates');
      expect(tool.annotations?.title).toBe('List Re:port Flow Templates');
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
    });

    it('generate_pdf_sync: readOnlyHint=false, destructiveHint=false, idempotentHint=false', () => {
      const tool = findTool(tools, 'generate_pdf_sync');
      expect(tool.annotations?.title).toBe('Generate PDF (sync)');
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(false);
    });

    it('generate_pdf_async: readOnlyHint=false, destructiveHint=false, idempotentHint=false', () => {
      const tool = findTool(tools, 'generate_pdf_async');
      expect(tool.annotations?.title).toBe('Generate PDF (async)');
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(false);
    });

    it('generate_pdfs_sync: readOnlyHint=false, destructiveHint=false, idempotentHint=false', () => {
      const tool = findTool(tools, 'generate_pdfs_sync');
      expect(tool.annotations?.title).toBe('Generate Multiple PDFs (sync)');
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(false);
    });

    it('generate_pdfs_async: readOnlyHint=false, destructiveHint=false, idempotentHint=false', () => {
      const tool = findTool(tools, 'generate_pdfs_async');
      expect(tool.annotations?.title).toBe('Generate Multiple PDFs (async)');
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(false);
    });

    it('download_file: readOnlyHint=false (writes to disk), idempotentHint=true', () => {
      const tool = findTool(tools, 'download_file');
      expect(tool.annotations?.title).toBe('Download Generated File');
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
    });

    it('download_zip: readOnlyHint=false (writes to disk), idempotentHint=true', () => {
      const tool = findTool(tools, 'download_zip');
      expect(tool.annotations?.title).toBe('Download Batch ZIP');
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
    });

    it('suggest_params: readOnlyHint=true', () => {
      const tool = findTool(tools, 'suggest_params');
      expect(tool.annotations?.title).toBe('Suggest Parameters via Sampling');
      expect(tool.annotations?.readOnlyHint).toBe(true);
    });

    it('search: readOnlyHint=true, idempotentHint=true, openWorldHint=false (ChatGPT Apps 規約)', () => {
      const tool = findTool(tools, 'search');
      expect(tool.annotations?.title).toBe('Search Re:port Flow Templates');
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    });

    it('fetch: readOnlyHint=true, idempotentHint=true, openWorldHint=false (ChatGPT Apps 規約)', () => {
      const tool = findTool(tools, 'fetch');
      expect(tool.annotations?.title).toBe(
        'Fetch Re:port Flow Template Details',
      );
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    });

    it('search_gallery_templates: readOnlyHint=true, idempotentHint=true, openWorldHint=false (PRJ-3-1237)', () => {
      const tool = findTool(tools, 'search_gallery_templates');
      expect(tool.annotations?.title).toBe('Search Public Template Gallery');
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    });

    it('get_gallery_template: readOnlyHint=true, idempotentHint=true, openWorldHint=false (PRJ-3-1237)', () => {
      const tool = findTool(tools, 'get_gallery_template');
      expect(tool.annotations?.title).toBe(
        'Get Public Gallery Template Details',
      );
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    });

    it('copy_gallery_template: readOnlyHint=false, destructiveHint=false, idempotentHint=false (PRJ-3-1238)', () => {
      const tool = findTool(tools, 'copy_gallery_template');
      expect(tool.annotations?.title).toBe('Copy Gallery Template to Workspace');
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(false);
      expect(tool.annotations?.openWorldHint).toBe(false);
    });

    it('copy_gallery_template のスキーマにワークスペース指定の引数がない (PRJ-3-1238)', () => {
      // 複製先は JWT の workspace_id 固定。AI にワークスペース ID を
      // 推測・指定させる引数を公開しないことをスキーマで固定する
      const tool = findTool(tools, 'copy_gallery_template');
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> })
          .properties ?? {},
      );
      expect(properties).toEqual(['slug']);
    });

    it('ギャラリーツール 3 種は withTelemetry でラップされる (integration.mcp.invoked 計上対象)', () => {
      expect(mockTelemetryWrappedTools).toEqual(
        expect.arrayContaining([
          'search_gallery_templates',
          'get_gallery_template',
          'copy_gallery_template',
        ]),
      );
    });
  });

  describe('http モード', () => {
    let tools: Awaited<ReturnType<typeof getTools>>;

    beforeAll(async () => {
      tools = await getTools('http');
    });

    it('authenticate は http モードでは登録されない', () => {
      expect(tools.find((t) => t.name === 'authenticate')).toBeUndefined();
    });

    it('get_design_parameters: readOnlyHint=true, idempotentHint=true', () => {
      const tool = findTool(tools, 'get_design_parameters');
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
    });

    it('generate_pdf_sync: readOnlyHint=false, destructiveHint=false, idempotentHint=false', () => {
      const tool = findTool(tools, 'generate_pdf_sync');
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(false);
    });

    it('generate_pdfs_async: readOnlyHint=false, destructiveHint=false, idempotentHint=false', () => {
      const tool = findTool(tools, 'generate_pdfs_async');
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(false);
    });

    it('suggest_params: readOnlyHint=true', () => {
      const tool = findTool(tools, 'suggest_params');
      expect(tool.annotations?.readOnlyHint).toBe(true);
    });

    it('search / fetch は http モードでも登録される (ChatGPT Apps 経路)', () => {
      expect(tools.find((t) => t.name === 'search')).toBeDefined();
      expect(tools.find((t) => t.name === 'fetch')).toBeDefined();
    });

    it('widget 無効の http (claude.ai 経路) では search に _meta を付けない', () => {
      // enableWidgets を渡していない getTools('http') の結果。claude.ai 等の
      // 汎用クライアントには widget の outputTemplate を見せない。
      const tool = findTool(tools, 'search') as {
        _meta?: Record<string, unknown>;
      };
      expect(tool._meta?.['openai/outputTemplate']).toBeUndefined();
    });

    it('ギャラリーツール 3 種は http モードでも登録される (PRJ-3-1237 / PRJ-3-1238)', () => {
      const searchGallery = findTool(tools, 'search_gallery_templates');
      expect(searchGallery.annotations?.readOnlyHint).toBe(true);
      const getGallery = findTool(tools, 'get_gallery_template');
      expect(getGallery.annotations?.readOnlyHint).toBe(true);
      const copyGallery = findTool(tools, 'copy_gallery_template');
      expect(copyGallery.annotations?.readOnlyHint).toBe(false);
      expect(copyGallery.annotations?.destructiveHint).toBe(false);
    });
  });
});

// ─── Apps SDK widget (Phase 2 / PR-2) ──────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { listDesigns } = require('./client') as {
  listDesigns: jest.Mock;
};

describe('Apps SDK widget wiring (PR-2)', () => {
  // resources/list は design-parameters の ResourceTemplate 列挙で listDesigns を
  // 呼ぶため、空一覧を返すモックを与える (未設定だと undefined.designs で失敗する)。
  beforeEach(() => {
    listDesigns.mockResolvedValue({ designs: [] });
  });

  const connect = async (mode: 'stdio' | 'http', enableWidgets = false) => {
    const server = createMcpServer({ mode, enableWidgets });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return { client, close: () => client.close() };
  };

  it('http + widget 有効 (ChatGPT App 経路): ui:// widget リソースが読め search に _meta が付く', async () => {
    const { client, close } = await connect('http', true);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(TEMPLATE_LIST_WIDGET_URI);

    const read = await client.readResource({ uri: TEMPLATE_LIST_WIDGET_URI });
    const content = read.contents[0];
    expect(content.mimeType).toBe(WIDGET_MIME_TYPE);
    // SDK v2 では contents が text / blob variant の判別 union のため絞り込む。
    const html = 'text' in content ? String(content.text) : '';
    expect(html).toContain('reportflow-templates');
    // 防御的実装: 配列ガードと http(s) スキーム限定 (DOM-based XSS 対策) を含む
    expect(html).toContain('Array.isArray');
    expect(html).toContain('safeUrl');

    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'search') as {
      _meta?: Record<string, unknown>;
    };
    expect(search?._meta?.['openai/outputTemplate']).toBe(
      TEMPLATE_LIST_WIDGET_URI,
    );
    await close();
  });

  it('http + widget 無効 (claude.ai 経路): widget リソースも search の _meta も出さない', async () => {
    const { client, close } = await connect('http', false);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain(TEMPLATE_LIST_WIDGET_URI);

    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'search') as {
      _meta?: Record<string, unknown>;
    };
    expect(search?._meta?.['openai/outputTemplate']).toBeUndefined();
    await close();
  });

  it('stdio モード: widget リソースも search の _meta も登録されない', async () => {
    const { client, close } = await connect('stdio');
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain(TEMPLATE_LIST_WIDGET_URI);

    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'search') as {
      _meta?: Record<string, unknown>;
    };
    expect(search?._meta?.['openai/outputTemplate']).toBeUndefined();
    await close();
  });
});

describe('contentDtoSchema (PRJ-3-358)', () => {
  const baseValid = {
    fileName: 'invoice.pdf',
    params: { customerName: '山田太郎' },
  };

  describe('shareType (request)', () => {
    it.each(['01', '02', '03'] as const)(
      'accepts valid code value %s (developer-docs / content-service openapi)',
      (code) => {
        const result = contentDtoSchema.safeParse({
          ...baseValid,
          shareType: code,
        });
        expect(result.success).toBe(true);
      },
    );

    it("defaults to '01' when shareType is omitted", () => {
      const data = contentDtoSchema.parse(baseValid);
      expect(data.shareType).toBe('01');
    });

    it.each([
      'private',
      'public',
      'workspace',
      'invited',
      '04',
      '00',
      '',
    ] as const)('rejects out-of-spec value %s', (value) => {
      const result = contentDtoSchema.safeParse({
        ...baseValid,
        shareType: value,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('passthrough (PRJ-3-1008)', () => {
    it('accepts a record and preserves it verbatim after parse', () => {
      const passthrough = {
        orderId: 'ORD-001',
        retryCount: 3,
        nested: { source: 'crm' },
      };
      const data = contentDtoSchema.parse({ ...baseValid, passthrough });
      expect(data.passthrough).toEqual(passthrough);
    });

    it('is optional: parse without passthrough yields undefined', () => {
      const data = contentDtoSchema.parse(baseValid);
      expect(data.passthrough).toBeUndefined();
    });

    it.each([['string-value'], [42], [true], [['a', 'b']]])(
      'rejects non-record value %p',
      (value) => {
        const result = contentDtoSchema.safeParse({
          ...baseValid,
          passthrough: value,
        });
        expect(result.success).toBe(false);
      },
    );
  });
});
