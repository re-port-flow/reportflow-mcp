import { z } from 'zod';
import {
  getGalleryTemplateBySlug,
  GalleryTemplateNotFoundError,
} from '../gallery-client.js';
import { HttpError } from '../http.js';

/**
 * 公開テンプレートギャラリーの詳細取得ツール (認証不要)。
 * search_gallery_templates で得た slug の詳細 (全文説明・版・作成者名等) を返す。
 */
export const getGalleryTemplateTool = {
  name: 'get_gallery_template',
  description:
    '公開テンプレートギャラリーのテンプレート詳細を slug で取得します（認証不要）。説明全文・カテゴリ・タグ・サムネイルURL・テンプレート版・複製実績数・作成者名を返します。slug は search_gallery_templates の結果から取得してください。重要: ギャラリーのテンプレートはまだワークスペースにありません。この slug では PDF 生成できないため、使う場合は copy_gallery_template で複製し、返された designId を get_design_parameters / generate_pdf_sync に渡してください。',
};

export const getGalleryTemplateInputSchema = {
  slug: z
    .string()
    .min(1)
    .describe(
      'テンプレートの slug（search_gallery_templates の結果に含まれる識別子）',
    ),
};

export type GetGalleryTemplateInput = {
  slug: string;
};

export type GetGalleryTemplateResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleGetGalleryTemplate = async (
  input: GetGalleryTemplateInput,
): Promise<GetGalleryTemplateResult> => {
  try {
    const detail = await getGalleryTemplateBySlug(input.slug);
    const payload = {
      slug: detail.slug,
      title: detail.title,
      description: detail.description,
      category: detail.category,
      tags: detail.tags,
      thumbnailUrl: detail.thumbnailUrl,
      duplicateCount: detail.duplicateCount,
      templateVersion: detail.version,
      ownerName: detail.ownerName,
      publishedAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (err) {
    if (err instanceof GalleryTemplateNotFoundError) {
      return {
        content: [
          {
            type: 'text',
            text: `エラー: ${err.message}。slug が正しいか search_gallery_templates で探し直してください。`,
          },
        ],
        isError: true,
      };
    }
    const message =
      err instanceof HttpError
        ? `ギャラリー API がエラーを返しました: ${err.message}`
        : `ギャラリー API に到達できませんでした: ${err instanceof Error ? err.message : String(err)}。HTTP エラー (404 等) ではなく接続自体が失敗しています。`;
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
