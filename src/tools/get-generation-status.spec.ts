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

describe('get_generation_status: Slack 状態カード (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());
  const body = {
    requestId: 'AbC123dEf456GhI7',
    status: 'processing',
    files: [],
  };

  it('slackBlocks を指定しなければ _meta を付けない', async () => {
    mockFetch.mockResolvedValue(jsonRes(body));
    const result = await handleGetGenerationStatus(
      { requestId: body.requestId },
      { mode: 'http' },
    );
    expect(result._meta).toBeUndefined();
  });

  it('slackBlocks: true なら text は変えずに状態カードを足す', async () => {
    mockFetch.mockResolvedValue(jsonRes(body));
    const without = await handleGetGenerationStatus(
      { requestId: body.requestId },
      { mode: 'http' },
    );
    mockFetch.mockResolvedValue(jsonRes(body));
    const withCard = await handleGetGenerationStatus(
      { requestId: body.requestId },
      { mode: 'http', slackBlocks: true },
    );
    expect(withCard.content).toEqual(without.content);
    expect(JSON.stringify(withCard._meta?.slack.blocks)).toContain('生成中');
  });

  it('照会の失敗 (404 等) にはカードを付けない', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ message: 'not found' }, { status: 404 }),
    );
    const result = await handleGetGenerationStatus(
      { requestId: body.requestId },
      { mode: 'http', slackBlocks: true },
    );
    expect(result.isError).toBe(true);
    expect(result._meta).toBeUndefined();
  });
});

describe('get_generation_status: プラン起因の判定は text とカードで一致する (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('上位が FILE_GENERATION_FAILED・ファイル側が PLAN_* のとき、text もカードもプラン起因の案内', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'AbC123dEf456GhI7',
        status: 'failed',
        files: [],
        error: { code: 'FILE_GENERATION_FAILED', message: 'all failed' },
        failedFiles: [
          {
            fileName: 'a.pdf',
            code: 'PLAN_PAGE_LIMIT_EXCEEDED',
            message: 'limit',
          },
        ],
      }),
    );
    const result = await handleGetGenerationStatus(
      { requestId: 'AbC123dEf456GhI7' },
      { mode: 'http', slackBlocks: true },
    );
    const text = result.content[0].text;
    expect(text).toContain('プランの上限や設定による失敗です');
    expect(text).not.toContain('入力の誤りなら直してから');
    expect(JSON.stringify(result._meta?.slack.blocks)).toContain(
      '再生成しても解消しません',
    );
  });
});

describe('get_generation_status: プラン起因と入力誤りの混在 (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('text はプランの案内と、プラン以外は直して再生成の案内を両方出す', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'AbC123dEf456GhI7',
        status: 'failed',
        files: [],
        error: { code: 'FILE_GENERATION_FAILED', message: 'all failed' },
        failedFiles: [
          {
            fileName: 'a.pdf',
            code: 'PLAN_PAGE_LIMIT_EXCEEDED',
            message: 'limit',
          },
          { fileName: 'b.pdf', code: 'INVALID_PARAMS', message: 'bad' },
        ],
      }),
    );
    const result = await handleGetGenerationStatus({
      requestId: 'AbC123dEf456GhI7',
    });
    const text = result.content[0].text;
    expect(text).toContain('プランの上限や設定による失敗です');
    expect(text).toContain('入力の誤りなら直してから');
  });
});

describe('get_generation_status: 上流が契約外の値を返してもカードで落ちない (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('failedFiles の fileName が null でも isError にならず、text と (エスケープ済みの) カードを返す', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'AbC123dEf456GhI7',
        status: 'failed',
        files: [],
        error: { code: 'FILE_GENERATION_FAILED', message: 'x' },
        failedFiles: [{ fileName: null, code: 'X', message: 'y' }],
      }),
    );
    const result = await handleGetGenerationStatus(
      { requestId: 'AbC123dEf456GhI7' },
      { mode: 'http', slackBlocks: true },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('生成に失敗しました');
    expect(result._meta?.slack.blocks.length).toBeGreaterThan(0);
  });

  it('error.message が欠けていても isError にならない', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'AbC123dEf456GhI7',
        status: 'failed',
        files: [],
        error: { code: 'FILE_GENERATION_FAILED' },
      }),
    );
    const result = await handleGetGenerationStatus(
      { requestId: 'AbC123dEf456GhI7' },
      { mode: 'http', slackBlocks: true },
    );
    expect(result.isError).toBeUndefined();
  });
});

describe('get_generation_status: failedFiles が契約外の形でも text を返す (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['[null]', [null]],
    ['{}', {}],
    ['文字列', 'oops'],
  ])(
    'failedFiles が %s のとき、slack 無効でも有効でも isError にならない',
    async (_l, failedFiles) => {
      for (const slackBlocks of [false, true]) {
        mockFetch.mockResolvedValue(
          jsonRes({
            requestId: 'AbC123dEf456GhI7',
            status: 'failed',
            files: [],
            error: { code: 'FILE_GENERATION_FAILED', message: 'x' },
            failedFiles,
          }),
        );
        const result = await handleGetGenerationStatus(
          { requestId: 'AbC123dEf456GhI7' },
          { mode: 'http', slackBlocks },
        );
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('生成に失敗しました');
      }
    },
  );
});

describe('get_generation_status: completed の一部失敗でもプラン判定は text とカードで一致する (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());
  const base = {
    requestId: 'AbC123dEf456GhI7',
    status: 'completed',
    files: [{ fileId: 'f1', fileName: 'ok.pdf', downloadPath: '/v1/x' }],
  };

  it.each([
    [
      'all',
      [
        {
          fileName: 'a.pdf',
          code: 'PLAN_PAGE_LIMIT_EXCEEDED',
          message: 'limit',
        },
      ],
      ['再生成しても解消しない'],
      [],
    ],
    [
      'mixed',
      [
        {
          fileName: 'a.pdf',
          code: 'PLAN_PAGE_LIMIT_EXCEEDED',
          message: 'limit',
        },
        { fileName: 'b.pdf', code: 'INVALID_PARAMS', message: 'bad' },
      ],
      ['再生成しても解消しない', '入力の誤りなら直してから'],
      [],
    ],
    [
      'none',
      [{ fileName: 'b.pdf', code: 'INVALID_PARAMS', message: 'bad' }],
      [],
      ['再生成しても解消しない'],
    ],
  ] as const)('%s', async (_l, failedFiles, contains, notContains) => {
    mockFetch.mockResolvedValue(jsonRes({ ...base, failedFiles }));
    const result = await handleGetGenerationStatus(
      { requestId: base.requestId },
      { mode: 'http', slackBlocks: true },
    );
    const text = result.content[0].text;
    expect(text).toContain(
      `ただし ${failedFiles.length} 件は生成に失敗しています`,
    );
    for (const c of contains) expect(text).toContain(c);
    for (const c of notContains) expect(text).not.toContain(c);
  });

  it('failedFiles に null が混ざっても、件数は読める要素だけを数える (カードと一致)', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        ...base,
        failedFiles: [null, { fileName: 'b.pdf', code: 'X', message: 'y' }],
      }),
    );
    const result = await handleGetGenerationStatus({
      requestId: base.requestId,
    });
    expect(result.content[0].text).toContain(
      'ただし 1 件は生成に失敗しています',
    );
  });
});

describe('get_generation_status: ファイル側の PLAN では failedFiles の message を伝えさせる (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    [
      'all',
      [
        {
          fileName: 'a.pdf',
          code: 'PLAN_PAGE_LIMIT_EXCEEDED',
          message: 'upgrade',
        },
      ],
    ],
    [
      'mixed',
      [
        {
          fileName: 'a.pdf',
          code: 'PLAN_PAGE_LIMIT_EXCEEDED',
          message: 'upgrade',
        },
        { fileName: 'b.pdf', code: 'INVALID_PARAMS', message: 'bad' },
      ],
    ],
  ])(
    '%s: text は failedFiles の message を案内し、総称の error.message を伝えさせない',
    async (_l, failedFiles) => {
      mockFetch.mockResolvedValue(
        jsonRes({
          requestId: 'AbC123dEf456GhI7',
          status: 'failed',
          files: [],
          error: {
            code: 'FILE_GENERATION_FAILED',
            message: 'All 2 files failed to generate.',
          },
          failedFiles,
        }),
      );
      const result = await handleGetGenerationStatus({
        requestId: 'AbC123dEf456GhI7',
      });
      const text = result.content[0].text;
      expect(text).toContain(
        'code が PLAN を含むものの message をそのまま利用者に伝えて',
      );
      expect(text).not.toContain('error.message をそのまま利用者に伝えて');
    },
  );

  it('単一出力 (failedFiles 無し) の PLAN は従来どおり error.message を伝えさせる', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'AbC123dEf456GhI7',
        status: 'failed',
        files: [],
        error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: 'limit' },
      }),
    );
    const result = await handleGetGenerationStatus({
      requestId: 'AbC123dEf456GhI7',
    });
    expect(result.content[0].text).toContain(
      'error.message をそのまま利用者に伝えて',
    );
  });
});

describe('get_generation_status: 上位だけが PLAN 系でファイル側は別理由 (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('failed: error.message を伝えさせ、ファイル側の失敗には直して再生成を案内する', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'AbC123dEf456GhI7',
        status: 'failed',
        files: [],
        error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: 'upgrade' },
        failedFiles: [
          { fileName: 'a.pdf', code: 'RENDER_FAILED', message: 'x' },
        ],
      }),
    );
    const result = await handleGetGenerationStatus({
      requestId: 'AbC123dEf456GhI7',
    });
    const text = result.content[0].text;
    expect(text).toContain('error.message をそのまま利用者に伝えて');
    expect(text).not.toContain('code が PLAN を含むものの message');
    expect(text).toContain('入力の誤りなら直してから');
  });

  it('completed の一部失敗: error.message を伝えさせる', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'AbC123dEf456GhI7',
        status: 'completed',
        files: [{ fileId: 'f1', fileName: 'ok.pdf', downloadPath: '/v1/x' }],
        error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: 'upgrade' },
        failedFiles: [
          { fileName: 'a.pdf', code: 'RENDER_FAILED', message: 'x' },
        ],
      }),
    );
    const result = await handleGetGenerationStatus({
      requestId: 'AbC123dEf456GhI7',
    });
    expect(result.content[0].text).toContain(
      'error.message をそのまま利用者に伝えて',
    );
    expect(result.content[0].text).toContain('入力の誤りなら直してから');
  });
});

describe('get_generation_status: 上位とファイル側の両方が PLAN 系 (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('failed: ファイルの message と上位の error.message の両方を伝えさせる', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'AbC123dEf456GhI7',
        status: 'failed',
        files: [],
        error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: 'upgrade' },
        failedFiles: [
          {
            fileName: 'a.pdf',
            code: 'PLAN_PAGE_LIMIT_EXCEEDED',
            message: 'limit',
          },
        ],
      }),
    );
    const result = await handleGetGenerationStatus({
      requestId: 'AbC123dEf456GhI7',
    });
    const text = result.content[0].text;
    expect(text).toContain(
      'code が PLAN を含むものの message をそのまま利用者に伝えて',
    );
    expect(text).toContain('上位の error.message にも案内があれば併せて伝えて');
    expect(text).not.toContain('入力の誤りなら直してから');
  });
});

describe('get_generation_status: completed で上位とファイル側の両方が PLAN 系 (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('failed と同じく、上位の error.message も伝えさせる', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({
        requestId: 'AbC123dEf456GhI7',
        status: 'completed',
        files: [{ fileId: 'f1', fileName: 'ok.pdf', downloadPath: '/v1/x' }],
        error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: 'upgrade' },
        failedFiles: [
          {
            fileName: 'a.pdf',
            code: 'PLAN_PAGE_LIMIT_EXCEEDED',
            message: 'limit',
          },
        ],
      }),
    );
    const result = await handleGetGenerationStatus({
      requestId: 'AbC123dEf456GhI7',
    });
    const text = result.content[0].text;
    expect(text).toContain('failedFiles の message をそのまま利用者に伝えて');
    expect(text).toContain('上位の error.message にも案内があれば併せて伝えて');
  });
});

describe('get_generation_status: プラン以外の失敗ファイルには、そのファイルの code / message を見させる (PRJ-3-2563)', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    [
      '上位が PLAN 系',
      'PLAN_PAGE_LIMIT_EXCEEDED',
      [{ fileName: 'a.pdf', code: 'RENDER_FAILED', message: 'x' }],
    ],
    [
      '上位が総称・混在',
      'FILE_GENERATION_FAILED',
      [
        {
          fileName: 'a.pdf',
          code: 'PLAN_PAGE_LIMIT_EXCEEDED',
          message: 'limit',
        },
        { fileName: 'b.pdf', code: 'RENDER_FAILED', message: 'x' },
      ],
    ],
  ])(
    '%s: 上位の error.code / error.message に従わせない',
    async (_l, code, failedFiles) => {
      mockFetch.mockResolvedValue(
        jsonRes({
          requestId: 'AbC123dEf456GhI7',
          status: 'failed',
          files: [],
          error: { code, message: 'top' },
          failedFiles,
        }),
      );
      const result = await handleGetGenerationStatus({
        requestId: 'AbC123dEf456GhI7',
      });
      const text = result.content[0].text;
      expect(text).toContain(
        '失敗したファイルは、その code / message に従って対処して',
      );
      expect(text).not.toContain('error.code / error.message に従って');
    },
  );
});
