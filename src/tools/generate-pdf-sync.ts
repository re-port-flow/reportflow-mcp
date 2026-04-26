import { generatePdfSync, ContentDto } from '../client.js';

export const generatePdfSyncTool = {
  name: 'generate_pdf_sync',
  description:
    'デザインIDとパラメータを指定してPDFを同期生成します。生成完了後にローカルファイルパスを返します。単一PDFの即時生成に適しています。outputDir を指定するとそのディレクトリに、未指定の場合は現在の作業ディレクトリに保存します。\n\n【重要】呼び出し前に必ず get_design_parameters でデザインの必要パラメータ構造を確認し、ユーザーから必要な値を聞き出すこと。ユーザーが指定していないパラメータがある場合は、本ツールを呼ぶ前にユーザーに必ず確認すること。プレースホルダー値・架空の値を勝手に生成しないこと。パラメータが一切提供されていない場合も、まずユーザーに値を尋ねること。',
};

export type GeneratePdfSyncInput = {
  designId: string;
  version: number;
  content: ContentDto;
  outputDir?: string;
};

export type GeneratePdfSyncResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleGeneratePdfSync = async (
  input: GeneratePdfSyncInput,
): Promise<GeneratePdfSyncResult> => {
  try {
    const filePath = await generatePdfSync(input);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ filePath }, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
