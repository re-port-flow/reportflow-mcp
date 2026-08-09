import { generatePdfsSync, ContentDto } from '../client.js';

export const generatePdfsSyncTool = {
  name: 'generate_pdfs_sync',
  description:
    '複数のパラメータセットでPDFを一括同期生成し、ZIPファイルとして返します。生成完了後にZIPファイルのローカルパスを返します。outputDir を指定するとそのディレクトリに、未指定の場合はクライアントのワークスペース (Roots) または OS 一時ディレクトリに保存します。zipFileName で出力 ZIP のファイル名を指定可能 (デフォルト download.zip)。\n\n【重要】呼び出し前に必ず get_design_parameters でデザインの必要パラメータ構造を確認し、ユーザーから必要な値を聞き出すこと。ユーザーが指定していないパラメータがある場合は、本ツールを呼ぶ前にユーザーに必ず確認すること。プレースホルダー値・架空の値を勝手に生成しないこと。パラメータが一切提供されていない場合も、まずユーザーに値を尋ねること。\n\n【passthrough のプライバシー注意】contents[].passthrough のトップレベルの文字列/数値の値は生成 PDF の XMP メタデータに埋め込まれ、PDF 受領者や OS のファイル検索 (Spotlight / Windows Search) から閲覧可能になるため、個人情報・機微情報を入れないこと。',
};

export type GeneratePdfsSyncInput = {
  designId: string;
  version: number;
  contents: ContentDto[];
  outputDir?: string;
  zipFileName?: string;
};

export type GeneratePdfsSyncDeps = {
  resolveOutputDir?: () => Promise<string | undefined>;
  /**
   * 明示 `outputDir` 指定時の許可ルート集合解決。詳細は generate-pdf-sync.ts を参照。
   */
  resolveAllowedRoots?: () => Promise<string[]>;
};

export type GeneratePdfsSyncResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const handleGeneratePdfsSync = async (
  input: GeneratePdfsSyncInput,
  deps: GeneratePdfsSyncDeps = {},
): Promise<GeneratePdfsSyncResult> => {
  try {
    const outputDir = input.outputDir ?? (await deps.resolveOutputDir?.());
    const allowedRoots =
      input.outputDir != null && deps.resolveAllowedRoots
        ? await deps.resolveAllowedRoots()
        : undefined;
    const filePath = await generatePdfsSync({
      ...input,
      outputDir,
      allowedRoots,
    });
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
