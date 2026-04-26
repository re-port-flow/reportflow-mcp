import { generatePdfAsync, ContentDto, ExportResponse } from '../client.js';

export const generatePdfAsyncTool = {
  name: 'generate_pdf_async',
  description:
    'デザインIDとパラメータを指定してPDFを非同期生成します。即座にrequestIdとfiles情報を返します。ファイルのダウンロードはdownload_fileツールを使用してください。\n\n【重要】呼び出し前に必ず get_design_parameters でデザインの必要パラメータ構造を確認し、ユーザーから必要な値を聞き出すこと。ユーザーが指定していないパラメータがある場合は、本ツールを呼ぶ前にユーザーに必ず確認すること。プレースホルダー値・架空の値を勝手に生成しないこと。パラメータが一切提供されていない場合も、まずユーザーに値を尋ねること。',
};

export type GeneratePdfAsyncInput = {
  designId: string;
  version: number;
  content: ContentDto;
};

export type GeneratePdfAsyncResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleGeneratePdfAsync = async (
  input: GeneratePdfAsyncInput,
): Promise<GeneratePdfAsyncResult> => {
  try {
    const result: ExportResponse = await generatePdfAsync(input);
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
