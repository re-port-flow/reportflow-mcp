import { listDesigns, DesignListResponse } from '../client.js';

export const listTemplatesTool = {
  name: 'list_templates',
  description:
    'ワークスペース内のデザイン一覧を取得します。各デザインのID・名称・最新バージョン・サムネイルURLを返します。取得したidをdesignIdとしてPDF生成ツールやget_design_parametersに使用します。',
};

export type ListTemplatesInput = Record<string, never>;

export type ListTemplatesResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleListTemplates = async (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _input: ListTemplatesInput,
): Promise<ListTemplatesResult> => {
  try {
    const result: DesignListResponse = await listDesigns();
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
