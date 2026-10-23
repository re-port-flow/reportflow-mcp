import { z } from 'zod';
import {
  handleSearchGalleryTemplates,
  searchGalleryTemplatesInputSchema,
} from './search-gallery-templates';
import { GalleryTemplateItem } from '../gallery-client';

const mockFetch = jest.fn();
global.fetch = mockFetch;

function galleryItem(
  overrides: Partial<GalleryTemplateItem> & { slug: string },
): GalleryTemplateItem {
  return {
    title: overrides.slug,
    description: null,
    category: null,
    tags: [],
    thumbnailUrl: null,
    duplicateCount: 0,
    version: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockListResponse(
  items: GalleryTemplateItem[],
  { nextCursor = null as string | null, total = items.length } = {},
) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ items, nextCursor, total }),
  });
}

function parsePayload(result: { content: [{ type: 'text'; text: string }] }) {
  return JSON.parse(result.content[0].text) as {
    items: { slug: string; description: string | null }[];
    returnedCount: number;
    matchedCount: number;
    remainingCount: number;
    scannedCount: number;
    totalPublished: number;
    note?: string;
    hint?: string;
    templateSite?: { url: string; message: string };
  };
}

describe('handleSearchGalleryTemplates', () => {
  // `clearAllMocks` は呼び出し履歴しか消さず、**消費されなかった
  // `mockResolvedValueOnce` の待ち行列は次のテストへ持ち越される**。
  // 走査上限で打ち切るケースは意図的に消費しきらないので、これが無いと
  // 余った応答が次のテストの 1 ページ目になり、無関係なテストが落ちる
  // （セルフレビューで実際に踏んだ）。
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  it('正常系: タイトル部分一致でヒットし slug と title を返す', async () => {
    mockListResponse([
      galleryItem({ slug: 'invoice-basic', title: '請求書（標準）' }),
      galleryItem({ slug: 'invoice-en', title: '請求書（英語）' }),
      galleryItem({ slug: 'quote-basic', title: '見積書' }),
    ]);

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.items.map((i) => i.slug)).toEqual([
      'invoice-basic',
      'invoice-en',
    ]);
    expect(payload.matchedCount).toBe(2);
    expect(payload.remainingCount).toBe(0);
    // 公開ギャラリー API を認証ヘッダなしで呼ぶ
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/public/templates');
    expect(url).toContain('sort=popular');
    expect(
      (init.headers as Record<string, string>)['Authorization'],
    ).toBeUndefined();
    // PublicController 配下は VerifyVersion ガードの対象外。不要なヘッダーを
    // 増やさない (PRJ-3-1245 で複製 API にだけ app-key を足した)
    expect((init.headers as Record<string, string>)['app-key']).toBeUndefined();
  });

  it('正常系: タグ・カテゴリ・説明も検索対象になる', async () => {
    mockListResponse([
      galleryItem({ slug: 'a', title: 'A', tags: ['納品書'] }),
      galleryItem({ slug: 'b', title: 'B', category: 'delivery' }),
      galleryItem({ slug: 'c', title: 'C', description: '納品書テンプレ' }),
      galleryItem({ slug: 'd', title: 'D' }),
    ]);

    const result = await handleSearchGalleryTemplates({ query: '納品書' });

    const payload = parsePayload(result);
    expect(payload.items.map((i) => i.slug)).toEqual(['a', 'c']);
  });

  it('正常系: 0件でもエラーにせず件数と再検索ヒントを返す', async () => {
    mockListResponse([]);

    const result = await handleSearchGalleryTemplates({ query: 'nohit' });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.items).toEqual([]);
    expect(payload.matchedCount).toBe(0);
    expect(payload.hint).toContain('条件を緩めて');
  });

  // PRJ-3-2270: 0 件で行き止まりにせず、デザインを見て選べるサイトへ誘導する
  it('0件: 英語の汎用語で当たらないとき、テンプレートサイトのリンクを返す', async () => {
    mockListResponse([
      galleryItem({ slug: '0eUPGyiGX8uzwE8L', title: '請求書' }),
      galleryItem({ slug: '0eUPHHS3Iejd8Smr', title: '見積もり' }),
    ]);

    const result = await handleSearchGalleryTemplates({ query: 'report' });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.matchedCount).toBe(0);
    expect(payload.templateSite?.url).toBe(
      'https://templates.re-port-flow.com/templates',
    );
    // 案内文だけで次の操作 (詳細ページの slug → 複製) へ進めること
    expect(payload.templateSite?.message).toContain(
      'https://templates.re-port-flow.com/templates/{slug}',
    );
    expect(payload.templateSite?.message).toContain('copy_gallery_template');
    // 既存項目は変えない (追加のみ)
    expect(payload.hint).toBe(
      '該当するテンプレートがありませんでした。query を短くする・category を外すなど条件を緩めて再検索してください。',
    );
  });

  it('ヒットあり: テンプレートサイトの案内は付けず、応答の項目は従来どおり', async () => {
    mockListResponse([galleryItem({ slug: 'invoice-basic', title: '請求書' })]);

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    const payload = parsePayload(result);
    expect(Object.keys(payload)).toEqual([
      'items',
      'returnedCount',
      'matchedCount',
      'remainingCount',
      'scannedCount',
      'totalPublished',
    ]);
  });

  it('0件かつ走査打ち切り: 未走査の note とテンプレートサイトの案内を両方返す', async () => {
    // 「見ていない」ことと「サイトでは全件を見られる」ことは両立する
    const makePage = (prefix: string) =>
      Array.from({ length: 100 }, (_, i) =>
        galleryItem({ slug: `${prefix}-${i}`, title: `その他 ${i}` }),
      );
    mockListResponse(makePage('p1'), { nextCursor: 'c1', total: 500 });
    mockListResponse(makePage('p2'), { nextCursor: 'c2', total: 500 });
    mockListResponse(makePage('p3'), { nextCursor: 'c3', total: 500 });

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    const payload = parsePayload(result);
    expect(payload.matchedCount).toBe(0);
    expect(payload.note).toContain('先頭 300 件のみ検索しました');
    expect(payload.templateSite?.url).toBe(
      'https://templates.re-port-flow.com/templates',
    );
  });

  it('0件: staging ではステージングのテンプレートサイトを返す', async () => {
    // slug は環境ごとの公開一覧 API の値なので、案内先も同じ環境に揃える
    const originalNodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'staging';
    try {
      let handler: typeof handleSearchGalleryTemplates | undefined;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        handler = require('./search-gallery-templates')
          .handleSearchGalleryTemplates as typeof handleSearchGalleryTemplates;
      });
      mockListResponse([]);

      const result = await handler!({ query: 'report' });

      expect(parsePayload(result).templateSite?.url).toBe(
        'https://templates.stg.re-port-flow.com/templates',
      );
    } finally {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  it('境界: limit=999 は 50 にクリップされエラーにしない', async () => {
    const items = Array.from({ length: 80 }, (_, i) =>
      galleryItem({ slug: `invoice-${i}`, title: `請求書 ${i}` }),
    );
    mockListResponse(items);

    const result = await handleSearchGalleryTemplates({
      query: '請求',
      limit: 999,
    });

    const payload = parsePayload(result);
    expect(payload.returnedCount).toBe(50);
    expect(payload.matchedCount).toBe(80);
    expect(payload.remainingCount).toBe(30);
  });

  it('境界: 切り詰め発生時に残り件数を返す（黙って切らない）', async () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      galleryItem({ slug: `invoice-${i}`, title: `請求書 ${i}` }),
    );
    mockListResponse(items);

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    const payload = parsePayload(result);
    expect(payload.returnedCount).toBe(20); // 既定 limit
    expect(payload.matchedCount).toBe(60);
    expect(payload.remainingCount).toBe(40);
  });

  it('ページング: nextCursor がある間は追加取得して検索する（上限 300 件）', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      galleryItem({ slug: `p1-${i}`, title: `その他 ${i}` }),
    );
    const page2 = [galleryItem({ slug: 'p2-invoice', title: '請求書' })];
    mockListResponse(page1, { nextCursor: 'cursor-1', total: 101 });
    mockListResponse(page2, { nextCursor: null, total: 101 });

    const result = await handleSearchGalleryTemplates({ query: '請求書' });

    const payload = parsePayload(result);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain('cursor=cursor-1');
    expect(payload.items.map((i) => i.slug)).toEqual(['p2-invoice']);
    expect(payload.scannedCount).toBe(101);
  });

  it('ページング: 300 件走査した時点で打ち切り、未走査があることを note で伝える', async () => {
    const makePage = (prefix: string) =>
      Array.from({ length: 100 }, (_, i) =>
        galleryItem({ slug: `${prefix}-${i}`, title: `その他 ${i}` }),
      );
    mockListResponse(makePage('p1'), { nextCursor: 'c1', total: 500 });
    mockListResponse(makePage('p2'), { nextCursor: 'c2', total: 500 });
    mockListResponse(makePage('p3'), { nextCursor: 'c3', total: 500 });

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    const payload = parsePayload(result);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(payload.scannedCount).toBe(300);
    expect(payload.note).toContain('先頭 300 件のみ検索しました');
  });

  it('一覧の description は 200 文字で切り詰める', async () => {
    mockListResponse([
      galleryItem({
        slug: 'long-desc',
        title: '請求書',
        description: 'あ'.repeat(300),
      }),
    ]);

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    const payload = parsePayload(result);
    expect(payload.items[0].description).toHaveLength(201); // 200 + 省略記号
    expect(payload.items[0].description?.endsWith('…')).toBe(true);
  });

  it('堅牢性: レスポンスの形が想定外（items 欠損）でもクラッシュせず 0 件として返す', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({}),
    });

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.items).toEqual([]);
    expect(payload.scannedCount).toBe(0);
  });

  it('堅牢性: nextCursor が返り続けても items が空なら打ち切る（無限ループ防止）', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () =>
        Promise.resolve({ items: [], nextCursor: 'c-loop', total: 10 }),
    });

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    expect(result.isError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('入力検証: query 空文字は zod で弾く', () => {
    const schema = z.object(searchGalleryTemplatesInputSchema);
    expect(schema.safeParse({ query: '' }).success).toBe(false);
    expect(schema.safeParse({ query: '請' }).success).toBe(true);
  });

  it('異常系: API 500 はスタックトレースを含まない読みやすいエラーにする', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({ message: 'internal error' }),
    });

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'ギャラリー API がエラーを返しました',
    );
    expect(result.content[0].text).toContain('[500]');
    expect(result.content[0].text).not.toContain('at '); // スタックトレースなし
  });

  it('異常系: 接続失敗は「到達できなかった」と HTTP エラーを区別して返す', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('到達できませんでした');
    expect(result.content[0].text).toContain('接続自体が失敗');
  });
});

// --------------------------------------------------------------------------
// 検索需要テレメトリ (PRJ-3-1350)
// --------------------------------------------------------------------------
describe('handleSearchGalleryTemplates の需要テレメトリ', () => {
  // `clearAllMocks` は呼び出し履歴しか消さず、**消費されなかった
  // `mockResolvedValueOnce` の待ち行列は次のテストへ持ち越される**。
  // 走査上限で打ち切るケースは意図的に消費しきらないので、これが無いと
  // 余った応答が次のテストの 1 ページ目になり、無関係なテストが落ちる
  // （セルフレビューで実際に踏んだ）。
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  it('成功時: 実測の件数と生クエリを観測値として渡す', async () => {
    mockListResponse(
      [
        galleryItem({ slug: 'invoice-basic', title: '請求書（標準）' }),
        galleryItem({ slug: 'quote-basic', title: '見積書' }),
      ],
      { total: 42 },
    );
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: ' 請求 ' }, { onSearched });

    expect(onSearched).toHaveBeenCalledTimes(1);
    expect(onSearched).toHaveBeenCalledWith({
      success: true,
      // 正規化は telemetry 側の責務。ハンドラは受け取った生の値を渡す
      query: ' 請求 ',
      matchedCount: 1,
      scannedCount: 2,
      totalPublished: 42,
      // 【仕様変更 / PR #117】この fixture は 2 件返して total: 42・nextCursor: null、
      // つまり 40 件を一度も見ていない。以前はこれを完走した成功として記録して
      // いたため、`matchedCount: 0` の行が「探したが無かった」需要と区別できな
      // かった (Codex 指摘)。打ち切りは理由を問わずこの旗で表す。
      scanIncomplete: true,
    });
  });

  it('成功時: 観測値の件数が応答 payload と一致する', async () => {
    mockListResponse([
      galleryItem({ slug: 'invoice-a', title: '請求書A' }),
      galleryItem({ slug: 'invoice-b', title: '請求書B' }),
      galleryItem({ slug: 'quote', title: '見積書' }),
    ]);
    const onSearched = jest.fn();

    const result = await handleSearchGalleryTemplates(
      { query: '請求' },
      { onSearched },
    );
    const payload = parsePayload(result);

    const observation = onSearched.mock.calls[0][0] as {
      matchedCount: number;
      scannedCount: number;
      totalPublished: number;
    };
    expect(observation.matchedCount).toBe(payload.matchedCount);
    expect(observation.scannedCount).toBe(payload.scannedCount);
    expect(observation.totalPublished).toBe(payload.totalPublished);
  });

  it('空白のみのクエリでは需要イベントを送らない', async () => {
    // z.string().min(1) は通るが、検索側は trim して '' にするため
    // includes('') が全件に一致し、「キーワード無しの呼び出し」が
    // ギャラリー全件ヒットの需要として記録される（PR #117 の Codex 指摘）
    mockListResponse([galleryItem({ slug: 'a', title: '請求書' })]);
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: '   ' }, { onSearched });

    expect(onSearched).not.toHaveBeenCalled();
  });

  it('契約外のページ（items が配列でない）は失敗として記録する', async () => {
    // 空ページとして扱ったうえで success:true / matchedCount:0 を送ると、
    // 上流のスキーマ崩れが**未充足需要**に化ける（PR #117 の Codex 指摘）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ items: null, nextCursor: null, total: 0 }),
    });
    const onSearched = jest.fn();

    const result = await handleSearchGalleryTemplates(
      { query: '請求書' },
      { onSearched },
    );

    // 応答自体はこれまでどおり成功（空ヒット）で返す
    expect(result.isError).toBeUndefined();
    expect(onSearched).toHaveBeenCalledWith({
      success: false,
      query: '請求書',
      errorClass: 'MalformedGalleryPage',
    });
  });

  it.each([
    ['total が数値でない', { items: [], nextCursor: null, total: '0' }],
    ['total が負', { items: [], nextCursor: null, total: -1 }],
    ['total が整数でない', { items: [], nextCursor: null, total: 1.5 }],
    ['total が NaN', { items: [], nextCursor: null, total: Number.NaN }],
    [
      'nextCursor が文字列でも null でもない',
      { items: [], nextCursor: 7, total: 0 },
    ],
  ])('%s ページも失敗として記録する', async (_name, body) => {
    // items だけ見て total / nextCursor の契約違反を見逃すと、totalPublished に
    // 別物が入った行や走査を途中で止めた行が「正常な観測」として残る（セルフレビュー）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
    });
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: '請求書' }, { onSearched });

    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'MalformedGalleryPage',
    });
  });

  it('要求上限を超える件数を返すページは切り詰め、走査上限を破らない', async () => {
    // 個々の要素は全て有効なので要素側の検査は通る。件数と要求上限の**関係**を
    // 見ていなかったため、301 件のページがそのまま積まれて scannedCount が
    // 走査上限 300 を超えていた（PR #117 の Codex 指摘）
    const oversized = Array.from({ length: 301 }, (_v, index) =>
      galleryItem({ slug: `over-${index}`, title: `請求書 ${index}` }),
    );
    mockListResponse(oversized, { nextCursor: null, total: 301 });
    const onSearched = jest.fn();

    const result = await handleSearchGalleryTemplates(
      { query: '請求書' },
      { onSearched },
    );
    const payload = parsePayload(result);

    expect(payload.scannedCount).toBe(100);
    expect(payload.note).toContain('先頭 100 件');
    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'MalformedGalleryPage',
    });
  });

  it('返した件数より小さい total は採用しない（矛盾した需要データを作らない）', async () => {
    // total: 0 で 1 件返すページ。型としては非負整数なので単体検査は通るが、
    // scannedCount > totalPublished という成立しない観測になる（PR #117 の Codex 指摘）
    mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
      nextCursor: null,
      total: 0,
    });
    const onSearched = jest.fn();

    const result = await handleSearchGalleryTemplates(
      { query: '請求書' },
      { onSearched },
    );
    const payload = parsePayload(result);

    expect(payload.totalPublished).toBe(1);
    expect(payload.scannedCount).toBeLessThanOrEqual(payload.totalPublished);
    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'MalformedGalleryPage',
    });
  });

  it('ページをまたいだ累計より小さい total も採用しない', async () => {
    // 1 ページ目だけ見て検査すると通ってしまう形（2 ページ目の total が
    // 累計 2 件を下回る）。関係は**累計**で見る（セルフレビュー）
    mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
      nextCursor: 'c1',
      total: 10,
    });
    mockListResponse([galleryItem({ slug: 'b', title: '請求書' })], {
      nextCursor: null,
      total: 1,
    });
    const onSearched = jest.fn();

    const result = await handleSearchGalleryTemplates(
      { query: '請求書' },
      { onSearched },
    );
    const payload = parsePayload(result);

    expect(payload.scannedCount).toBe(2);
    expect(payload.totalPublished).toBe(2);
    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'MalformedGalleryPage',
    });
  });

  // **応答の数値どうしの関係を 1 か所で固定する。** 形ごとにテストを足していく
  // 限り、列挙していない組み合わせで矛盾した需要データが出る余地が残り続ける
  // （PR #117 の Codex 指摘は「その組み合わせは列挙に無い」型が繰り返された）。
  // ケースが増えても、この不変条件を破ったらここで落ちる。
  it.each([
    [
      '要求上限超え',
      () => {
        mockListResponse(
          Array.from({ length: 301 }, (_v, index) =>
            galleryItem({ slug: `over-${index}`, title: '請求書' }),
          ),
          { total: 301 },
        );
      },
    ],
    [
      'total が実測より小さい',
      () => {
        mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
          total: 0,
        });
      },
    ],
    [
      'total が負',
      () => {
        mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
          total: -5,
        });
      },
    ],
    [
      'total が巨大',
      () => {
        mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
          total: Number.MAX_SAFE_INTEGER,
        });
      },
    ],
    [
      'カーソルがあるのに空ページ',
      () => {
        mockListResponse([], { nextCursor: 'c1', total: 50 });
      },
    ],
    [
      '同じカーソルの再提示',
      () => {
        mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
          nextCursor: 'same',
          total: 100,
        });
        mockListResponse([galleryItem({ slug: 'b', title: '請求書' })], {
          nextCursor: 'same',
          total: 100,
        });
      },
    ],
    [
      '走査上限で打ち切ってもカーソルが残る',
      () => {
        // 3 ページ = MAX_SCAN。**消費しきる分だけ積む**（余らせると次の
        // テストの 1 ページ目に化ける。beforeEach の mockReset 参照）
        for (const prefix of ['p1', 'p2', 'p3']) {
          mockListResponse(
            Array.from({ length: 100 }, (_v, index) =>
              galleryItem({ slug: `${prefix}-${index}`, title: '請求書' }),
            ),
            { nextCursor: `${prefix}-next`, total: 1000 },
          );
        }
      },
    ],
  ])('%s でも応答の数値は互いに矛盾しない', async (_name, arrange) => {
    arrange();

    const payload = parsePayload(
      await handleSearchGalleryTemplates({ query: '請求書' }),
    );

    expect(payload.returnedCount).toBe(payload.items.length);
    expect(payload.returnedCount).toBeGreaterThanOrEqual(0);
    expect(payload.matchedCount).toBeGreaterThanOrEqual(payload.returnedCount);
    expect(payload.scannedCount).toBeGreaterThanOrEqual(payload.matchedCount);
    expect(payload.totalPublished).toBeGreaterThanOrEqual(payload.scannedCount);
    // 走査上限 (MAX_SCAN)。ページ側の申告で破られてはならない
    expect(payload.scannedCount).toBeLessThanOrEqual(300);
    expect(payload.remainingCount).toBe(
      payload.matchedCount - payload.returnedCount,
    );
  });

  it('サーバーが終了を宣言したのに未走査が残るなら未完走として記録する', async () => {
    // nextCursor: null（＝次は無い）と total: 2 が両立しない。以前は
    // total も cursor も単体では妥当なので完走した成功として記録し、note も
    // 出していなかった。実在するテンプレートが未充足需要に化ける（Codex 指摘）
    mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
      nextCursor: null,
      total: 2,
    });
    const onSearched = jest.fn();

    const result = await handleSearchGalleryTemplates(
      { query: '請求書' },
      { onSearched },
    );

    expect(parsePayload(result).note).toContain('先頭 1 件');
    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: true,
      scanIncomplete: true,
    });
  });

  it('完走した走査には未完走の旗を立てない', async () => {
    // 「未走査あり」を出すこと自体は簡単だが、常に出したら旗の意味が消える。
    // 完走（total === scannedCount）では旗も note も出ないことを固定する
    mockListResponse(
      [
        galleryItem({ slug: 'a', title: '請求書' }),
        galleryItem({ slug: 'b', title: '見積書' }),
      ],
      { nextCursor: null, total: 2 },
    );
    const onSearched = jest.fn();

    const result = await handleSearchGalleryTemplates(
      { query: '請求書' },
      { onSearched },
    );

    expect(parsePayload(result).note).toBeUndefined();
    expect(onSearched.mock.calls[0][0]).not.toHaveProperty('scanIncomplete');
  });

  it.each([
    [
      '走査上限で打ち切り',
      () => {
        for (const prefix of ['p1', 'p2', 'p3']) {
          mockListResponse(
            Array.from({ length: 100 }, (_v, index) =>
              galleryItem({ slug: `${prefix}-${index}`, title: '見積書' }),
            ),
            { nextCursor: `${prefix}-next`, total: 1000 },
          );
        }
      },
    ],
    [
      'サーバーが終了を宣言したのに未走査',
      () => {
        mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
          nextCursor: null,
          total: 9,
        });
      },
    ],
  ])(
    '%s: 応答の note と観測値の scanIncomplete は必ず一致する',
    async (_name, arrange) => {
      // 別々の式で判定していた頃は、走査上限で終わった場合が note にだけ現れ
      // 観測値には出ていなかった（セルフレビュー）。同じ値から作ることで固定する
      arrange();
      const onSearched = jest.fn();

      const result = await handleSearchGalleryTemplates(
        { query: '請求書' },
        { onSearched },
      );
      const observation = onSearched.mock.calls[0][0];

      expect(parsePayload(result).note !== undefined).toBe(
        observation.scanIncomplete === true,
      );
      expect(observation.scanIncomplete).toBe(true);
    },
  );

  it('契約違反で打ち切った行は失敗として記録し、完全性の旗は載せない', async () => {
    // 空文字カーソルは「打ち切り」だが、同時にスキーマ崩れでもあるので失敗行に
    // なる。失敗行は件数を持たないので scanIncomplete も意味を持たない（型でも
    // `?: never`）。note は出るが観測値には出ない、が正しい状態
    mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
      nextCursor: '',
      total: 100,
    });
    const onSearched = jest.fn();

    const result = await handleSearchGalleryTemplates(
      { query: '請求書' },
      { onSearched },
    );

    expect(parsePayload(result).note).toBeDefined();
    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'MalformedGalleryPage',
    });
    expect(onSearched.mock.calls[0][0]).not.toHaveProperty('scanIncomplete');
  });

  it.each([
    ['U+200B のみ', '\u200B\u200B'],
    ['U+FEFF BOM のみ', '\uFEFF'],
    ['U+034F CGJ のみ', '\u034F'],
    ['空白と不可視の混在', ' \u200B \uFEFF '],
  ])(
    '%s のクエリは需要イベントを送らない（正規化後に空になる）',
    async (_name, query) => {
      // `trim()` では残るので通り抜け、`query: ''` の 0 件ヒット行が未充足需要
      // として積まれていた（PR #117 の Codex 指摘）。判定は生の入力ではなく
      // **実際に記録される値**で行う
      mockListResponse([galleryItem({ slug: 'a', title: '請求書' })]);
      const onSearched = jest.fn();

      await handleSearchGalleryTemplates({ query }, { onSearched });

      expect(onSearched).not.toHaveBeenCalled();
    },
  );

  it('正規化後に空になるクエリは失敗時も送らない', async () => {
    // 成功側だけに条件を置くと「API が落ちたときだけ記録される」状態になる
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: '\u200B' }, { onSearched });

    expect(onSearched).not.toHaveBeenCalled();
  });

  it('マスクで置き換わるだけのクエリは送る（空ではない）', async () => {
    // 「正規化後に空か」で判定するので、マスク結果が残る入力まで落とさない
    mockListResponse([galleryItem({ slug: 'a', title: '請求書' })]);
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates(
      { query: 'taro@example.com' },
      { onSearched },
    );

    expect(onSearched).toHaveBeenCalledTimes(1);
  });

  it('空白のみのクエリは失敗時も需要イベントを送らない', async () => {
    // 成功側だけに条件を置くと「API が落ちたときだけ記録される」という
    // 一貫しない状態になる（セルフレビュー）
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: '   ' }, { onSearched });

    expect(onSearched).not.toHaveBeenCalled();
  });

  it.each([
    ['空オブジェクト', [{}]],
    ['null 要素', [null]],
    [
      'tags が文字列配列でない',
      [
        {
          ...{},
          slug: 'a',
          title: 'A',
          description: null,
          category: null,
          tags: [1],
          thumbnailUrl: null,
          duplicateCount: 0,
          version: 1,
          updatedAt: 'x',
        },
      ],
    ],
  ])('items に %s が混ざるページも失敗として記録する', async (_name, items) => {
    // 配列であることだけ見ていると、matchesQuery の防御的な型チェックが
    // 「一致しない」に変え、スキーマ崩れが未充足需要に化ける（PR #117 の Codex 指摘）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ items, nextCursor: null, total: 1 }),
    });
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: '請求書' }, { onSearched });

    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'MalformedGalleryPage',
    });
  });

  it('nextCursor が空文字なら失敗として記録し、先頭ページを取り直さない', async () => {
    // 空文字は listGalleryTemplates が falsy として送信を省くため、次の要求が
    // 先頭ページの取り直しになり MAX_SCAN まで同じ結果を積み増す（PR #117 の Codex 指摘）
    mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
      nextCursor: '',
      total: 1,
    });
    const onSearched = jest.fn();

    const result = await handleSearchGalleryTemplates(
      { query: '請求' },
      { onSearched },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(parsePayload(result).scannedCount).toBe(1);
    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'MalformedGalleryPage',
    });
  });

  it('同じ nextCursor を返し続けても件数を水増ししない', async () => {
    // 空文字と同じく同一ページの積み増しになる（セルフレビュー）
    mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
      nextCursor: 'same',
      total: 100,
    });
    mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
      nextCursor: 'same',
      total: 100,
    });
    const onSearched = jest.fn();

    const result = await handleSearchGalleryTemplates(
      { query: '請求' },
      { onSearched },
    );

    // 1 回目の 'same' は使えるので 2 回取得し、2 回目の 'same' で打ち切る
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(parsePayload(result).scannedCount).toBe(2);
    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'MalformedGalleryPage',
    });
  });

  it.each([
    ['応答の根が null', null],
    ['応答の根が配列', []],
    ['応答の根が文字列', 'oops'],
  ])(
    '%s でも到達不能エラーにせず MalformedGalleryPage で記録する',
    async (_n, body) => {
      // 根のプロパティ参照で TypeError になり、catch 側の「到達できませんでした」へ
      // 落ちて errorClass も TypeError になっていた（PR #117 の Codex 指摘）
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(body),
      });
      const onSearched = jest.fn();

      const result = await handleSearchGalleryTemplates(
        { query: '請求書' },
        { onSearched },
      );

      expect(result.isError).toBeUndefined();
      expect(onSearched.mock.calls[0][0]).toMatchObject({
        success: false,
        errorClass: 'MalformedGalleryPage',
      });
    },
  );

  it.each([
    ['slug が空文字', { slug: '' }],
    ['duplicateCount が NaN', { duplicateCount: Number.NaN }],
    ['version が Infinity', { version: Number.POSITIVE_INFINITY }],
    ['updatedAt が空文字', { updatedAt: '' }],
    ['duplicateCount が負', { duplicateCount: -1 }],
    ['duplicateCount が整数でない', { duplicateCount: 1.5 }],
    ['version が負', { version: -1 }],
  ])(
    '型は満たすが値が不正な item（%s）も失敗として記録する',
    async (_n, over) => {
      // `typeof x === 'number'` は NaN を通し、空文字の識別子は型を満たす。
      // 型の網羅だけでは「使えない値」が正常な観測として通る（セルフレビュー）
      mockListResponse([galleryItem({ slug: 'a', title: '請求書', ...over })]);
      const onSearched = jest.fn();

      await handleSearchGalleryTemplates({ query: '請求' }, { onSearched });

      expect(onSearched.mock.calls[0][0]).toMatchObject({
        success: false,
        errorClass: 'MalformedGalleryPage',
      });
    },
  );

  it('複数ページのうち 1 ページでも契約外なら失敗として記録する', async () => {
    mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
      nextCursor: 'c1',
      total: 200,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () =>
        Promise.resolve({ items: undefined, nextCursor: null, total: 200 }),
    });
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: '請求' }, { onSearched });

    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'MalformedGalleryPage',
    });
  });

  it('category 未指定ならキー自体を渡さない', async () => {
    mockListResponse([galleryItem({ slug: 'invoice', title: '請求書' })]);
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: '請求' }, { onSearched });

    expect('category' in onSearched.mock.calls[0][0]).toBe(false);
  });

  it('カーソルがあるのに items が空のページは失敗として記録する', async () => {
    // 無限ループを避けて打ち切るが、未走査がある事実を残さないと
    // `success / matchedCount: 0` が未充足需要として記録される（PR #117 の Codex 指摘）
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ items: [], nextCursor: 'c1', total: 10 }),
    });
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: '請求' }, { onSearched });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'MalformedGalleryPage',
    });
  });

  it.each([
    ['空文字カーソル', ''],
    ['同じカーソルの再提示', 'c1'],
  ])(
    '%s で打ち切ったとき応答にも未走査の note を出す',
    async (_n, nextCursor) => {
      // sawMalformedPage はテレメトリ用でユーザー応答には出ない。これが無いと
      // 未走査があるのに note の無い通常の成功応答になる（PR #117 の Codex 指摘）
      mockListResponse([galleryItem({ slug: 'a', title: '請求書' })], {
        nextCursor: nextCursor === 'c1' ? 'c1' : '',
        total: 100,
      });
      if (nextCursor === 'c1') {
        mockListResponse([galleryItem({ slug: 'b', title: '請求書' })], {
          nextCursor: 'c1',
          total: 100,
        });
      }

      const result = await handleSearchGalleryTemplates({ query: '請求' });

      expect(parsePayload(result).note).toContain('のみ検索しました');
    },
  );

  it('category が空文字なら観測値に含めない', async () => {
    // listGalleryTemplates は falsy な category を送らないので、ここだけ載せると
    // 絞り込んでいない検索が「category 指定あり」として記録され、同じキーワードの
    // 行が空 category とそれ以外に分かれる（PR #117 の Codex 指摘）
    mockListResponse([galleryItem({ slug: 'invoice', title: '請求書' })]);
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates(
      { query: '請求', category: '' },
      { onSearched },
    );

    expect('category' in onSearched.mock.calls[0][0]).toBe(false);
  });

  it('category 指定時は観測値に含める', async () => {
    mockListResponse([galleryItem({ slug: 'invoice', title: '請求書' })]);
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates(
      { query: '請求', category: 'invoice' },
      { onSearched },
    );

    expect(onSearched.mock.calls[0][0]).toMatchObject({ category: 'invoice' });
  });

  it('0 件ヒットでも送出する（未充足需要の捕捉が主目的）', async () => {
    mockListResponse([galleryItem({ slug: 'quote', title: '見積書' })]);
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates(
      { query: '建設業 請求書' },
      { onSearched },
    );

    expect(onSearched).toHaveBeenCalledTimes(1);
    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: true,
      matchedCount: 0,
    });
  });

  it('異常系: HTTP エラーは success=false / errorClass=HttpError で件数を渡さない', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({ message: 'internal error' }),
    });
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: '請求' }, { onSearched });

    expect(onSearched).toHaveBeenCalledWith({
      success: false,
      query: '請求',
      errorClass: 'HttpError',
    });
  });

  it('異常系: 未到達は errorClass=TypeError で HTTP エラーと区別できる', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const onSearched = jest.fn();

    await handleSearchGalleryTemplates({ query: '請求' }, { onSearched });

    expect(onSearched.mock.calls[0][0]).toMatchObject({
      success: false,
      errorClass: 'TypeError',
    });
  });

  it('コールバックが throw しても成功応答が壊れない', async () => {
    mockListResponse([galleryItem({ slug: 'invoice', title: '請求書' })]);

    const result = await handleSearchGalleryTemplates(
      { query: '請求' },
      {
        onSearched: () => {
          throw new Error('telemetry down');
        },
      },
    );

    // 素で呼ぶとハンドラ本体の catch に落ち、成功検索がエラー応答に化ける
    expect(result.isError).toBeUndefined();
    expect(parsePayload(result).matchedCount).toBe(1);
  });

  it('コールバックが throw してもエラー応答の内容が変わらない', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await handleSearchGalleryTemplates(
      { query: '請求' },
      {
        onSearched: () => {
          throw new Error('telemetry down');
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('到達できませんでした');
  });

  it('deps 省略時は従来どおり動く（既存呼び出しの互換）', async () => {
    mockListResponse([galleryItem({ slug: 'invoice', title: '請求書' })]);

    const result = await handleSearchGalleryTemplates({ query: '請求' });

    expect(result.isError).toBeUndefined();
    expect(parsePayload(result).matchedCount).toBe(1);
  });
});
