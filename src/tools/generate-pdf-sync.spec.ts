import * as fileHelper from '../file-helper';
import { getAuthWorkspaceId } from '../auth';
import { handleGeneratePdfSync } from './generate-pdf-sync';

jest.mock('../auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ Authorization: 'Bearer test-token' }),
  ),
  // 使用量取得 (workspace-usage.ts) は requestWithAuth を通さず直接ヘッダーを取る
  getAuthHeaders: jest
    .fn()
    .mockResolvedValue({ Authorization: 'Bearer test-token' }),
  getAuthWorkspaceId: jest.fn(),
}));
jest.mock('../file-helper');

const mockedFileHelper = fileHelper as jest.Mocked<typeof fileHelper>;
const mockedGetAuthWorkspaceId = getAuthWorkspaceId as jest.MockedFunction<
  typeof getAuthWorkspaceId
>;
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Tight ArrayBuffer (Buffer.from の pool-allocated 戻り値は他バイトが混ざるので避ける)
const PDF_PAYLOAD = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
]);
const PDF_ARRAY_BUFFER: ArrayBuffer = PDF_PAYLOAD.buffer.slice(
  PDF_PAYLOAD.byteOffset,
  PDF_PAYLOAD.byteOffset + PDF_PAYLOAD.byteLength,
);

// File-URL は Web アプリの出力履歴画面 (直接ダウンロード URL ではない)
const DEFAULT_FILE_URL =
  'https://re-port-flow.com/ws-1/templates/design-uuid-1/outputs?requestId=req-uuid-1';
const DEFAULT_REQUEST_ID = 'req-uuid-1';
const DEFAULT_FILE_MAPPING = encodeURIComponent(
  JSON.stringify([{ fileId: 'file-uuid-1', fileName: 'invoice.pdf' }]),
);

function mockBinaryResponse(
  buffer: ArrayBuffer = PDF_ARRAY_BUFFER,
  status = 200,
  responseHeaders: Record<string, string> = {
    'File-URL': DEFAULT_FILE_URL,
    'Request-Id': DEFAULT_REQUEST_ID,
    'X-File-Mapping': DEFAULT_FILE_MAPPING,
  },
) {
  mockFetch.mockResolvedValue({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(buffer),
    headers: new Headers(responseHeaders),
  });
}

/**
 * 生成 (binary) → 使用量 (JSON) の 2 リクエストを順に返す。
 * 使用量側の挙動 (成功 / 失敗) を差し替えて「生成を壊さない」ことを検証する。
 */
function mockGenerateThenUsage(usage: { ok: true; body: unknown } | Error) {
  mockFetch.mockReset();
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(PDF_ARRAY_BUFFER),
    headers: new Headers({
      'File-URL': DEFAULT_FILE_URL,
      'Request-Id': DEFAULT_REQUEST_ID,
      'X-File-Mapping': DEFAULT_FILE_MAPPING,
    }),
  });
  if (usage instanceof Error) {
    mockFetch.mockRejectedValueOnce(usage);
  } else {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(usage.body),
    });
  }
}

describe('handleGeneratePdfSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/invoice.pdf');
    // 既定は「ワークスペース未解決」= plan ブロック無し。plan を見るテストで上書きする。
    mockedGetAuthWorkspaceId.mockResolvedValue(undefined);
  });

  const input = {
    designId: 'design-uuid-1',
    version: 1,
    content: {
      fileName: 'invoice.pdf',
      params: { name: '山田太郎', amount: 10000 },
    },
  };

  type ContentItem = { type: 'text'; text: string };

  const findText = (items: ContentItem[]) =>
    items.find((c): c is { type: 'text'; text: string } => c.type === 'text');

  /**
   * text content は「人間向けサマリ\n\n<JSON>」形式。
   * サマリ部と JSON 部をパースして返す。
   */
  const parseTextContent = (
    raw: string,
  ): { summary: string; data: Record<string, unknown> } => {
    const idx = raw.indexOf('\n\n{');
    if (idx === -1) return { summary: raw, data: {} };
    return {
      summary: raw.slice(0, idx),
      data: JSON.parse(raw.slice(idx + 2)) as Record<string, unknown>,
    };
  };

  describe('stdio モード (default)', () => {
    it('人間向けサマリ + JSON + 保存パスを返す (text content のみ)', async () => {
      mockBinaryResponse();

      const result = await handleGeneratePdfSync(input);

      expect(result.isError).toBeUndefined();
      expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(
        expect.any(ArrayBuffer),
        'invoice.pdf',
        undefined,
        [],
      );

      // PDF の base64 blob は返さない: content は text のみ
      expect(result.content).toHaveLength(1);
      const text = findText(result.content as ContentItem[]);
      expect(text).toBeDefined();
      const { summary, data } = parseTextContent(text!.text);
      // 仕様変更（情報設計 用語統一 2026-09）
      expect(summary).toContain('PDF出力完了');
      expect(summary).toContain('/tmp/invoice.pdf');
      expect(summary).toContain(DEFAULT_FILE_URL);
      expect(data.filePath).toBe('/tmp/invoice.pdf');
      expect(data.fileUrl).toBe(DEFAULT_FILE_URL);
      expect(data.requestId).toBe(DEFAULT_REQUEST_ID);
      expect(data.fileId).toBe('file-uuid-1');
    });

    it('passthrough を含む content をそのまま REST body に透過する (PRJ-3-1008)', async () => {
      mockBinaryResponse();
      const passthrough = { orderId: 'ORD-001', retryCount: 3 };

      await handleGeneratePdfSync({
        ...input,
        content: { ...input.content, passthrough },
      });

      const [, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(requestInit.body as string) as {
        content: Record<string, unknown>;
      };
      expect(body.content.passthrough).toEqual(passthrough);
    });

    it('resolveOutputDir をフォールバックで使う', async () => {
      mockBinaryResponse();
      mockedFileHelper.saveTempFile.mockResolvedValue('/roots/invoice.pdf');

      await handleGeneratePdfSync(input, {
        mode: 'stdio',
        resolveOutputDir: async () => '/roots',
      });

      expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(
        expect.any(ArrayBuffer),
        'invoice.pdf',
        '/roots',
        [],
      );
    });

    it('明示 outputDir 指定時は resolveAllowedRoots を呼び結果を saveTempFile に渡す (PRJ-3-485 wiring)', async () => {
      mockBinaryResponse();
      mockedFileHelper.saveTempFile.mockResolvedValue(
        '/home/user/workspace/invoice.pdf',
      );
      const resolveAllowedRoots = jest
        .fn<Promise<string[]>, []>()
        .mockResolvedValue(['/home/user/workspace']);

      await handleGeneratePdfSync(
        { ...input, outputDir: '/home/user/workspace' },
        {
          mode: 'stdio',
          resolveOutputDir: async () => '/should-be-overridden',
          resolveAllowedRoots,
        },
      );

      expect(resolveAllowedRoots).toHaveBeenCalledTimes(1);
      expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(
        expect.any(ArrayBuffer),
        'invoice.pdf',
        '/home/user/workspace',
        ['/home/user/workspace'],
      );
    });

    it('outputDir 未指定時は resolveAllowedRoots を呼ばない (検証対象が無い)', async () => {
      mockBinaryResponse();
      const resolveAllowedRoots = jest
        .fn<Promise<string[]>, []>()
        .mockResolvedValue(['/roots']);

      await handleGeneratePdfSync(input, {
        mode: 'stdio',
        resolveOutputDir: async () => '/roots',
        resolveAllowedRoots,
      });

      expect(resolveAllowedRoots).not.toHaveBeenCalled();
    });
  });

  describe('HTTP モード', () => {
    it('saveTempFile を呼ばず人間向けサマリ + fileUrl JSON を返す (text content のみ)', async () => {
      mockBinaryResponse();

      const result = await handleGeneratePdfSync(input, { mode: 'http' });

      expect(result.isError).toBeUndefined();
      expect(mockedFileHelper.saveTempFile).not.toHaveBeenCalled();

      // PDF の base64 blob は返さない: content は text のみ
      expect(result.content).toHaveLength(1);
      const text = findText(result.content as ContentItem[]);
      expect(text).toBeDefined();
      const { summary, data } = parseTextContent(text!.text);
      // 仕様変更（情報設計 用語統一 2026-09）
      expect(summary).toContain('PDF出力完了');
      expect(summary).toContain(DEFAULT_FILE_URL);
      expect(data.filePath).toBeUndefined();
      expect(data.fileUrl).toBe(DEFAULT_FILE_URL);
      expect(data.requestId).toBe(DEFAULT_REQUEST_ID);
      expect(data.fileId).toBe('file-uuid-1');
    });

    it('PDF 本文 (arrayBuffer) をバッファせず body を cancel する (headers-only)', async () => {
      const arrayBufferSpy = jest.fn(() => Promise.resolve(PDF_ARRAY_BUFFER));
      const cancelSpy = jest.fn(() => Promise.resolve());
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({}),
        arrayBuffer: arrayBufferSpy,
        body: { cancel: cancelSpy },
        headers: new Headers({
          'File-URL': DEFAULT_FILE_URL,
          'Request-Id': DEFAULT_REQUEST_ID,
          'X-File-Mapping': DEFAULT_FILE_MAPPING,
        }),
      });

      const result = await handleGeneratePdfSync(input, { mode: 'http' });

      expect(result.isError).toBeUndefined();
      // 本文はダウンロードしない
      expect(arrayBufferSpy).not.toHaveBeenCalled();
      // ストリームは明示的に破棄する
      expect(cancelSpy).toHaveBeenCalledTimes(1);

      const text = findText(result.content as ContentItem[]);
      const { data } = parseTextContent(text!.text);
      expect(data.fileUrl).toBe(DEFAULT_FILE_URL);
    });

    it('sync エンドポイントが File-URL ヘッダを返さなくても text は返す (summary のみ)', async () => {
      mockBinaryResponse(PDF_ARRAY_BUFFER, 200, {});

      const result = await handleGeneratePdfSync(input, { mode: 'http' });

      expect(result.isError).toBeUndefined();
      const text = findText(result.content as ContentItem[]);
      expect(text).toBeDefined();
      // 仕様変更（情報設計 用語統一 2026-09）
      expect(text!.text).toContain('PDF出力完了');
    });

    it('outputDir が入力にあっても無視する', async () => {
      mockBinaryResponse();

      const result = await handleGeneratePdfSync(
        { ...input, outputDir: '/ignored' },
        { mode: 'http' },
      );

      expect(result.isError).toBeUndefined();
      expect(mockedFileHelper.saveTempFile).not.toHaveBeenCalled();
    });
  });

  describe('plan / 使用量 (PRJ-3-1375)', () => {
    it('無料プランなら plan ブロックとアップグレード URL を JSON に足す', async () => {
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockGenerateThenUsage({
        ok: true,
        body: {
          used: 8,
          limit: 10,
          remaining: 2,
          percentage: 80,
          planName: 'FREE',
          planType: '01',
        },
      });

      const result = await handleGeneratePdfSync(input);

      expect(result.isError).toBeUndefined();
      const { data } = parseTextContent(
        findText(result.content as ContentItem[])!.text,
      );
      // 生成結果は従来どおり
      expect(data.filePath).toBe('/tmp/invoice.pdf');
      expect(data.plan).toMatchObject({
        planName: 'FREE',
        monthlyUsedPages: 8,
        monthlyLimitPages: 10,
        upgradeUrl: 'http://localhost:3000/ws-1/plan',
      });
    });

    it('同期ツールは「今回ぶん未計上」の断りを付けない (記録後に問い合わせるため)', async () => {
      // content-service の sync は _postFileGeneration を await してから応答する
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockGenerateThenUsage({
        ok: true,
        body: {
          used: 8,
          limit: 10,
          remaining: 2,
          percentage: 80,
          planName: 'FREE',
          planType: '01',
        },
      });

      const result = await handleGeneratePdfSync(input);

      const { data } = parseTextContent(
        findText(result.content as ContentItem[])!.text,
      );
      const plan = data.plan as Record<string, unknown>;
      expect(plan.excludesPendingJob).toBeUndefined();
      expect(plan.message as string).not.toContain('まだ含まれていません');
    });

    it('有料プランには URL を出さず使用量の事実だけを足す', async () => {
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockGenerateThenUsage({
        ok: true,
        body: {
          used: 120,
          limit: 1000,
          remaining: 880,
          percentage: 12,
          planName: 'STANDARD',
          planType: '02',
        },
      });

      const result = await handleGeneratePdfSync(input);

      const { data } = parseTextContent(
        findText(result.content as ContentItem[])!.text,
      );
      const plan = data.plan as Record<string, unknown>;
      expect(plan.upgradeUrl).toBeUndefined();
      expect(plan.monthlyUsedPages).toBe(120);
    });

    it('無制限プラン (limit=null) では上限を書かない', async () => {
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockGenerateThenUsage({
        ok: true,
        body: {
          used: 300,
          limit: null,
          remaining: null,
          percentage: 0,
          planName: 'PREMIUM',
          planType: '03',
        },
      });

      const result = await handleGeneratePdfSync(input);

      const { data } = parseTextContent(
        findText(result.content as ContentItem[])!.text,
      );
      const plan = data.plan as Record<string, unknown>;
      expect(plan.monthlyLimitPages).toBeUndefined();
      expect(plan.message as string).not.toMatch(/上限 \d/);
    });

    it('使用量取得が失敗しても PDF 生成の結果は必ず返す (plan は省く)', async () => {
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockGenerateThenUsage(new Error('Request timed out after 5000ms'));

      const result = await handleGeneratePdfSync(input);

      expect(result.isError).toBeUndefined();
      const { summary, data } = parseTextContent(
        findText(result.content as ContentItem[])!.text,
      );
      // 仕様変更（情報設計 用語統一 2026-09）
      expect(summary).toContain('PDF出力完了');
      expect(data.filePath).toBe('/tmp/invoice.pdf');
      expect(data.fileUrl).toBe(DEFAULT_FILE_URL);
      expect(data.plan).toBeUndefined();
    });

    it('使用量が HTTP エラーでも PDF 生成の結果は返す', async () => {
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({}),
        arrayBuffer: () => Promise.resolve(PDF_ARRAY_BUFFER),
        headers: new Headers({ 'File-URL': DEFAULT_FILE_URL }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: () => Promise.resolve({ message: 'insufficient scope' }),
      });

      const result = await handleGeneratePdfSync(input);

      expect(result.isError).toBeUndefined();
      const { data } = parseTextContent(
        findText(result.content as ContentItem[])!.text,
      );
      expect(data.fileUrl).toBe(DEFAULT_FILE_URL);
      expect(data.plan).toBeUndefined();
    });

    it('生成が失敗したときは使用量を問い合わせない', async () => {
      mockedGetAuthWorkspaceId.mockResolvedValue('ws-1');
      mockFetch.mockReset();
      mockFetch.mockRejectedValue(new Error('Server Error'));

      const result = await handleGeneratePdfSync(input);

      expect(result.isError).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('エラー系', () => {
    it('API エラー時に isError=true で対処方法を含むテキスト', async () => {
      mockFetch.mockRejectedValue(new Error('Server Error'));

      const result = await handleGeneratePdfSync(input);

      expect(result.isError).toBe(true);
      const text = findText(result.content as ContentItem[]);
      // 仕様変更（情報設計 用語統一 2026-09）
      expect(text!.text).toContain('PDFの出力に失敗しました');
      expect(text!.text).toContain('Server Error');
      // 対処ヒントが含まれる
      expect(text!.text).toContain('対処');
    });

    // PRJ-3-2016: 時間切れは入力の誤りではない。照合を促すと LLM は入力を直すか
    // 同じ呼び出しを繰り返し、ページを二重に消費しうる。
    it('504 (60 秒の時間切れ) では入力の照合ではなく async への切り替えを案内する', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 504,
        statusText: 'Gateway Timeout',
        json: () => Promise.reject(new Error('not json')),
      });

      const result = await handleGeneratePdfSync(input);

      expect(result.isError).toBe(true);
      const text = findText(result.content as ContentItem[])!.text;
      expect(text).toContain('PDFの出力に失敗しました');
      expect(text).toContain('[504]');
      expect(text).toContain('タイムアウト');
      expect(text).toContain('generate_pdfs_async');
      expect(text).not.toContain('照合');
    });

    it('504 以外の API エラーは従来どおり入力の照合を案内する', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('not json')),
      });

      const result = await handleGeneratePdfSync(input);

      const text = findText(result.content as ContentItem[])!.text;
      expect(text).toContain('照合');
      expect(text).not.toContain('generate_pdfs_async');
    });
  });
});
