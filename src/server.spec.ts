import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { contentDtoSchema, createMcpServer } from './server';

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
jest.mock('./telemetry/index', () => ({
  telemetryClientFromEnv: () => ({ emit: jest.fn() }),
  withTelemetry:
    (_tc: unknown, _name: string, fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
}));

// ─── ToolAnnotations テスト (WS2c / Anthropic Directory 提出要件) ──────────
describe('Tool annotations (WS2c)', () => {
  /**
   * createMcpServer を InMemoryTransport 経由で Client に接続し、
   * tools/list レスポンスのアノテーションを検証する。
   */
  const getTools = async (mode: 'stdio' | 'http' = 'stdio') => {
    const server = createMcpServer({ mode });
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
      expect(tool.annotations?.title).toBe('Authenticate with ReportFlow');
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
      expect(tool.annotations?.title).toBe('List ReportFlow Templates');
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
});
