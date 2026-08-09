import { z } from 'zod';
import {
  handleGetGalleryTemplate,
  getGalleryTemplateInputSchema,
} from './get-gallery-template';

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
  ownerName: 'Re:port Flow 公式',
  createdAt: '2026-03-21T14:13:02.000Z',
  updatedAt: '2026-07-29T13:46:10.000Z',
};

describe('handleGetGalleryTemplate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('正常系: slug で詳細を取得し複製前提の情報を返す', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(detailFixture),
    });

    const result = await handleGetGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      slug: 'invoice-basic',
      title: '請求書（標準）',
      description: '請求書のテンプレートです',
      templateVersion: 2,
      ownerName: 'Re:port Flow 公式',
      publishedAt: '2026-03-21T14:13:02.000Z',
    });
    // 公開 API を認証ヘッダなしで呼ぶ / slug は URL エンコードされる
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/public/templates/invoice-basic');
    expect(
      (init.headers as Record<string, string>)['Authorization'],
    ).toBeUndefined();
    // PublicController 配下は VerifyVersion ガードの対象外。不要なヘッダーを
    // 増やさない (PRJ-3-1245 で複製 API にだけ app-key を足した)
    expect(
      (init.headers as Record<string, string>)['app-key'],
    ).toBeUndefined();
  });

  it('異常系: JSON 404 は「見つからない」+ 検索やり直しの誘導を返す', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: () => Promise.resolve({ message: 'not found' }),
    });

    const result = await handleGetGalleryTemplate({ slug: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'slug="nope" が見つかりません',
    );
    expect(result.content[0].text).toContain('search_gallery_templates');
  });

  it('異常系: CDN が 404 を SPA の HTML(200) に差し替えた場合も「見つからない」として扱う', async () => {
    // stg 実測 (2026-08-08): 未知の slug は 200 + text/html が返り
    // res.json() が SyntaxError を投げる
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () =>
        Promise.reject(
          new SyntaxError(`Unexpected token '<', "<!DOCTYPE "...`),
        ),
    });

    const result = await handleGetGalleryTemplate({ slug: 'ghost' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('slug="ghost" が見つかりません');
  });

  it('異常系: API 500 は HTTP エラーとして返し、接続失敗と区別する', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({ message: 'boom' }),
    });

    const result = await handleGetGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'ギャラリー API がエラーを返しました',
    );
  });

  it('異常系: 接続失敗は「到達できなかった」と返す（404 と混同しない）', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await handleGetGalleryTemplate({ slug: 'invoice-basic' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('到達できませんでした');
    expect(result.content[0].text).not.toContain('見つかりません');
  });

  it('入力検証: slug 空文字は zod で弾く', () => {
    const schema = z.object(getGalleryTemplateInputSchema);
    expect(schema.safeParse({ slug: '' }).success).toBe(false);
    expect(schema.safeParse({ slug: 'invoice-basic' }).success).toBe(true);
  });
});
