import { z } from 'zod';
import {
  handleCopyGalleryTemplate,
  copyGalleryTemplateInputSchema,
} from './copy-gallery-template';

jest.mock('../auth', () => {
  class AuthRequiredError extends Error {
    readonly mode: 'stdio' | 'http';
    // 本物と同じ 3 引数。第 3 引数が「書き込みを送った後の失敗か」で、
    // これを持たないと全ての認証失敗が結果不明になる（PR #117 の Codex 指摘）
    readonly retryAttempted: boolean;
    constructor(
      message = '再認証が必要です。',
      mode: 'stdio' | 'http' = 'stdio',
      retryAttempted = false,
    ) {
      super(message);
      this.name = 'AuthRequiredError';
      this.mode = mode;
      this.retryAttempted = retryAttempted;
    }
  }
  return {
    AuthRequiredError,
    getAuthWorkspaceId: jest.fn(),
    requestWithAuth: jest.fn(
      (fn: (h: Record<string, string>) => unknown): unknown =>
        fn({ Authorization: 'Bearer test-token' }),
    ),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const authMock = require('../auth') as {
  AuthRequiredError: new (
    message?: string,
    mode?: 'stdio' | 'http',
    retryAttempted?: boolean,
  ) => Error & { mode: 'stdio' | 'http'; retryAttempted: boolean };
  getAuthWorkspaceId: jest.Mock;
  requestWithAuth: jest.Mock;
};

const mockFetch = jest.fn();
global.fetch = mockFetch;

const detailFixture = {
  slug: 'invoice-basic',
  title: '請求書（標準）',
  description: '請求書のテンプレートです',
  category: 'other',
  tags: ['請求書'],
  thumbnailUrl: 'https://files.example.test/thumb.pdf',
  duplicateCount: 3,
  version: 2,
  ownerName: null,
  createdAt: '2026-03-21T14:13:02.000Z',
  updatedAt: '2026-07-29T13:46:10.000Z',
};

const duplicationFixture = {
  id: 'dup-log-1',
  templateId: 'tpl-1',
  templateSlug: 'invoice-basic',
  userId: 'user-1',
  workspaceId: 'ws-jwt-1',
  duplicatedFileId: 'design-new-1',
  sourceTemplateVersion: 2,
  createdAt: '2026-08-08T00:00:00.000Z',
};

function mockJsonOnce(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  });
}

describe('handleCopyGalleryTemplate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authMock.getAuthWorkspaceId.mockResolvedValue('ws-jwt-1');
  });

  it('正常系: slug 実在確認 → 複製 → designId と version=1 を返す', async () => {
    mockJsonOnce(detailFixture); // GET /public/templates/:slug
    mockJsonOnce(duplicationFixture, 201); // POST duplicate

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      designId: 'design-new-1',
      version: 1,
      name: '請求書（標準）',
      workspaceId: 'ws-jwt-1',
      duplicatedFrom: {
        slug: 'invoice-basic',
        templateId: 'tpl-1',
        templateVersion: 2,
      },
    });
    expect(payload['nextStep']).toContain('get_design_parameters');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [getUrl] = mockFetch.mock.calls[0] as [string];
    expect(getUrl).toContain('/public/templates/invoice-basic');
    const [postUrl, postInit] = mockFetch.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(postUrl).toContain('/ws-jwt-1/my/templates/invoice-basic/duplicate');
    expect((postInit.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-token',
    );
    expect(JSON.parse(postInit.body as string)).toEqual({
      workspaceId: 'ws-jwt-1',
    });
  });

  // ── PRJ-3-1245 の回帰テスト ──────────────────────────────────────────────
  //
  // reposts-api の @DefaultController は VerifyVersion ガードを付け、app-key が
  // 無いリクエストを 412 で門前払いする。このヘッダーが落ちると複製は一度も
  // 成功しなくなるため、送信されていることを構造的に固定する。
  it('回帰(PRJ-3-1245): 複製 POST に非空の app-key ヘッダーが付く', async () => {
    mockJsonOnce(detailFixture);
    mockJsonOnce(duplicationFixture, 201);

    await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const appKey = (postInit.headers as Record<string, string>)['app-key'];
    expect(typeof appKey).toBe('string');
    expect(appKey.length).toBeGreaterThan(0);
  });

  it('回帰(PRJ-3-1245): app-key は REPORTFLOW_APP_KEY で差し替えできる', async () => {
    const previous = process.env['REPORTFLOW_APP_KEY'];
    process.env['REPORTFLOW_APP_KEY'] = 'custom-key';
    try {
      mockJsonOnce(detailFixture);
      mockJsonOnce(duplicationFixture, 201);

      await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

      const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect((postInit.headers as Record<string, string>)['app-key']).toBe(
        'custom-key',
      );
    } finally {
      if (previous === undefined) delete process.env['REPORTFLOW_APP_KEY'];
      else process.env['REPORTFLOW_APP_KEY'] = previous;
    }
  });

  // 空文字を送ると @IsNotEmpty で再び 412 になるため、既定値へ戻すこと
  it('回帰(PRJ-3-1245): REPORTFLOW_APP_KEY が空白のみなら既定値へフォールバックする', async () => {
    const previous = process.env['REPORTFLOW_APP_KEY'];
    process.env['REPORTFLOW_APP_KEY'] = '   ';
    try {
      mockJsonOnce(detailFixture);
      mockJsonOnce(duplicationFixture, 201);

      await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

      const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect((postInit.headers as Record<string, string>)['app-key']).toBe(
        'reportflow-mcp',
      );
    } finally {
      if (previous === undefined) delete process.env['REPORTFLOW_APP_KEY'];
      else process.env['REPORTFLOW_APP_KEY'] = previous;
    }
  });

  it('回帰(PRJ-3-1245): 412 は app-key の前提条件エラーと伝え、再試行/二重複製を示唆しない', async () => {
    mockJsonOnce(detailFixture);
    mockJsonOnce({ message: 'Precondition Failed' }, 412);

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // どのヘッダーの前提条件で落ちたかが分かる
    expect(text).toContain('app-key');
    // 「呼び直せば直る」と読めない
    expect(text).toContain('結果は変わりません');
    expect(text).not.toContain('再試行');
    // 複製は実行されていないので二重複製の警告を出さない
    expect(text).not.toContain('二重複製');
    expect(text).not.toContain('list_templates');
  });

  // PR #109 レビュー指摘: この分岐を持つのは app-key を送る版だけなので、
  // 412 を見た時点でクライアントは送信済み。「送信もれ」「最新版へ更新」と
  // 断定すると効かない対処へ誘導し、真因（経路でのヘッダー除去・設定値）を隠す。
  it('回帰(PR#109): 412 をクライアントの送信もれと断定せず、経路と設定の確認へ誘導する', async () => {
    mockJsonOnce(detailFixture);
    mockJsonOnce({ message: 'Precondition Failed' }, 412);

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    const text = result.content[0].text;
    // 効かない対処（クライアント更新）へ誘導しない
    expect(text).not.toContain('最新版');
    expect(text).toContain('送信もれではありません');
    // 実際に確認すべき対象を示す
    expect(text).toContain('プロキシ');
    expect(text).toContain('REPORTFLOW_APP_KEY');
  });

  it('境界: 引数に余分な workspaceId を混ぜても API へは JWT 由来の値だけを送る', async () => {
    mockJsonOnce(detailFixture);
    mockJsonOnce(duplicationFixture, 201);

    // zod 検証を通過した後の handler 入力に余分なキーが混ざっても使わないこと
    const result = await handleCopyGalleryTemplate({
      slug: 'invoice-basic',
      workspaceId: 'ws-evil',
    } as never);

    expect(result.isError).toBeUndefined();
    const [postUrl, postInit] = mockFetch.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(postUrl).toContain('/ws-jwt-1/my/templates/');
    expect(postUrl).not.toContain('ws-evil');
    expect(JSON.parse(postInit.body as string)).toEqual({
      workspaceId: 'ws-jwt-1',
    });
  });

  it('入力検証: zod スキーマは workspaceId キーを受け付けず strip する', () => {
    const schema = z.object(copyGalleryTemplateInputSchema);
    const parsed = schema.parse({
      slug: 'invoice-basic',
      workspaceId: 'ws-evil',
    });
    expect(parsed).toEqual({ slug: 'invoice-basic' });
  });

  it('入力検証: slug 空文字は zod で弾く', () => {
    const schema = z.object(copyGalleryTemplateInputSchema);
    expect(schema.safeParse({ slug: '' }).success).toBe(false);
  });

  it('異常系: 未認可 (AuthRequiredError / http 経路) は DCR 30日注意を含む', async () => {
    authMock.getAuthWorkspaceId.mockRejectedValue(
      new authMock.AuthRequiredError(
        '再認証が必要です: 上流 API が 401。',
        'http',
      ),
    );

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('再認証が必要です');
    expect(result.content[0].text).toContain('30 日');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // stdio は固定 client_id の seed クライアントで認可するため DCR の 30 日削除は
  // 起こらない。同じ注意を出すと「接続を作り直せ」という効かない対処へ誘導する
  it('異常系: 未認可 (AuthRequiredError / stdio 経路) は DCR 注意を付けない', async () => {
    authMock.getAuthWorkspaceId.mockRejectedValue(
      new authMock.AuthRequiredError('再認証が必要です: トークン未保存。'),
    );

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('再認証が必要です');
    expect(result.content[0].text).not.toContain('30 日');
    expect(result.content[0].text).not.toContain('DCR');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('異常系: トークンに workspace_id が無い場合は認可のやり直しを促す', async () => {
    authMock.getAuthWorkspaceId.mockResolvedValue(undefined);

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'ワークスペースが紐づいていません',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('異常系: slug が存在しない場合は複製せず検索やり直しを促す', async () => {
    mockJsonOnce({ message: 'not found' }, 404); // GET pre-check

    const result = await handleCopyGalleryTemplate({ slug: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('見つかりません');
    expect(result.content[0].text).toContain('search_gallery_templates');
    expect(result.content[0].text).toContain('複製は実行されていません');
    expect(mockFetch).toHaveBeenCalledTimes(1); // POST しない
  });

  it('異常系: 403 は不足スコープと再認可の必要性を伝える', async () => {
    mockJsonOnce(detailFixture);
    mockJsonOnce(
      { message: 'この操作には次のスコープが必要です: designs:write' },
      403,
    );

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('designs:write');
    expect(result.content[0].text).toContain('再認可');
  });

  it('異常系: 429 (プラン上限等) はサーバーのメッセージをそのまま伝える', async () => {
    const planMessage =
      'デザイン数の上限（10）に達しました。プランをアップグレードするか、既存のデザインを削除してください。';
    mockJsonOnce(detailFixture);
    mockJsonOnce({ message: planMessage }, 429);

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(planMessage);
  });

  it('異常系: 500 はスタックを出さず、再試行前の二重複製確認を促す', async () => {
    mockJsonOnce(detailFixture);
    mockJsonOnce({ message: 'internal error' }, 500);

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[500]');
    expect(result.content[0].text).toContain('list_templates');
    expect(result.content[0].text).not.toContain('at ');
  });

  it('異常系: タイムアウトは「失敗した」と断定せず、確認手順を返す', async () => {
    mockJsonOnce(detailFixture);
    mockFetch.mockRejectedValueOnce(
      new Error('Request timed out after 120000ms'),
    );

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('完了したかは不明');
    expect(result.content[0].text).not.toContain('失敗しました');
    expect(result.content[0].text).toContain('list_templates');
  });

  it('異常系: 接続失敗 (未到達) は 404 と区別して返す', async () => {
    mockJsonOnce(detailFixture);
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('到達できませんでした');
    expect(result.content[0].text).toContain('接続自体が失敗');
  });

  it('異常系: 複製応答が JSON でない場合は完了不明として返す（自動再試行させない）', async () => {
    mockJsonOnce(detailFixture);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () =>
        Promise.reject(new SyntaxError(`Unexpected token '<', "<!DOC"...`)),
    });

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('完了したかは不明');
  });

  it('異常系: duplicatedFileId が null の場合は契約違反として明示する', async () => {
    mockJsonOnce(detailFixture);
    mockJsonOnce({ ...duplicationFixture, duplicatedFileId: null }, 201);

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    // 仕様変更（情報設計 用語統一 2026-09）
    expect(result.content[0].text).toContain(
      'テンプレートは作成されませんでした',
    );
    expect(result.content[0].text).toContain('スナップショットデータが欠損');
  });

  it('堅牢性: 詳細レスポンスに title が無くても name が "undefined" にならず slug で代替する', async () => {
    mockJsonOnce({ ...detailFixture, title: undefined });
    mockJsonOnce(duplicationFixture, 201);

    const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as { name: string };
    expect(payload.name).toBe('invoice-basic');
  });

  // ------------------------------------------------------------------------
  // 複製需要テレメトリ (PRJ-3-1350)
  // ------------------------------------------------------------------------
  describe('複製需要テレメトリ', () => {
    it('成功時: slug / success=true と複製 API が返した workspaceId を渡す', async () => {
      mockJsonOnce(detailFixture);
      mockJsonOnce(duplicationFixture, 201);
      const onCopied = jest.fn();

      await handleCopyGalleryTemplate({ slug: 'invoice-basic' }, { onCopied });

      expect(onCopied).toHaveBeenCalledTimes(1);
      expect(onCopied).toHaveBeenCalledWith({
        slug: 'invoice-basic',
        success: true,
        // 未検証の JWT claim ではなくサーバーが確定させた複製先
        workspaceId: duplicationFixture.workspaceId,
      });
    });

    it('複製 API のエラーでも success=false で 1 回だけ送る', async () => {
      mockJsonOnce(detailFixture);
      mockJsonOnce({ message: 'not found' }, 404);
      const onCopied = jest.fn();

      const result = await handleCopyGalleryTemplate(
        { slug: 'invoice-basic' },
        { onCopied },
      );

      expect(result.isError).toBe(true);
      expect(onCopied).toHaveBeenCalledTimes(1);
      // 複製が成立していない呼び出しに帰属は付けない
      expect(onCopied).toHaveBeenCalledWith({
        slug: 'invoice-basic',
        success: false,
        slugVerified: true,
      });
    });

    it('認証エラーのような早期 return でも取りこぼさない', async () => {
      // 出口が 8 箇所あるため、ラッパーで 1 箇所に集約している回帰テスト
      authMock.getAuthWorkspaceId.mockRejectedValueOnce(
        new authMock.AuthRequiredError('認証が必要です。', 'stdio'),
      );
      const onCopied = jest.fn();

      const result = await handleCopyGalleryTemplate(
        { slug: 'invoice-basic' },
        { onCopied },
      );

      expect(result.isError).toBe(true);
      expect(onCopied).toHaveBeenCalledWith({
        slug: 'invoice-basic',
        success: false,
      });
    });

    it('本体が rethrow したときも success=false を 1 件送り、例外はそのまま投げ直す', async () => {
      // auth 層の非 AuthRequiredError は本体が rethrow する。ここで拾わないと
      // その呼び出しだけイベントが欠落し、転換率の分母が静かに減る。
      authMock.getAuthWorkspaceId.mockRejectedValueOnce(new Error('boom'));
      const onCopied = jest.fn();

      await expect(
        handleCopyGalleryTemplate({ slug: 'invoice-basic' }, { onCopied }),
      ).rejects.toThrow('boom');

      expect(onCopied).toHaveBeenCalledTimes(1);
      expect(onCopied).toHaveBeenCalledWith({
        slug: 'invoice-basic',
        success: false,
      });
    });

    it('コールバックが throw しても複製結果を握りつぶさない', async () => {
      mockJsonOnce(detailFixture);
      mockJsonOnce(duplicationFixture, 201);

      const result = await handleCopyGalleryTemplate(
        { slug: 'invoice-basic' },
        {
          onCopied: () => {
            throw new Error('telemetry down');
          },
        },
      );

      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0].text) as {
        designId: string;
      };
      expect(payload.designId).toBe(duplicationFixture.duplicatedFileId);
    });

    it('失敗経路でコールバックが throw してもエラー応答をそのまま返す', async () => {
      // 成功経路と同じ保証を失敗経路にも掛ける（送信は 2 箇所に分かれているため）
      mockJsonOnce(detailFixture);
      mockJsonOnce({ message: 'not found' }, 404);

      const result = await handleCopyGalleryTemplate(
        { slug: 'invoice-basic' },
        {
          onCopied: () => {
            throw new Error('telemetry down');
          },
        },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('見つかりませんでした');
    });

    it('deps 省略時は従来どおり動く（既存呼び出しの互換）', async () => {
      mockJsonOnce(detailFixture);
      mockJsonOnce(duplicationFixture, 201);

      const result = await handleCopyGalleryTemplate({ slug: 'invoice-basic' });

      expect(result.isError).toBeUndefined();
    });

    // ----------------------------------------------------------------------
    // 判定不能な複製 (outcomeUnknown)
    // ----------------------------------------------------------------------
    // サーバーが解釈できる応答を返さなかったとき、複製が完了したかは**こちら側
    // では確定できない**。これを失敗として記録すると、実際には完了した複製が
    // 「検索 → 複製の転換」の分子から消え、失敗件数だけが増える
    // （PR #117 の Codex 指摘）。
    describe('判定不能な複製は outcomeUnknown で残す', () => {
      /** 複製 POST を `reject` させる（詳細取得は成功させる）。 */
      const rejectDuplicationWith = (err: unknown): void => {
        mockJsonOnce(detailFixture);
        mockFetch.mockRejectedValueOnce(err);
      };

      const indeterminateCases: ReadonlyArray<{
        readonly name: string;
        readonly arrange: () => void;
      }> = [
        {
          name: 'タイムアウト',
          arrange: () =>
            rejectDuplicationWith(
              new Error('Request timed out after 120000ms'),
            ),
        },
        {
          name: '応答が JSON でない',
          arrange: () => {
            mockJsonOnce(detailFixture);
            mockFetch.mockResolvedValueOnce({
              ok: true,
              status: 200,
              statusText: 'OK',
              json: () =>
                Promise.reject(
                  new SyntaxError(`Unexpected token '<', "<!DOC"...`),
                ),
            });
          },
        },
        {
          name: '接続自体の失敗（送信前の失敗と応答読み取り中の切断を区別できない）',
          arrange: () => rejectDuplicationWith(new TypeError('fetch failed')),
        },
        {
          // origin が commit の後に落ちる / プロキシが応答経路で 502・504 を返す
          // 経路では、デザインが作られたまま 5xx が返る
          name: '500（commit 後に落ちた可能性を排除できない）',
          arrange: () => {
            mockJsonOnce(detailFixture);
            mockJsonOnce({ message: 'internal error' }, 500);
          },
        },
        {
          name: '502（応答経路のプロキシ由来。origin は書き込み済みかもしれない）',
          arrange: () => {
            mockJsonOnce(detailFixture);
            mockJsonOnce({ message: 'bad gateway' }, 502);
          },
        },
        {
          name: '400（意味を判断していないステータスを「書き込み無し」と断定しない）',
          arrange: () => {
            mockJsonOnce(detailFixture);
            mockJsonOnce({ message: 'bad request' }, 400);
          },
        },
      ];

      it('詳細応答が要求した slug を指していなければ slugVerified を立てない', async () => {
        // fetchJson は実行時検証をしないので 2xx + {} でも通る。それを実在確認と
        // 扱うと、AI が渡した任意の文字列がマスクを免除されて記録される
        // （PR #117 の Codex 指摘）
        mockJsonOnce({});
        mockJsonOnce({ message: 'boom' }, 500);
        const onCopied = jest.fn();

        await handleCopyGalleryTemplate(
          { slug: 'victim@example.com' },
          { onCopied },
        );

        const observation = onCopied.mock.calls[0][0] as Record<
          string,
          unknown
        >;
        expect(observation['slugVerified']).toBeUndefined();
      });

      // 「確定か否か」の判断は http.ts の WRITE_REJECTED_STATUSES が唯一の根拠。
      // 専用文言を持つ 403/404/412/429 のほかに 401 も集合に入っているので、
      // ここが不明扱いに落ちないことを固定する（判断が auth.ts と食い違うため）
      it('集合に含まれるが専用文言を持たない 401 も確定した失敗にする', async () => {
        mockJsonOnce(detailFixture);
        mockJsonOnce({ message: 'unauthorized' }, 401);
        const onCopied = jest.fn();

        const result = await handleCopyGalleryTemplate(
          { slug: 'invoice-basic' },
          { onCopied },
        );

        expect(result.content[0].text).toContain('複製は実行されていません');
        expect(result.content[0].text).not.toContain('不明');
        expect(onCopied.mock.calls[0][0]).not.toHaveProperty('outcomeUnknown');
      });

      it('要求した slug を反射するだけの応答では slugVerified を立てない', async () => {
        // slug の一致だけを見ていると `{ slug: 入力値 }` が実在確認を通り、
        // AI が渡した任意の文字列がマスクを免除される（PR #117 の Codex 指摘）
        mockJsonOnce({ slug: 'victim@example.com' });
        mockJsonOnce({ message: 'boom' }, 500);
        const onCopied = jest.fn();

        await handleCopyGalleryTemplate(
          { slug: 'victim@example.com' },
          { onCopied },
        );

        const observation = onCopied.mock.calls[0][0] as Record<
          string,
          unknown
        >;
        expect(observation['slugVerified']).toBeUndefined();
      });

      it('型が契約外のフィールドを含む詳細応答では slugVerified を立てない', async () => {
        mockJsonOnce({ ...detailFixture, version: '2' });
        mockJsonOnce({ message: 'boom' }, 500);
        const onCopied = jest.fn();

        await handleCopyGalleryTemplate(
          { slug: 'invoice-basic' },
          { onCopied },
        );

        const observation = onCopied.mock.calls[0][0] as Record<
          string,
          unknown
        >;
        expect(observation['slugVerified']).toBeUndefined();
      });

      // 検査対象を数個ずつ足していた頃は「まだ足りない」と指摘され続けたため、
      // 契約の全フィールドを 1 つずつ落として確認する（PR #117 の Codex 指摘）
      it.each(Object.keys(detailFixture))(
        '%s が欠けた詳細応答では slugVerified を立てない',
        async (missingKey) => {
          const partial: Record<string, unknown> = { ...detailFixture };
          delete partial[missingKey];
          mockJsonOnce(partial);
          mockJsonOnce({ message: 'boom' }, 500);
          const onCopied = jest.fn();

          await handleCopyGalleryTemplate(
            { slug: 'invoice-basic' },
            { onCopied },
          );

          const observation = onCopied.mock.calls[0][0] as Record<
            string,
            unknown
          >;
          expect(observation['slugVerified']).toBeUndefined();
        },
      );

      it('refresh 後の retry 失敗（AuthRequiredError 包み）は不明として記録する', async () => {
        // requestWithAuth は retry のあらゆるエラーを AuthRequiredError で包むため、
        // タイムアウト・5xx が種別ごと潰れて届く（PR #117 の Codex 指摘）。
        // 第 3 引数 true = 「書き込みを送った後の失敗」を auth.ts が立てた印
        mockJsonOnce(detailFixture);
        authMock.requestWithAuth.mockImplementationOnce(() => {
          throw new authMock.AuthRequiredError(
            '401 後の再試行失敗',
            'stdio',
            true,
          );
        });
        const onCopied = jest.fn();

        await handleCopyGalleryTemplate(
          { slug: 'invoice-basic' },
          { onCopied },
        );

        expect(onCopied).toHaveBeenCalledWith({
          slug: 'invoice-basic',
          success: false,
          outcomeUnknown: true,
          slugVerified: true,
        });
      });

      it.each([
        ['http 経路の 401（再送していない）', 'http' as const],
        ['stdio の refresh 失敗（再送していない）', 'stdio' as const],
      ])('%s は確定した失敗として記録する', async (_name, mode) => {
        // AuthRequiredError を一律 outcomeUnknown にすると、書き込みが起きて
        // いないと分かっている認証失敗まで失敗件数から消える（PR #117 の Codex 指摘）
        mockJsonOnce(detailFixture);
        authMock.requestWithAuth.mockImplementationOnce(() => {
          throw new authMock.AuthRequiredError('上流 API が 401', mode);
        });
        const onCopied = jest.fn();

        await handleCopyGalleryTemplate(
          { slug: 'invoice-basic' },
          { onCopied },
        );

        expect(onCopied).toHaveBeenCalledWith({
          slug: 'invoice-basic',
          success: false,
          slugVerified: true,
        });
      });

      it.each([
        ['workspaceId が欠損', { workspaceId: undefined }],
        ['workspaceId が型違い', { workspaceId: 42 }],
        ['workspaceId が別ワークスペース', { workspaceId: 'ws-other' }],
        ['templateSlug が型違い', { templateSlug: 7 }],
        ['templateSlug が別テンプレート', { templateSlug: 'other-template' }],
        ['duplicatedFileId が空文字', { duplicatedFileId: '' }],
        ['id が空文字', { id: '' }],
        ['sourceTemplateVersion が NaN', { sourceTemplateVersion: Number.NaN }],
        ['createdAt が空文字', { createdAt: '' }],
        ['createdAt が欠損', { createdAt: undefined }],
        ['sourceTemplateVersion が型違い', { sourceTemplateVersion: 'v2' }],
      ])('2xx でも %s の応答は不明として記録する', async (_name, override) => {
        // duplicatedFileId だけ見ていた頃は、workspaceId が欠損・型違い・
        // 別ワークスペースでも成功として扱い、その値がそのまま応答と
        // テレメトリの帰属先になっていた（PR #117 の Codex 指摘）
        mockJsonOnce(detailFixture);
        mockJsonOnce({ ...duplicationFixture, ...override }, 201);
        const onCopied = jest.fn();

        const result = await handleCopyGalleryTemplate(
          { slug: 'invoice-basic' },
          { onCopied },
        );

        expect(result.content[0].text).toContain('作成されたかは不明');
        expect(onCopied).toHaveBeenCalledWith({
          slug: 'invoice-basic',
          success: false,
          outcomeUnknown: true,
          slugVerified: true,
        });
      });

      it('2xx だが契約外の payload は不明として記録する', async () => {
        mockJsonOnce(detailFixture);
        mockJsonOnce({}, 201); // duplicatedFileId キーごと無い
        const onCopied = jest.fn();

        const result = await handleCopyGalleryTemplate(
          { slug: 'invoice-basic' },
          { onCopied },
        );

        expect(result.content[0].text).toContain('作成されたかは不明');
        expect(onCopied).toHaveBeenCalledWith({
          slug: 'invoice-basic',
          success: false,
          outcomeUnknown: true,
          slugVerified: true,
        });
      });

      it('契約どおりの duplicatedFileId: null は失敗確定のまま', async () => {
        mockJsonOnce(detailFixture);
        mockJsonOnce({ ...duplicationFixture, duplicatedFileId: null }, 201);
        const onCopied = jest.fn();

        await handleCopyGalleryTemplate(
          { slug: 'invoice-basic' },
          { onCopied },
        );

        expect(onCopied).toHaveBeenCalledWith({
          slug: 'invoice-basic',
          success: false,
          slugVerified: true,
        });
      });

      it('複製 POST 失敗時は slugVerified を立てる（実在確認は通っている）', async () => {
        mockJsonOnce(detailFixture);
        mockFetch.mockRejectedValueOnce(new Error('Request timed out'));
        const onCopied = jest.fn();

        await handleCopyGalleryTemplate(
          { slug: 'invoice-basic' },
          { onCopied },
        );

        expect(onCopied).toHaveBeenCalledWith({
          slug: 'invoice-basic',
          success: false,
          outcomeUnknown: true,
          slugVerified: true,
        });
      });

      it('実在確認より前の失敗では slugVerified を立てない', async () => {
        mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
        const onCopied = jest.fn();

        await handleCopyGalleryTemplate(
          { slug: 'invoice-basic' },
          { onCopied },
        );

        expect(onCopied).toHaveBeenCalledWith({
          slug: 'invoice-basic',
          success: false,
        });
      });

      it.each(indeterminateCases)('$name', async ({ arrange }) => {
        arrange();
        const onCopied = jest.fn();

        const result = await handleCopyGalleryTemplate(
          { slug: 'invoice-basic' },
          { onCopied },
        );

        expect(result.isError).toBe(true);
        expect(onCopied).toHaveBeenCalledTimes(1);
        expect(onCopied).toHaveBeenCalledWith({
          slug: 'invoice-basic',
          success: false,
          outcomeUnknown: true,
          // step 2 の実在確認は通っているので、slug は公開識別子と証明済み
          slugVerified: true,
        });
      });

      const determinateCases: ReadonlyArray<{
        readonly name: string;
        readonly arrange: () => void;
      }> = [
        {
          name: '404（サーバーが応答している）',
          arrange: () => {
            mockJsonOnce(detailFixture);
            mockJsonOnce({ message: 'not found' }, 404);
          },
        },
        {
          name: '412（ガードが入口で弾いており複製処理は動いていない）',
          arrange: () => {
            mockJsonOnce(detailFixture);
            mockJsonOnce({ message: 'app-key required' }, 412);
          },
        },
        {
          name: '429（プラン上限。作成前に弾かれている）',
          arrange: () => {
            mockJsonOnce(detailFixture);
            mockJsonOnce({ message: 'デザイン数が上限に達しています' }, 429);
          },
        },
        {
          name: 'duplicatedFileId が無い（デザインが作られなかったことは確定）',
          arrange: () => {
            mockJsonOnce(detailFixture);
            mockJsonOnce(
              { ...duplicationFixture, duplicatedFileId: null },
              201,
            );
          },
        },
        {
          name: '複製前のテンプレート確認に失敗（書き込みへ進んでいない）',
          arrange: () =>
            mockFetch.mockRejectedValueOnce(new TypeError('fetch failed')),
        },
      ];

      it.each(determinateCases)(
        '$name は失敗確定として記録する（キーを付けない）',
        async ({ name, arrange }) => {
          arrange();
          const onCopied = jest.fn();

          const result = await handleCopyGalleryTemplate(
            { slug: 'invoice-basic' },
            { onCopied },
          );

          expect(result.isError).toBe(true);
          expect(onCopied).toHaveBeenCalledTimes(1);
          const observation = onCopied.mock.calls[0][0] as Record<
            string,
            unknown
          >;
          expect(observation['slug']).toBe('invoice-basic');
          expect(observation['success']).toBe(false);
          expect(observation['outcomeUnknown']).toBeUndefined();
          // 実在確認を通った経路だけ slugVerified が付く
          expect(observation['slugVerified']).toBe(
            name.startsWith('複製前のテンプレート確認に失敗')
              ? undefined
              : true,
          );
        },
      );

      // 文言とフラグは同じ分岐から出しているが、片方だけ増やされたときに黙って
      // ずれないよう、対応そのものを固定する。
      //
      // 判定に使うのは特定の言い回しではなく **`list_templates` への誘導の有無**。
      // このツールが `list_templates`（＝自分のワークスペースのデザイン一覧）を
      // 見るよう促すのは「複製されているかもしれないので確かめろ」という一点で、
      // 書き込みが起きていないと確定している分岐は promptしない
      // （404 は `search_gallery_templates` へ誘導する）。
      //
      // 「完了したかは不明」という字面だけを見ていたときは、同じ欠陥を持つ 5xx
      // 分岐（文言は『既に作成されていないか確認してください』）を取りこぼした
      // （developer-docs PR #175 の Codex 指摘）。誘導の有無で見れば漏れない。
      it('list_templates での確認を促した呼び出しと outcomeUnknown が一致する', async () => {
        const cases = [
          ...indeterminateCases.map((c) => ({ ...c, expected: true })),
          ...determinateCases.map((c) => ({ ...c, expected: false })),
        ];
        for (const { name, arrange, expected } of cases) {
          jest.clearAllMocks();
          authMock.getAuthWorkspaceId.mockResolvedValue('ws-jwt-1');
          arrange();
          const onCopied = jest.fn();

          const result = await handleCopyGalleryTemplate(
            { slug: 'invoice-basic' },
            { onCopied },
          );

          const promptsForCheck =
            result.content[0].text.includes('list_templates');
          const observation = onCopied.mock.calls[0][0] as {
            outcomeUnknown?: boolean;
          };
          // 期待値そのものと、文言との一致の両方を見る（片方だけだと、両方を
          // 同時に間違えたときに素通りする）
          expect({ name, promptsForCheck }).toEqual({
            name,
            promptsForCheck: expected,
          });
          expect({
            name,
            unknown: observation.outcomeUnknown === true,
          }).toEqual({ name, unknown: expected });
        }
      });
    });
  });
});
