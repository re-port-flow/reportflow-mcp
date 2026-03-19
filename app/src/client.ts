import axios from 'axios';

const getConfig = () => {
  const appKey = process.env['REPORTFLOW_APP_KEY'];
  const secretKey = process.env['REPORTFLOW_SECRET_KEY'];
  if (!appKey || !secretKey) {
    throw new Error(
      'REPORTFLOW_APP_KEY and REPORTFLOW_SECRET_KEY must be set.',
    );
  }
  return {
    baseUrl: process.env['REPORTFLOW_API_BASE_URL'] ?? 'http://localhost:3002',
    appKey,
    secretKey,
  };
};

const getHeaders = () => {
  const { appKey, secretKey } = getConfig();
  return {
    'Content-Type': 'application/json',
    AppKey: appKey,
    SecretKey: secretKey,
  };
};

export type DesignParameter =
  | string
  | Record<string, string>
  | Array<Record<string, string>>;

export type GetDesignParametersResponse = Record<string, DesignParameter>;

export const getDesignParameters = async (
  designId: string,
  version?: number,
): Promise<GetDesignParametersResponse> => {
  const { baseUrl } = getConfig();
  const url = new URL(`/v1/file/design/parameter/${designId}`, baseUrl);
  if (version != null) {
    url.searchParams.set('version', String(version));
  }

  const response = await axios.get<GetDesignParametersResponse>(
    url.toString(),
    {
      headers: getHeaders(),
    },
  );
  return response.data;
};
