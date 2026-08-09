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
  };
}

describe('handleSearchGalleryTemplates', () => {
  beforeEach(() => jest.clearAllMocks());

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
    expect(
      (init.headers as Record<string, string>)['app-key'],
    ).toBeUndefined();
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
      json: () => Promise.resolve({ items: [], nextCursor: 'c-loop', total: 10 }),
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
