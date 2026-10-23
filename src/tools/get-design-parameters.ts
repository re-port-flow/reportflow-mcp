import { getDesignParameters } from '../client.js';
import { SAMPLE_GENERATION_POLICY } from './sample-policy.js';

export const getDesignParametersTool = {
  name: 'get_design_parameters',
  description:
    '【PDF 出力の起点 / Sampling 不要・全クライアント対応】指定 designId（テンプレートのID）のパラメータ構造（各フィールドの name・type・label、および作成者が設定した場合は意味・入力ガイドを表す description）を取得します。label は画面に出す表示名（例: 請求書番号）で、params のキーには必ず name を使ってください（label をキーにしない）。generate_pdf_sync / generate_pdfs_async を呼ぶ前に必ず本ツールでスキーマを確認し、description があればその意図に沿って値を解釈してください。' +
    SAMPLE_GENERATION_POLICY,
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
