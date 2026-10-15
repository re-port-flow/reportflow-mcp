import {
  fetchJson,
  fetchJsonWithHeaders,
  fetchBinary,
  fetchBinaryWithHeaders,
  fetchHeadersOnly,
} from './http.js';
import { requestWithAuth } from './auth.js';
import { REPORTFLOW_API_BASE_URL } from './config.js';
import { saveTempFile } from './file-helper.js';

// HTTP モード (claude.ai 等のリモート接続) では config.ts の固定 URL を使う。
// stdio モードでは従来通り REPORTFLOW_API_BASE_URL env override も許容する。
const getBaseUrl = () =>
  process.env['REPORTFLOW_API_BASE_URL'] ?? REPORTFLOW_API_BASE_URL;

/**
 * 同期生成 (`/v1/file/sync/single` / `/v1/file/sync/multiple`) だけに使うタイムアウト。
 *
 * API の同期生成は 60 秒でタイムアウトする (下記の ALB)。`http.ts` の既定 30 秒のままだと、
 * 30〜60 秒かかる正当な生成を MCP 側が先に打ち切り、**PDF は生成され (ページも
 * 消費され) たのに失敗として返る**。API 側の 504 を MCP が先に受け取れるよう、
 * それより十分長い 125 秒にしている (旧来の公開値 120 秒 + 余裕 5 秒のまま)。
 * 他の呼び出し (一覧・パラメータ取得・ダウンロード等) は 30 秒のまま。
 *
 * 125 秒より手前で切れうる経路 (この値を延ばしても効かない区間):
 * - MCP クライアント側: `@modelcontextprotocol/client` の既定リクエストタイムアウトは
 *   60 秒 (`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`、node_modules で確認)。既定のまま
 *   のクライアントは 60 秒で tools/call を諦める。各クライアントの実設定は未検証。
 * - リモート (Cloudflare Worker → Container): `wrangler.jsonc` / `cloudflare/index.ts`
 *   にリクエスト時間の設定は無い。Container からの外向き fetch は Node の fetch で、
 *   Workers のサブリクエスト制限を受ける経路かどうかは未検証。
 * - API 側: api.re-port-flow.com の経路 (Cloudflare → ALB) の本番 ALB
 *   (prod-report-flow-alb) の idle timeout は 60 秒 (2026-10-02 に
 *   `aws elbv2 describe-load-balancer-attributes` で確認)。60 秒を超える同期生成は 504 になる。
 * いずれも MCP 側で 30 秒に縮める理由にはならない (縮めると上の誤失敗が確実に起きる)。
 */
export const SYNC_GENERATION_TIMEOUT_MS = 125_000;

// ─── Types ────────────────────────────────────────────────────────────────────

// リーフ項目のオブジェクトは name・type・label を持ち、作成者が設定した場合は
// 各フィールドの意味・入力ガイドを表す任意の description（文字列）も含む。
// content-service がスキーマに透過するため、MCP はそのまま中継して AI に届ける。
export type DesignParameter =
  | string
  | Record<string, string>
  | Array<Record<string, string>>;

export type GetDesignParametersResponse = Record<string, DesignParameter>;

export type ContentParam = Record<string, unknown>;

/**
 * 共有タイプ (リクエスト側): 数値コード。
 * - '01' = ワークスペース内共有 (デフォルト)
 * - '02' = 招待者共有
 * - '03' = 公開URL共有
 *
 * 参照: developer-docs/openapi/content-service.yaml shareType (request)
 */
export type ShareTypeCode = '01' | '02' | '03';

/**
 * 共有タイプ (レスポンス側): 人間可読な名前で返ってくる。
 *
 * 参照: developer-docs/openapi/content-service.yaml shareType (response)
 */
export type ShareTypeName = 'workspace' | 'invited' | 'public';

export type ContentDto = {
  fileName: string;
  shareType?: ShareTypeCode;
  passcodeEnabled?: boolean;
  params: ContentParam;
  /**
   * Webhook 通知・X-File-Mapping ヘッダーへの透過メタデータ。
   * トップレベルの string/number 値は生成 PDF の XMP メタデータにも
   * 埋め込まれる (content-service PRJ-3-1007)。
   */
  passthrough?: Record<string, unknown>;
};

export type ShareInfo = {
  shareType: ShareTypeName;
  passcodeEnabled: boolean;
};

export type FileItem = {
  fileName: string;
  fileId: string;
  params: ContentParam;
  share: ShareInfo;
};

export type ExportResponse = {
  requestId: string;
  url: string;
  files?: FileItem[];
};

export type DesignItem = {
  id: string;
  label: string;
  latestVersion: number;
  thumbnail: string;
  updatedAt: string;
};

export type DesignListResponse = {
  designs: DesignItem[];
};

// ─── Content Service API ──────────────────────────────────────────────────────

export const getDesignParameters = async (
  designId: string,
  version?: number,
): Promise<GetDesignParametersResponse> => {
  const url = new URL(`/v1/file/design/parameter/${designId}`, getBaseUrl());
  if (version != null) {
    url.searchParams.set('version', String(version));
  }

  return requestWithAuth((headers) =>
    fetchJson<GetDesignParametersResponse>(url.toString(), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    }),
  );
};

/**
 * generate_pdf_sync の結果。
 * - data    : PDF バイト列 (stdio モードで saveTempFile に渡す)。HTTP モード (skipSave)
 *             では本文を取得しないため undefined。
 * - filePath: stdio モードで saveTempFile した場合の絶対パス。HTTP モードでは undefined。
 * - fileUrl : content-service の sync エンドポイントが返す `File-URL` ヘッダー。
 *             Web アプリの**出力履歴画面**の URL
 *             (`https://re-port-flow.com/{workspaceId}/templates/{designId}/outputs?requestId={requestId}`)。
 *             ファイルを直接ダウンロードする URL ではない (開くにはアプリへのログインが要る)。
 * - requestId: 同 `Request-Id` ヘッダー (16 文字の英数字。UUID ではない)。
 * - fileId  : 同 `X-File-Mapping` ヘッダー (URL encoded JSON 配列) の最初の要素の fileId。
 *
 * 参照: developer-docs/openapi/content-service.yaml
 *   /v1/file/sync/single → 200 ヘッダー (File-URL / Request-Id / X-File-Mapping)
 */
export type GeneratePdfSyncResult = {
  data?: ArrayBuffer;
  filePath?: string;
  fileUrl?: string;
  requestId?: string;
  fileId?: string;
};

type FileMappingItem = {
  fileId: string;
  fileName: string;
  share?: unknown;
  passthrough?: unknown;
};

/**
 * sync エンドポイントが返す `X-File-Mapping` ヘッダー (URL encoded JSON 配列) を
 * パースして配列を返す。失敗時は空配列。
 */
const parseFileMapping = (raw: string | null): FileMappingItem[] => {
  if (!raw) return [];
  try {
    const decoded = decodeURIComponent(raw);
    const parsed = JSON.parse(decoded) as FileMappingItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const generatePdfSync = async (body: {
  designId: string;
  version: number;
  content: ContentDto;
  /**
   * 指定された場合のみ saveTempFile してパスを返す (stdio モード用)。
   * HTTP モードでは未指定にする — サーバ filesystem に書いてもクライアント不可達。
   */
  outputDir?: string;
  /** true なら outputDir 指定の有無に関わらず保存しない (HTTP モード) */
  skipSave?: boolean;
  /**
   * `outputDir` を許可するルート集合 (MCP Roots 由来)。`saveTempFile` で
   * 検証に使う。stdio モードの呼び出し側 (server.ts) で `resolveAllowedRoots`
   * の結果を渡す。未指定なら `safe-paths.ts` の安全なデフォルトにフォールバック。
   */
  allowedRoots?: string[];
}): Promise<GeneratePdfSyncResult> => {
  const url = new URL('/v1/file/sync/single', getBaseUrl());
  const { outputDir, skipSave, allowedRoots, ...payload } = body;
  const requestInit = (
    headers: Record<string, string>,
  ): RequestInit & { timeoutMs: number } => ({
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: SYNC_GENERATION_TIMEOUT_MS,
  });

  // HTTP モード (skipSave): fileUrl だけ使うので PDF 本文はダウンロードしない。
  // sync エンドポイントはメタ情報をレスポンスヘッダーで返すため、ヘッダーのみ取得する。
  if (skipSave) {
    const headers = await requestWithAuth((authHeaders) =>
      fetchHeadersOnly(url.toString(), requestInit(authHeaders)),
    );
    return {
      fileUrl: headers.get('File-URL') ?? undefined,
      requestId: headers.get('Request-Id') ?? undefined,
      fileId: parseFileMapping(headers.get('X-File-Mapping'))[0]?.fileId,
    };
  }

  // stdio モード: 本文 (PDF バイト列) を取得してローカル保存する。
  const { data, headers } = await requestWithAuth((authHeaders) =>
    fetchBinaryWithHeaders(url.toString(), requestInit(authHeaders)),
  );

  const fileUrl = headers.get('File-URL') ?? undefined;
  const requestId = headers.get('Request-Id') ?? undefined;
  const fileId = parseFileMapping(headers.get('X-File-Mapping'))[0]?.fileId;

  const filePath = await saveTempFile(
    data,
    body.content.fileName,
    outputDir,
    allowedRoots ?? [],
  );
  return { data, filePath, fileUrl, requestId, fileId };
};

export const generatePdfAsync = async (body: {
  designId: string;
  version: number;
  content: ContentDto;
}): Promise<ExportResponse> => {
  const url = new URL('/v1/file/async/single', getBaseUrl());
  return requestWithAuth((headers) =>
    fetchJson<ExportResponse>(url.toString(), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
};

export const generatePdfsSync = async (body: {
  designId: string;
  version: number;
  contents: ContentDto[];
  outputDir?: string;
  zipFileName?: string;
  /** `outputDir` を許可するルート集合 (MCP Roots 由来)。`saveTempFile` で検証に使う。 */
  allowedRoots?: string[];
}): Promise<string> => {
  const url = new URL('/v1/file/sync/multiple', getBaseUrl());
  const { outputDir, zipFileName, allowedRoots, ...payload } = body;
  const data = await requestWithAuth((headers) =>
    fetchBinary(url.toString(), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: SYNC_GENERATION_TIMEOUT_MS,
    }),
  );
  return saveTempFile(
    data,
    zipFileName ?? 'download.zip',
    outputDir,
    allowedRoots ?? [],
  );
};

export const generatePdfsAsync = async (body: {
  designId: string;
  version: number;
  contents: ContentDto[];
}): Promise<ExportResponse> => {
  const url = new URL('/v1/file/async/multiple', getBaseUrl());
  return requestWithAuth((headers) =>
    fetchJson<ExportResponse>(url.toString(), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
};

export const downloadFile = async (
  requestId: string,
  fileId: string,
  fileName?: string,
  outputDir?: string,
  allowedRoots?: string[],
): Promise<string> => {
  const url = new URL(`/v1/file/download/${requestId}/${fileId}`, getBaseUrl());
  const data = await requestWithAuth((headers) =>
    fetchBinary(url.toString(), { headers }),
  );
  return saveTempFile(
    data,
    fileName ?? `${fileId}.pdf`,
    outputDir,
    allowedRoots ?? [],
  );
};

export const downloadZip = async (
  requestId: string,
  fileName?: string,
  outputDir?: string,
  allowedRoots?: string[],
): Promise<string> => {
  const url = new URL(`/v1/file/download/${requestId}`, getBaseUrl());
  const data = await requestWithAuth((headers) =>
    fetchBinary(url.toString(), { headers }),
  );
  return saveTempFile(
    data,
    fileName ?? `${requestId}.zip`,
    outputDir,
    allowedRoots ?? [],
  );
};

/**
 * 生成リクエストの状態 (PRJ-3-2018)。
 * - queued / processing: 生成中 (`queued` は予約値で、現行実装では通常出ない)
 * - completed: `files[]` (と部分失敗なら `failedFiles[]`) を持つ
 * - failed: `error` に `{ code, message }` (英語) を持つ。multiple の全件失敗では
 *   `failedFiles[]` にファイルごとの理由も入る
 *
 * 非同期生成の Job は終端から 24 時間保持される。過ぎた後と同期生成は、API が出力記録から
 * 判定する (completed、multiple の全件失敗なら failed / FILE_GENERATION_FAILED、生成後に
 * 削除されていれば 404。single の失敗は出力記録が無いので 404)。この場合 `failedFiles` や
 * 詳しい `error.code` は返らない。
 *
 * 参照: content-service `GET /v1/file/status/{requestId}`
 */
export type GenerationStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type GenerationStatusResponse = {
  requestId: string;
  status: GenerationStatus;
  designId?: string;
  version?: number;
  files: Array<{
    fileId: string;
    fileName: string;
    pageCount?: number;
    /** API ベース URL からの相対パス (`/v1/file/download/{requestId}/{fileId}`) */
    downloadPath: string;
  }>;
  /** `fileId` は受付時に返した値 (記録の無い古いリクエストでは省略) */
  failedFiles?: Array<{
    fileId?: string;
    fileName: string;
    code: string;
    message: string;
  }>;
  error?: { code: string; message: string };
  createdAt?: string;
  completedAt?: string;
};

export type GenerationStatusResult = GenerationStatusResponse & {
  /** 生成中のときに API が返す `Retry-After` (秒)。無ければ undefined */
  retryAfterSeconds?: number;
};

export const getGenerationStatus = async (
  requestId: string,
): Promise<GenerationStatusResult> => {
  const url = new URL(
    `/v1/file/status/${encodeURIComponent(requestId)}`,
    getBaseUrl(),
  );
  const { data, headers } = await requestWithAuth((authHeaders) =>
    fetchJsonWithHeaders<GenerationStatusResponse>(url.toString(), {
      headers: authHeaders,
    }),
  );
  const retryAfter = headers.get('Retry-After')?.trim();
  return {
    ...data,
    ...(retryAfter !== undefined && /^\d+$/.test(retryAfter)
      ? { retryAfterSeconds: Number(retryAfter) }
      : {}),
  };
};

export const listDesigns = async (): Promise<DesignListResponse> => {
  const url = new URL('/v1/file/designs', getBaseUrl());
  return requestWithAuth((headers) =>
    fetchJson<DesignListResponse>(url.toString(), { headers }),
  );
};
