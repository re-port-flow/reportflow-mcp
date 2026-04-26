import { generatePdfsSync, ContentDto } from '../client.js';

export const generatePdfsSyncTool = {
  name: 'generate_pdfs_sync',
  description:
    '複数のパラメータセットでPDFを一括同期生成し、ZIPファイルとして返します。生成完了後にZIPファイルのローカルパスを返します。outputDir を指定するとそのディレクトリに、未指定の場合は現在の作業ディレクトリに保存します。zipFileName で出力 ZIP のファイル名を指定可能 (デフォルト download.zip)。\n\n【重要】呼び出し前に必ず get_design_parameters でデザインの必要パラメータ構造を確認し、ユーザーから必要な値を聞き出すこと。ユーザーが指定していないパラメータがある場合は、本ツールを呼ぶ前にユーザーに必ず確認すること。プレースホルダー値・架空の値を勝手に生成しないこと。パラメータが一切提供されていない場合も、まずユーザーに値を尋ねること。',
};

export type GeneratePdfsSyncInput = {
  designId: string;
  version: number;
  contents: ContentDto[];
  outputDir?: string;
  zipFileName?: string;
};

export type GeneratePdfsSyncResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleGeneratePdfsSync = async (
  input: GeneratePdfsSyncInput,
): Promise<GeneratePdfsSyncResult> => {
  try {
    const filePath = await generatePdfsSync(input);
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
