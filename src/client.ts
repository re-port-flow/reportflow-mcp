import { fetchJson, fetchBinary } from './http.js';
import { requestWithAuth } from './auth.js';
import { saveTempFile } from './file-helper.js';

const getBaseUrl = () =>
  process.env['REPORTFLOW_API_BASE_URL'] ?? 'http://localhost:3002';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DesignParameter =
  | string
  | Record<string, string>
  | Array<Record<string, string>>;

export type GetDesignParametersResponse = Record<string, DesignParameter>;

export type ContentParam = Record<string, unknown>;

export type ContentDto = {
  fileName: string;
  shareType?: string;
  passcodeEnabled?: boolean;
  params: ContentParam;
};

export type ShareInfo = {
  shareType: string;
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

export const generatePdfSync = async (body: {
  designId: string;
  version: number;
  content: ContentDto;
}): Promise<string> => {
  const url = new URL('/v1/file/sync/single', getBaseUrl());
  const data = await requestWithAuth((headers) =>
    fetchBinary(url.toString(), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return saveTempFile(data, body.content.fileName);
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
}): Promise<string> => {
  const url = new URL('/v1/file/sync/multiple', getBaseUrl());
  const data = await requestWithAuth((headers) =>
    fetchBinary(url.toString(), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return saveTempFile(data, 'download.zip');
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
): Promise<string> => {
  const url = new URL(`/v1/file/download/${requestId}/${fileId}`, getBaseUrl());
  const data = await requestWithAuth((headers) =>
    fetchBinary(url.toString(), { headers }),
  );
  return saveTempFile(data, fileName ?? `${fileId}.pdf`);
};

export const downloadZip = async (
  requestId: string,
  fileName?: string,
): Promise<string> => {
  const url = new URL(`/v1/file/download/${requestId}`, getBaseUrl());
  const data = await requestWithAuth((headers) =>
    fetchBinary(url.toString(), { headers }),
  );
  return saveTempFile(data, fileName ?? `${requestId}.zip`);
};

export const listDesigns = async (): Promise<DesignListResponse> => {
  const url = new URL('/v1/file/designs', getBaseUrl());
  return requestWithAuth((headers) =>
    fetchJson<DesignListResponse>(url.toString(), { headers }),
  );
};
