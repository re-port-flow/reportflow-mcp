/**
 * Layer A: in-process integration — tools/call with mocked fetch
 *
 * global.fetch を Jest mock で差し替え、実際の HTTP 通信なしにツール呼び出しを検証する。
 * auth は token-store の file ストアに dummy token を inject して通過させる。
 */

// ─── 外部依存のモック ────────────────────────────────────────────────────────
jest.mock('../auth', () => ({
  authorize: jest.fn(),
  requestWithAuth: jest.fn().mockImplementation(
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
// Fix 1: jest.mock はトップレベルに配置しないと Jest のホイスト処理が適用されない。
// generate_pdf_sync が saveTempFile を呼ぶため、実ファイル書き込みを回避するためにモック。
jest.mock('../file-helper', () => ({
  saveTempFile: jest.fn().mockResolvedValue('/tmp/invoice.pdf'),
}));

// client モジュールは mock しない — fetch を差し替えることで実際の HTTP 呼び出しを
// intercept し、client → http → fetch の経路を通すことで統合動作を確認する。
// (server.spec.ts は client をまとめてモックしているが、ここでは fetch レベルで制御する)

import { createTestClient, TestClientHandle } from './helpers/createTestClient';

// ─── fetch mock helper ────────────────────────────────────────────────────────

type FetchMockFn = jest.MockedFunction<typeof global.fetch>;

const mockFetchJson = (fetchMock: FetchMockFn, body: unknown, status = 200) => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
};

// ─── テストスイート ───────────────────────────────────────────────────────────

describe('tools/call with mocked fetch (Layer A)', () => {
  let handle: TestClientHandle;
  let fetchMock: FetchMockFn;

  beforeAll(async () => {
    handle = await createTestClient();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(() => {
    fetchMock = jest.fn() as FetchMockFn;
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── list_templates ──────────────────────────────────────────────────────

  describe('list_templates', () => {
    it('fetch が返したデザイン一覧が tools/call のレスポンスに含まれる', async () => {
      const mockDesigns = {
        designs: [
          {
            id: 'design-uuid-001',
            label: 'テスト請求書',
            latestVersion: 3,
            thumbnail: 'https://example.com/thumb.png',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
      };
      mockFetchJson(fetchMock, mockDesigns);

      const result = await handle.client.callTool({
        name: 'list_templates',
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      expect(text).toContain('テスト請求書');
      expect(text).toContain('design-uuid-001');
    });
  });

  // ─── get_design_parameters ───────────────────────────────────────────────

  describe('get_design_parameters', () => {
    it('designId を渡すと fetch が呼ばれ mock 結果が返る', async () => {
      const mockParams = {
        customerName: 'string',
        amount: 'number',
        items: [{ name: 'string', quantity: 'number', price: 'number' }],
      };
      mockFetchJson(fetchMock, mockParams);

      const result = await handle.client.callTool({
        name: 'get_design_parameters',
        arguments: { designId: 'design-uuid-001', version: 1 },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      expect(text).toContain('customerName');
    });
  });

  // ─── generate_pdf_sync ───────────────────────────────────────────────────

  describe('generate_pdf_sync', () => {
    it('params を渡して fileUrl が返る', async () => {
      // generate_pdf_sync は fetchBinaryWithHeaders を呼ぶため、
      // headers 付きの Response を返す必要がある
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
      const headers = new Headers({
        'Content-Type': 'application/pdf',
        'File-URL': 'https://api.re-port-flow.com/v1/file/download/req-001',
        'Request-Id': 'req-001',
        'X-File-Mapping': encodeURIComponent(
          JSON.stringify([{ fileId: 'file-001', fileName: 'invoice.pdf' }]),
        ),
      });
      fetchMock.mockResolvedValueOnce(
        new Response(pdfBytes.buffer, { status: 200, headers }),
      );

      const result = await handle.client.callTool({
        name: 'generate_pdf_sync',
        arguments: {
          designId: 'design-uuid-001',
          version: 1,
          content: {
            fileName: 'invoice.pdf',
            params: { customerName: '山田太郎' },
          },
        },
      });

      // エラーでなければ OK (fileUrl または filePath が返る)
      expect(result.isError).toBeFalsy();

      // saveTempFile がトップレベル mock 経由で呼ばれたことを検証
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { saveTempFile } = require('../file-helper') as {
        saveTempFile: jest.MockedFunction<
          (data: ArrayBuffer, fileName: string, outputDir?: string, allowedRoots?: string[]) => Promise<string>
        >;
      };
      expect(saveTempFile).toHaveBeenCalledTimes(1);
      // 第1引数は ArrayBuffer (Jest では [] と表示されるが型は正しい)
      // outputDir は server.ts から resolveDefaultOutputDir 経由で渡るが
      // roots mock が undefined を返す場合は undefined になりうる
      expect(saveTempFile).toHaveBeenCalledWith(
        expect.any(ArrayBuffer),
        'invoice.pdf',
        undefined,          // outputDir (roots mock は resolveDefaultOutputDir を jest.fn() で未設定)
        expect.any(Array),  // allowedRoots
      );
    });
  });
});
