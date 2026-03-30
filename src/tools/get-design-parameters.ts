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

export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export const handleGetDesignParameters = async (
  input: GetDesignParametersInput,
): Promise<McpToolResult> => {
  try {
    const result = await getDesignParameters(input.designId, input.version);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
