import axios from 'axios';
import { saveTempFile } from './file-helper.js';

const getContentServiceConfig = () => {
  const baseUrl =
    process.env['REPORTFLOW_API_BASE_URL'] ?? 'http://localhost:3002';
  const appKey = process.env['REPORTFLOW_APP_KEY'];
  const secretKey = process.env['REPORTFLOW_SECRET_KEY'];

  if (!appKey || !secretKey) {
    throw new Error(
      'REPORTFLOW_APP_KEY and REPORTFLOW_SECRET_KEY must be set in environment variables.',
    );
  }

  return { baseUrl, appKey, secretKey };
};

const getContentServiceHeaders = () => {
  const { appKey, secretKey } = getContentServiceConfig();
  return {
    'Content-Type': 'application/json',
    AppKey: appKey,
    SecretKey: secretKey,
  };
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type DesignParameter =
  | string
  | Record<string, string>
  | Array<Record<string, string>>;

export type GetDesignParametersResponse = Record<string, DesignParameter>;

export type ContentParam = Record<string, any>;

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
  const { baseUrl } = getContentServiceConfig();
  const url = new URL(`/v1/file/design/parameter/${designId}`, baseUrl);
  if (version != null) {
    url.searchParams.set('version', String(version));
  }

  const response = await axios.get<GetDesignParametersResponse>(
    url.toString(),
    { headers: getContentServiceHeaders() },
  );
  return response.data;
};

export const generatePdfSync = async (body: {
  designId: string;
  version: number;
  content: ContentDto;
}): Promise<string> => {
  const { baseUrl } = getContentServiceConfig();
  const url = new URL('/v1/file/sync/single', baseUrl);
  const response = await axios.post(url.toString(), body, {
    headers: getContentServiceHeaders(),
    responseType: 'arraybuffer',
  });
  return saveTempFile(response.data as ArrayBuffer, body.content.fileName);
};

export const generatePdfAsync = async (body: {
  designId: string;
  version: number;
  content: ContentDto;
}): Promise<ExportResponse> => {
  const { baseUrl } = getContentServiceConfig();
  const url = new URL('/v1/file/async/single', baseUrl);
  const response = await axios.post<ExportResponse>(url.toString(), body, {
    headers: getContentServiceHeaders(),
  });
  return response.data;
};

export const generatePdfsSync = async (body: {
  designId: string;
  version: number;
  contents: ContentDto[];
}): Promise<string> => {
  const { baseUrl } = getContentServiceConfig();
  const url = new URL('/v1/file/sync/multiple', baseUrl);
  const response = await axios.post(url.toString(), body, {
    headers: getContentServiceHeaders(),
    responseType: 'arraybuffer',
  });
  return saveTempFile(response.data as ArrayBuffer, 'download.zip');
};

export const generatePdfsAsync = async (body: {
  designId: string;
  version: number;
  contents: ContentDto[];
}): Promise<ExportResponse> => {
  const { baseUrl } = getContentServiceConfig();
  const url = new URL('/v1/file/async/multiple', baseUrl);
  const response = await axios.post<ExportResponse>(url.toString(), body, {
    headers: getContentServiceHeaders(),
  });
  return response.data;
};

export const downloadFile = async (
  requestId: string,
  fileId: string,
  fileName?: string,
): Promise<string> => {
  const { baseUrl } = getContentServiceConfig();
  const url = new URL(`/v1/file/download/${requestId}/${fileId}`, baseUrl);
  const response = await axios.get(url.toString(), {
    headers: getContentServiceHeaders(),
    responseType: 'arraybuffer',
  });
  return saveTempFile(
    response.data as ArrayBuffer,
    fileName ?? `${fileId}.pdf`,
  );
};

export const downloadZip = async (
  requestId: string,
  fileName?: string,
): Promise<string> => {
  const { baseUrl } = getContentServiceConfig();
  const url = new URL(`/v1/file/download/${requestId}`, baseUrl);
  const response = await axios.get(url.toString(), {
    headers: getContentServiceHeaders(),
    responseType: 'arraybuffer',
  });
  return saveTempFile(
    response.data as ArrayBuffer,
    fileName ?? `${requestId}.zip`,
  );
};

export const listDesigns = async (): Promise<DesignListResponse> => {
  const { baseUrl } = getContentServiceConfig();
  const url = new URL('/v1/file/designs', baseUrl);
  const response = await axios.get<DesignListResponse>(url.toString(), {
    headers: getContentServiceHeaders(),
  });
  return response.data;
};
