import { z } from 'zod';
import {
  handleCopyGalleryTemplate,
  copyGalleryTemplateInputSchema,
} from './copy-gallery-template';

jest.mock('../auth', () => {
  class AuthRequiredError extends Error {
    readonly mode: 'stdio' | 'http';
    constructor(
      message = '再認証が必要です。',
      mode: 'stdio' | 'http' = 'stdio',
    ) {
      super(message);
      this.name = 'AuthRequiredError';
      this.mode = mode;
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
  ) => Error & { mode: 'stdio' | 'http' };
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
    expect(result.content[0].text).toContain('デザインは作成されませんでした');
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
});
