import * as fileHelper from '../file-helper';
import { handleDownloadFile } from './download-file';

jest.mock('../auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ Authorization: 'Bearer test-token' }),
  ),
}));
jest.mock('../file-helper');

const mockedFileHelper = fileHelper as jest.Mocked<typeof fileHelper>;
const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockBinaryResponse(buffer: ArrayBuffer, status = 200) {
  mockFetch.mockResolvedValue({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(buffer),
  });
}

describe('handleDownloadFile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('正常系: ファイルをダウンロードしてパスを返す', async () => {
    mockBinaryResponse(Buffer.from('PDF_CONTENT').buffer);
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/invoice.pdf');

    const result = await handleDownloadFile({
      requestId: 'req-uuid-1',
      fileId: 'file-uuid-1',
      fileName: 'invoice.pdf',
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).filePath).toBe(
      '/tmp/invoice.pdf',
    );
    expect(mockFetch.mock.calls[0][0]).toContain('req-uuid-1/file-uuid-1');
  });

  it('正常系: fileNameを省略するとfileId.pdfになる', async () => {
    mockBinaryResponse(Buffer.from('').buffer);
    mockedFileHelper.saveTempFile.mockResolvedValue('/tmp/file-uuid-1.pdf');

    const result = await handleDownloadFile({
      requestId: 'req-uuid-1',
      fileId: 'file-uuid-1',
    });

    expect(result.isError).toBeUndefined();
    expect(mockedFileHelper.saveTempFile).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      'file-uuid-1.pdf',
      undefined,
      [],
    );
  });

  it('エラー系: APIエラー時にisError=trueを返す', async () => {
    mockFetch.mockRejectedValue(new Error('Not Found'));

    const result = await handleDownloadFile({
      requestId: 'req-uuid-1',
      fileId: 'file-uuid-1',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('エラー: Not Found');
  });

  // ─── 生成状態ごとの返し分け (PRJ-3-2018) ──────────────────────────────────
  const errorRes = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => ({
    ok: false,
    status,
    statusText: 'Error',
    json: () => Promise.resolve(body),
    headers: new Headers(headers),
  });

  it('409 FILE_NOT_READY: 失敗ではなく「生成中・N 秒後に再試行」を返す', async () => {
    mockFetch.mockResolvedValue(
      errorRes(
        409,
        {
          statusCode: 409,
          code: 'FILE_NOT_READY',
          message: 'File is still being generated.',
          retryAfter: 2,
        },
        { 'Retry-After': '2' },
      ),
    );

    const result = await handleDownloadFile({
      requestId: 'AbC123dEf456GhI7',
      fileId: 'f1',
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('まだ生成中');
    expect(text).toContain('2 秒後に');
    expect(text).toContain('download_file');
    const payload = JSON.parse(text.slice(text.indexOf('{')));
    expect(payload).toEqual({
      status: 'processing',
      code: 'FILE_NOT_READY',
      requestId: 'AbC123dEf456GhI7',
      downloaded: false,
      retryAfterSeconds: 2,
    });
    expect(mockedFileHelper.saveTempFile).not.toHaveBeenCalled();
  });

  it('409 FILE_NOT_READY で秒数が無ければ秒数を作らない', async () => {
    mockFetch.mockResolvedValue(
      errorRes(409, { code: 'FILE_NOT_READY', message: 'not ready' }),
    );
    const result = await handleDownloadFile({ requestId: 'r', fileId: 'f' });
    const text = result.content[0].text;
    expect(text).toContain('数秒おいてから');
    expect(JSON.parse(text.slice(text.indexOf('{')))).not.toHaveProperty(
      'retryAfterSeconds',
    );
  });

  it('422 FILE_GENERATION_FAILED: 生成失敗を伝え、状態確認へ誘導する', async () => {
    mockFetch.mockResolvedValue(
      errorRes(422, {
        code: 'FILE_GENERATION_FAILED',
        message: 'File generation failed.',
        docsUrl:
          'https://doc.re-port-flow.com/en/docs/guides/error-codes#file_generation_failed',
      }),
    );
    const result = await handleDownloadFile({ requestId: 'r1', fileId: 'f' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('FILE_GENERATION_FAILED');
    expect(text).toContain('get_generation_status');
    expect(text).toContain('"r1"');
    expect(text).toContain('その案内に従って対処');
    // 422 の時点では元の error.code が分からないので、対処 (入力の修正など) を断定しない
    expect(text).not.toContain('入力を直して');
    expect(text).toContain('Docs: https://doc.re-port-flow.com/');
  });

  it('404: requestId / fileId の確認と、削除の可能性 (get_generation_status) を案内する', async () => {
    mockFetch.mockResolvedValue(
      errorRes(404, { code: 'FILE_NOT_FOUND', message: 'File not found.' }),
    );
    const result = await handleDownloadFile({ requestId: 'r', fileId: 'f' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      '[404] FILE_NOT_FOUND: File not found.',
    );
    expect(result.content[0].text).toContain('requestId / fileId');
    expect(result.content[0].text).toContain('出力が削除された可能性');
    expect(result.content[0].text).toContain('get_generation_status');
    expect(result.content[0].text).not.toContain('ID の誤りを意味します');
  });
});
