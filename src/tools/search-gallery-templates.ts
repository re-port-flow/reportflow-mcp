import { z } from 'zod';
import {
  listGalleryTemplates,
  GalleryTemplateItem,
} from '../gallery-client.js';
import { HttpError } from '../http.js';

/**
 * 公開テンプレートギャラリー (templates.re-port-flow.com 掲載分) の検索ツール。
 *
 * 既存の `search` / `list_templates` (ワークスペース内デザイン) とは対象が別:
 * こちらは「まだワークスペースに取り込んでいない」公開テンプレートを探す。
 * 公開 API のため認証不要 (トークン未取得でも呼べる)。
 *
 * 公開一覧 API にはテキスト検索パラメータが無い (category / tags / cursor /
 * limit / sort のみ。reposts-api TemplateListReq 実測) ため、ページを取得して
 * クライアント側で部分一致フィルタする。走査上限は MAX_SCAN 件で、超過時は
 * 「全件を見ていない」ことを戻り値に明示する (黙って切ると AI が誤認する)。
 */
export const searchGalleryTemplatesTool = {
  name: 'search_gallery_templates',
  description:
    '公開テンプレートギャラリーから、まだワークスペースに取り込んでいないテンプレートをキーワードで探します（認証不要）。タイトル・説明・タグ・カテゴリの部分一致で絞り込み、各候補の slug・title・description・category・tags・thumbnailUrl・duplicateCount を返します。ワークスペース内の既存デザインを探す場合はこのツールではなく list_templates / search を使ってください。重要: このツールが返す slug では PDF 生成できません。先に copy_gallery_template で自分のワークスペースへ複製し、返された designId を get_design_parameters / generate_pdf_sync に渡してください。',
};

/** 1 回の検索で走査する公開テンプレートの上限 (100 件/ページ × 3 ページ) */
const MAX_SCAN = 300;
/** サーバー側 (TemplateListReq) の 1 ページ上限 */
const PAGE_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** 一覧では description を切り詰める (詳細は get_gallery_template で取る) */
const DESCRIPTION_PREVIEW_LENGTH = 200;

export const searchGalleryTemplatesInputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      '検索キーワード（タイトル・説明・タグ・カテゴリの部分一致。1文字以上）',
    ),
  category: z
    .string()
    .optional()
    .describe('カテゴリ code で絞り込み（任意。例: "invoice", "other"）'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('返す最大件数（既定 20、上限 50。超過分は残り件数として通知）'),
};

export type SearchGalleryTemplatesInput = {
  query: string;
  category?: string;
  limit?: number;
};

export type SearchGalleryTemplatesResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

const matchesQuery = (item: GalleryTemplateItem, q: string): boolean => {
  const haystacks = [
    item.title,
    item.description,
    item.category,
    item.slug,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ];
  // API レスポンスは実行時には未検証のため、文字列以外 (null / 欠損) は
  // 落として比較する (クラッシュを「未到達」エラーに誤分類しない)
  return haystacks.some(
    (h) => typeof h === 'string' && h.toLowerCase().includes(q),
  );
};

const toListItem = (item: GalleryTemplateItem) => ({
  slug: item.slug,
  title: item.title,
  description:
    item.description != null &&
    item.description.length > DESCRIPTION_PREVIEW_LENGTH
      ? `${item.description.slice(0, DESCRIPTION_PREVIEW_LENGTH)}…`
      : item.description,
  category: item.category,
  tags: item.tags,
  thumbnailUrl: item.thumbnailUrl,
  duplicateCount: item.duplicateCount,
});

/** 接続失敗 (未到達) を HTTP エラー (404/500 等) と区別したメッセージにする */
const describeGalleryError = (err: unknown, toolLabel: string): string => {
  if (err instanceof HttpError) {
    return `ギャラリー API がエラーを返しました (${toolLabel}): ${err.message}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `ギャラリー API に到達できませんでした (${toolLabel}): ${message}。HTTP エラー (404 等) ではなく接続自体が失敗しています。時間を置いて再試行してください。`;
};

export const handleSearchGalleryTemplates = async (
  input: SearchGalleryTemplatesInput,
): Promise<SearchGalleryTemplatesResult> => {
  try {
    const q = input.query.trim().toLowerCase();
    const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    // 人気順で走査する (テンプレート 0 件の新規ユーザーに実績あるものを先に出す)
    const scanned: GalleryTemplateItem[] = [];
    let cursor: string | undefined = undefined;
    let total = 0;
    do {
      const page = await listGalleryTemplates({
        category: input.category,
        cursor,
        limit: PAGE_LIMIT,
        sort: 'popular',
      });
      // レスポンスは実行時には未検証。欠損時にクラッシュして「未到達」エラーに
      // 誤分類されないよう、形が想定外なら空ページとして扱う
      const items = Array.isArray(page.items) ? page.items : [];
      scanned.push(...items);
      total = typeof page.total === 'number' ? page.total : scanned.length;
      cursor =
        typeof page.nextCursor === 'string' && items.length > 0
          ? page.nextCursor
          : undefined;
    } while (cursor !== undefined && scanned.length < MAX_SCAN);

    const matched = scanned.filter((item) => matchesQuery(item, q));
    const items = matched.slice(0, limit).map(toListItem);

    const payload = {
      items,
      returnedCount: items.length,
      matchedCount: matched.length,
      // 切り詰めが起きたときに「他に N 件ある」ことを明示する
      remainingCount: matched.length - items.length,
      scannedCount: scanned.length,
      totalPublished: total,
      ...(cursor !== undefined
        ? {
            note: `公開テンプレートは全 ${total} 件ありますが、先頭 ${scanned.length} 件のみ検索しました。目的のものが無ければ query や category を変えて再検索してください。`,
          }
        : {}),
      ...(items.length === 0
        ? {
            hint: '該当するテンプレートがありませんでした。query を短くする・category を外すなど条件を緩めて再検索してください。',
          }
        : {}),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `エラー: ${describeGalleryError(err, 'search_gallery_templates')}`,
        },
      ],
      isError: true,
    };
  }
};
