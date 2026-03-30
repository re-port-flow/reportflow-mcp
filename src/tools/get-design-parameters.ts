import { getDesignParameters } from '../client.js';

export const getDesignParametersTool = {
  name: 'get_design_parameters',
  description:
    'デザインテンプレートのパラメータ構造を取得します。帳票生成に必要なパラメータの型・構造を確認できます。',
};

export type GetDesignParametersInput = {
  designId: string;
  version?: number;
};

export type GetDesignParametersResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleGetDesignParameters = async (
  input: GetDesignParametersInput,
): Promise<GetDesignParametersResult> => {
  try {
    const result = await getDesignParameters(input.designId, input.version);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
