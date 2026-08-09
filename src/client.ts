import {
  fetchJson,
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
 *             ワークスペースのダウンロードエンドポイント URL (`{base}/file/download/{requestId}`)。
 * - requestId: 同 `Request-Id` ヘッダー。
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
  const requestInit = (headers: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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

export const listDesigns = async (): Promise<DesignListResponse> => {
  const url = new URL('/v1/file/designs', getBaseUrl());
  return requestWithAuth((headers) =>
    fetchJson<DesignListResponse>(url.toString(), { headers }),
  );
};
