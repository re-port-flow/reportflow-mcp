import { fetchJson, HttpError } from './http.js';
import { requestWithAuth } from './auth.js';
import { REPORTFLOW_OAUTH_ISSUER_URL } from './config.js';

// ─── Base URL ─────────────────────────────────────────────────────────────────
//
// 公開ギャラリー API とテンプレート複製 API は reposts-api 側にあり、OAuth
// Authorization Server と同じホスト + パスプレフィックス
// (https://{stg.}re-port-flow.com/api/v1) で配信される。content-service
// (REPORTFLOW_API_BASE_URL) とはホストが異なるため、auth.ts と同じ
// REPORTFLOW_AUTH_URL env override に従わせる (stdio でステージングへ向けた
// 場合にトークン発行元と API 呼び出し先が食い違わないようにする)。
// 末尾スラッシュは除去する (auth.ts はスラッシュ付き設定も許容するため、
// そのまま連結すると /api/v1//public/... の二重スラッシュになる)。
export const getMainApiBaseUrl = (): string =>
  (process.env['REPORTFLOW_AUTH_URL'] ?? REPORTFLOW_OAUTH_ISSUER_URL).replace(
    /\/+$/,
    '',
  );

// ─── app-key ヘッダー ─────────────────────────────────────────────────────────
//
// reposts-api の @DefaultController は VerifyVersion ガードを付与し、`app-key`
// ヘッダーが無いリクエストを 412 Precondition Failed で門前払いする
// (common/guards/verify-version.guard.ts + common/header/req-header.ts)。
// 複製 API は @DefaultController 配下 (template.controller.ts の
// `@DefaultController('/:workspaceId/my/templates')`) のため、このヘッダーが
// 無いと複製処理へ到達すらしない (PRJ-3-1245)。
//
// ガードは値を検証しない (ReqHeader は @IsDefined @IsString @IsNotEmpty のみで、
// バージョン照合は行わない) ため、非空文字列であれば通る。既定値はサーバー側
// アクセスログでの識別に使えるよう OAuth の client_id と同じ 'reportflow-mcp'
// とし、CDN / WAF が別の値を要求する場合に備えて env で差し替え可能にする
// (auth.ts の REPORTFLOW_CLIENT_ID と同じ上書き方式)。
//
// 空文字を送ると @IsNotEmpty で再び 412 になるため、env が空・空白のみの場合は
// 既定値へフォールバックする。
const DEFAULT_APP_KEY = 'reportflow-mcp';

export const getAppKey = (): string =>
  process.env['REPORTFLOW_APP_KEY']?.trim() || DEFAULT_APP_KEY;

// ─── Types ────────────────────────────────────────────────────────────────────
//
// reposts-api GET /public/templates 系のレスポンス
// (applications/domain/entity/published-template.entity.ts と対応。
//  MCP で使うフィールドのみ型付けする)

export type GalleryTemplateItem = {
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[] | null;
  thumbnailUrl: string | null;
  duplicateCount: number;
  version: number;
  updatedAt: string;
};

export type GalleryTemplateListResponse = {
  items: GalleryTemplateItem[];
  nextCursor: string | null;
  total: number;
};

export type GalleryTemplateDetail = GalleryTemplateItem & {
  ownerName: string | null;
  createdAt: string;
};

/** ギャラリーに slug が存在しない (実 404 と CDN フォールバックの両方を包含) */
export class GalleryTemplateNotFoundError extends Error {
  constructor(slug: string) {
    super(`ギャラリーにテンプレート slug="${slug}" が見つかりません`);
    this.name = 'GalleryTemplateNotFoundError';
  }
}

// ─── Public Gallery API (認証不要) ────────────────────────────────────────────

export type ListGalleryTemplatesParams = {
  category?: string;
  cursor?: string;
  /** サーバー側の上限は 100 (TemplateListReq の Max(100)) */
  limit?: number;
  sort?: 'newest' | 'popular';
};

/**
 * 公開テンプレート一覧を取得する。認証ヘッダは付けない
 * (トークン未取得のユーザーでも使えることに価値がある)。
 */
export const listGalleryTemplates = async (
  params: ListGalleryTemplatesParams = {},
): Promise<GalleryTemplateListResponse> => {
  const url = new URL(`${getMainApiBaseUrl()}/public/templates`);
  if (params.category) url.searchParams.set('category', params.category);
  if (params.cursor) url.searchParams.set('cursor', params.cursor);
  if (params.limit != null) {
    url.searchParams.set('limit', String(params.limit));
  }
  if (params.sort) url.searchParams.set('sort', params.sort);
  return fetchJson<GalleryTemplateListResponse>(url.toString(), {
    headers: { Accept: 'application/json' },
  });
};

/**
 * テンプレート詳細を slug で取得する。認証ヘッダは付けない。
 *
 * 存在しない slug は GalleryTemplateNotFoundError にして投げる。
 * 注意: 本番/STG の CDN 経路は API の 404 を Web アプリの index.html
 * (200 + text/html) にフォールバックさせる (2026-08-08 stg 実測)。そのため
 * JSON parse 失敗 (SyntaxError) も「見つからない」として扱う。
 */
export const getGalleryTemplateBySlug = async (
  slug: string,
): Promise<GalleryTemplateDetail> => {
  const url = new URL(
    `${getMainApiBaseUrl()}/public/templates/${encodeURIComponent(slug)}`,
  );
  try {
    return await fetchJson<GalleryTemplateDetail>(url.toString(), {
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new GalleryTemplateNotFoundError(slug);
    }
    if (err instanceof SyntaxError) {
      // CDN が 404 を SPA の HTML (200) に差し替えた場合
      throw new GalleryTemplateNotFoundError(slug);
    }
    throw err;
  }
};

// ─── Template Duplicate API (Bearer 認証必須) ─────────────────────────────────

/**
 * 複製は snapshot からのファイル再構築 + S3 画像コピーを伴い PDF 生成より
 * 重くなり得るため、既定 (30s) より長いタイムアウトを明示する。
 * Anthropic Connectors Directory の handler 上限 300 秒よりは十分短くする。
 */
export const DUPLICATE_TIMEOUT_MS = 120_000;

/**
 * reposts-api POST /:workspaceId/my/templates/:slug/duplicate のレスポンス
 * (TemplateDuplicationEntity)。duplicatedFileId が複製されたデザインの ID
 * (MCP の designId と同一名前空間)。テンプレートのスナップショットデータが
 * 欠損している場合は null になり得る (複製ログのみ記録される)。
 */
export type DuplicateGalleryTemplateResponse = {
  id: string;
  templateId: string;
  templateSlug: string;
  userId: string;
  workspaceId: string;
  duplicatedFileId: string | null;
  sourceTemplateVersion: number | null;
  createdAt: string;
};

/**
 * ギャラリーテンプレートを認可済みワークスペースへ複製する。
 *
 * workspaceId はアクセストークン JWT の workspace_id を渡すこと (呼び出し側の
 * copy-gallery-template ツールが getAuthWorkspaceId() で解決する)。
 * - パスの workspaceId: JWTAuthGuard が JWT クレームとの一致を検査する
 * - body の workspaceId: 同じ値を明示送信する。API 側 (PRJ-3-1236) は JWT と
 *   不一致の body を 403 で拒否するが、body 必須だった旧 API に対しても
 *   同値送信なら安全に動くため、ロールアウト順に依存しない
 *
 * `app-key` は VerifyVersion ガード (@DefaultController 由来) の必須ヘッダー。
 * 欠落すると 412 で複製処理に到達しない (PRJ-3-1245)。
 */
export const duplicateGalleryTemplate = async (
  workspaceId: string,
  slug: string,
): Promise<DuplicateGalleryTemplateResponse> => {
  const url = new URL(
    `${getMainApiBaseUrl()}/${encodeURIComponent(workspaceId)}/my/templates/${encodeURIComponent(slug)}/duplicate`,
  );
  return requestWithAuth((headers) =>
    fetchJson<DuplicateGalleryTemplateResponse>(url.toString(), {
      method: 'POST',
      headers: {
        ...headers,
        'app-key': getAppKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ workspaceId }),
      timeoutMs: DUPLICATE_TIMEOUT_MS,
    }),
  );
};
