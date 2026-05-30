import * as fileHelper from '../file-helper';
import { handleGeneratePdfSync } from './generate-pdf-sync';

jest.mock('../auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ Authorization: 'Bearer test-token' }),
  ),
}));
jest.mock('../file-helper');

const mockedFileHelper = fileHelper as jest.Mocked<typeof fileHelper>;
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
const PDF_BASE64 = Buffer.from(PDF_PAYLOAD).toString('base64');

const DEFAULT_FILE_URL =
  'https://api.re-port-flow.com/v1/file/download/req-uuid-1';
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

describe('handleGeneratePdfSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/invoice.pdf');
  });

  const input = {
    designId: 'design-uuid-1',
    version: 1,
    content: {
      fileName: 'invoice.pdf',
      params: { name: '山田太郎', amount: 10000 },
    },
  };

  type ContentItem =
    | { type: 'text'; text: string }
    | {
        type: 'resource';
        resource: { uri: string; mimeType: string; blob: string };
      };

  const findResource = (items: ContentItem[]) =>
    items.find(
      (
        c,
      ): c is {
        type: 'resource';
        resource: { uri: string; mimeType: string; blob: string };
      } => c.type === 'resource',
    );

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
    it('人間向けサマリ + JSON + 保存パスを返す (preview は default OFF)', async () => {
      mockBinaryResponse();

      const result = await handleGeneratePdfSync(input);

      expect(result.isError).toBeUndefined();
      expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(
        expect.any(ArrayBuffer),
        'invoice.pdf',
        undefined,
        [],
      );

      const text = findText(result.content as ContentItem[]);
      expect(text).toBeDefined();
      const { summary, data } = parseTextContent(text!.text);
      expect(summary).toContain('PDF生成完了');
      expect(summary).toContain('/tmp/invoice.pdf');
      expect(summary).toContain(DEFAULT_FILE_URL);
      expect(data.filePath).toBe('/tmp/invoice.pdf');
      expect(data.fileUrl).toBe(DEFAULT_FILE_URL);
      expect(data.requestId).toBe(DEFAULT_REQUEST_ID);
      expect(data.fileId).toBe('file-uuid-1');

      // preview は default OFF
      expect(findResource(result.content as ContentItem[])).toBeUndefined();
    });

    it('includePreview=true で EmbeddedResource を併せて返す', async () => {
      mockBinaryResponse();

      const result = await handleGeneratePdfSync({
        ...input,
        includePreview: true,
      });

      const resource = findResource(result.content as ContentItem[]);
      expect(resource).toBeDefined();
      expect(resource!.resource.mimeType).toBe('application/pdf');
      expect(resource!.resource.blob).toBe(PDF_BASE64);
      expect(resource!.resource.uri).toBe('file:///tmp/invoice.pdf');
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

    it('空白を含むパスでも RFC 8089 準拠の file URI を返す (preview ON 時)', async () => {
      mockBinaryResponse();
      mockedFileHelper.saveTempFile.mockResolvedValue(
        '/tmp/my docs/invoice.pdf',
      );

      const result = await handleGeneratePdfSync({
        ...input,
        includePreview: true,
      });
      const resource = findResource(result.content as ContentItem[]);
      expect(resource!.resource.uri).toBe('file:///tmp/my%20docs/invoice.pdf');
    });
  });

  describe('HTTP モード', () => {
    it('saveTempFile を呼ばず人間向けサマリ + fileUrl JSON を返す (preview OFF)', async () => {
      mockBinaryResponse();

      const result = await handleGeneratePdfSync(input, { mode: 'http' });

      expect(result.isError).toBeUndefined();
      expect(mockedFileHelper.saveTempFile).not.toHaveBeenCalled();

      const text = findText(result.content as ContentItem[]);
      expect(text).toBeDefined();
      const { summary, data } = parseTextContent(text!.text);
      expect(summary).toContain('PDF生成完了');
      expect(summary).toContain(DEFAULT_FILE_URL);
      expect(data.filePath).toBeUndefined();
      expect(data.fileUrl).toBe(DEFAULT_FILE_URL);
      expect(data.requestId).toBe(DEFAULT_REQUEST_ID);
      expect(data.fileId).toBe('file-uuid-1');

      // preview は default OFF → resource は含まない (payload bloat 回避)
      expect(findResource(result.content as ContentItem[])).toBeUndefined();
    });

    it('includePreview=true で EmbeddedResource も併せて返す', async () => {
      mockBinaryResponse();

      const result = await handleGeneratePdfSync(
        { ...input, includePreview: true },
        { mode: 'http' },
      );

      const resource = findResource(result.content as ContentItem[]);
      expect(resource).toBeDefined();
      expect(resource!.resource.mimeType).toBe('application/pdf');
      expect(resource!.resource.blob).toBe(PDF_BASE64);
      expect(resource!.resource.uri).toBe('file:///invoice.pdf');
    });

    it('sync エンドポイントが File-URL ヘッダを返さなくても text は返す (summary のみ)', async () => {
      mockBinaryResponse(PDF_ARRAY_BUFFER, 200, {});

      const result = await handleGeneratePdfSync(input, { mode: 'http' });

      expect(result.isError).toBeUndefined();
      const text = findText(result.content as ContentItem[]);
      expect(text).toBeDefined();
      expect(text!.text).toContain('PDF生成完了');
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

    it('fileName に特殊文字を含んでも URL-encode される (preview ON 時)', async () => {
      mockBinaryResponse();

      const result = await handleGeneratePdfSync(
        {
          ...input,
          content: { ...input.content, fileName: '請求書 #1.pdf' },
          includePreview: true,
        },
        { mode: 'http' },
      );

      const resource = findResource(result.content as ContentItem[]);
      expect(resource!.resource.uri).toBe(
        `file:///${encodeURIComponent('請求書 #1.pdf')}`,
      );
    });
  });

  describe('エラー系', () => {
    it('API エラー時に isError=true で対処方法を含むテキスト', async () => {
      mockFetch.mockRejectedValue(new Error('Server Error'));

      const result = await handleGeneratePdfSync(input);

      expect(result.isError).toBe(true);
      const text = findText(result.content as ContentItem[]);
      expect(text!.text).toContain('PDF生成に失敗しました');
      expect(text!.text).toContain('Server Error');
      // 対処ヒントが含まれる
      expect(text!.text).toContain('対処');
    });
  });
});
