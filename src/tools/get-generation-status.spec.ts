import {
  getGenerationStatusTool,
  handleGetGenerationStatus,
} from './get-generation-status';

jest.mock('../auth', () => ({
  requestWithAuth: jest.fn((fn: (h: Record<string, string>) => unknown) =>
    fn({ Authorization: 'Bearer test-token' }),
  ),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const jsonRes = (
  body: unknown,
  { status = 200, headers = {} as Record<string, string> } = {},
) => ({
  ok: status < 400,
  status,
  statusText: status < 400 ? 'OK' : 'Error',
  json: () => Promise.resolve(body),
  headers: new Headers(headers),
});

const payloadOf = (text: string): Record<string, unknown> =>
  JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>;

describe('get_generation_status (PRJ-3-2018)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('説明文は requestId を UUID と書かない', () => {
    expect(getGenerationStatusTool.name).toBe('get_generation_status');
    expect(getGenerationStatusTool.description).toContain('UUID ではない');
  });

  it('processing: Retry-After 秒後の再呼び出しを促し、本文をそのまま返す', async () => {
    mockFetch.mockResolvedValue(
      jsonRes(
        {
          requestId: 'AbC123dEf456GhI7',
          status: 'processing',
          designId: '0eUDdgAjNXrrItA2',
          version: 3,
          files: [],
          createdAt: '2026-10-01T00:00:00.000Z',
        },
        { headers: { 'Retry-After': '2' } },
      ),
    );

    const result = await handleGetGenerationStatus({
      requestId: 'AbC123dEf456GhI7',
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('生成中です。2 秒後に');
    expect(payloadOf(text)).toMatchObject({
      status: 'processing',
      retryAfterSeconds: 2,
      designId: '0eUDdgAjNXrrItA2',
    });
    expect(mockFetch.mock.calls[0][0]).toContain(
      '/v1/file/status/AbC123dEf456GhI7',
    );
  });

  it('queued で Retry-After が無ければ秒数を作らない', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ requestId: 'r', status: 'queued', files: [] }),
    );
    const result = await handleGetGenerationStatus({ requestId: 'r' });
    expect(result.content[0].text).toContain('数秒おいてから');
  });

  it('completed (stdio): download_file / download_zip を案内する', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'r',
        status: 'completed',
        files: [
          {
            fileId: 'f1',
            fileName: 'invoice.pdf',
            pageCount: 1,
            downloadPath: '/v1/file/download/r/f1',
          },
        ],
        completedAt: '2026-10-01T00:00:05.000Z',
      }),
    );
    const result = await handleGetGenerationStatus({ requestId: 'r' });
    const text = result.content[0].text;
    expect(text).toContain('download_file');
    expect(text).not.toContain('失敗しています');
    expect(payloadOf(text)).toMatchObject({ status: 'completed' });
  });

  it('completed (http): ダウンロードツールではなく出力履歴画面の url を案内する', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'r',
        status: 'completed',
        files: [],
        failedFiles: [
          { fileName: 'b.pdf', code: 'PARAMS_TYPE_MISMATCH', message: 'x' },
        ],
      }),
    );
    const result = await handleGetGenerationStatus(
      { requestId: 'r' },
      { mode: 'http' },
    );
    const text = result.content[0].text;
    expect(text).toContain('出力履歴画面');
    expect(text).not.toContain('download_file');
    expect(text).toContain('1 件は生成に失敗');
  });

  it('failed (入力起因): error.code / message を添えて入力の修正とやり直しを促す', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'r',
        status: 'failed',
        files: [],
        error: { code: 'PARAMS_TYPE_MISMATCH', message: 'bad' },
      }),
    );
    const result = await handleGetGenerationStatus({ requestId: 'r' });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('生成に失敗しました (PARAMS_TYPE_MISMATCH: bad)');
    expect(text).toContain('入力の誤りなら直してから生成をやり直して');
  });

  it.each(['PLAN_PAGE_LIMIT_EXCEEDED', 'ACTIVE_PLAN_NOT_FOUND'])(
    'failed (%s): 入力の修正や再生成ではなく、利用者への伝達を促す',
    async (code) => {
      mockFetch.mockResolvedValue(
        jsonRes({
          requestId: 'r',
          status: 'failed',
          files: [],
          error: { code, message: 'limit' },
        }),
      );
      const result = await handleGetGenerationStatus({ requestId: 'r' });
      const text = result.content[0].text;
      expect(text).toContain(`生成に失敗しました (${code}: limit)`);
      expect(text).toContain('error.message をそのまま利用者に伝えて');
      expect(text).not.toContain('入力の誤りなら直して');
    },
  );

  it('failed（複数出力の全件失敗）: failedFiles があればファイルごとの理由を参照させる', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'r',
        status: 'failed',
        files: [],
        failedFiles: [
          {
            fileId: 'F1',
            fileName: 'a',
            code: 'PARAMS_TYPE_MISMATCH',
            message: 'x',
          },
        ],
        error: {
          code: 'FILE_GENERATION_FAILED',
          message: 'All 1 files failed to generate.',
        },
      }),
    );
    const result = await handleGetGenerationStatus({ requestId: 'r' });
    const text = result.content[0].text;
    expect(text).toContain('FILE_GENERATION_FAILED');
    expect(text).toContain('failedFiles の code / message');
    expect(text).toContain('PARAMS_TYPE_MISMATCH');
  });

  it('failed で error が無くても落ちない', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ requestId: 'r', status: 'failed', files: [] }),
    );
    const result = await handleGetGenerationStatus({ requestId: 'r' });
    expect(result.content[0].text).toContain('生成に失敗しました。');
  });

  it('契約外の status は推測で案内せず値だけ返す', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ requestId: 'r', status: 'archived', files: [] }),
    );
    const result = await handleGetGenerationStatus({ requestId: 'r' });
    expect(result.content[0].text.startsWith('status: archived')).toBe(true);
  });

  it('404 REQUEST_NOT_FOUND: code つきのエラーを返す', async () => {
    mockFetch.mockResolvedValue(
      jsonRes(
        {
          statusCode: 404,
          code: 'REQUEST_NOT_FOUND',
          message: 'Request not found.',
          details: [],
          docsUrl:
            'https://doc.re-port-flow.com/en/docs/guides/error-codes#request_not_found',
        },
        { status: 404 },
      ),
    );
    const result = await handleGetGenerationStatus({ requestId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'エラー: [404] REQUEST_NOT_FOUND: Request not found.',
    );
    expect(result.content[0].text).toContain('Docs: https://');
  });

  it('通信失敗も isError で返す', async () => {
    mockFetch.mockRejectedValue('boom');
    const result = await handleGetGenerationStatus({ requestId: 'r' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('エラー: boom');
  });
});
