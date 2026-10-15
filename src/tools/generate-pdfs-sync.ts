import { generatePdfsSync, ContentDto } from '../client.js';
import {
  attachPlanNotice,
  type PlanNoticeResolver,
} from '../workspace-usage.js';
import {
  isSyncGenerationTimeout,
  SYNC_TIMEOUT_GUIDANCE,
} from './sync-timeout.js';

export const generatePdfsSyncTool = {
  name: 'generate_pdfs_sync',
  description:
    '複数のパラメータセットでPDFを一括で同期出力し、ZIPファイルとして返します。出力完了後にZIPファイルのローカルパスを返します。outputDir を指定するとそのディレクトリに、未指定の場合はクライアントのワークスペース (Roots) または OS 一時ディレクトリに保存します。zipFileName で出力 ZIP のファイル名を指定可能 (デフォルト download.zip)。生成が 60 秒を超えると API がタイムアウト (504) し、ZIP を受け取れません (サーバー側では生成が続き、ページが消費されることがあります)。件数が多いなど 60 秒を超えうる生成は generate_pdfs_async を使うこと。\n\n【重要】呼び出し前に必ず get_design_parameters でテンプレートの必要パラメータ構造を確認し、ユーザーから必要な値を聞き出すこと。ユーザーが指定していないパラメータがある場合は、本ツールを呼ぶ前にユーザーに必ず確認すること。プレースホルダー値・架空の値を勝手に生成しないこと。パラメータが一切提供されていない場合も、まずユーザーに値を尋ねること。\n\n【passthrough のプライバシー注意】contents[].passthrough のトップレベルの文字列/数値の値は出力した PDF の XMP メタデータに埋め込まれ、PDF 受領者や OS のファイル検索 (Spotlight / Windows Search) から閲覧可能になるため、個人情報・機微情報を入れないこと。',
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
  /**
   * 生成成功時に応答へ添えるプラン / 使用量ブロックの解決関数
   * (既定: `workspace-usage.ts` の `resolvePlanNotice`)。テストからの差し替え用。
   */
  resolvePlanNotice?: PlanNoticeResolver;
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
    // プラン / 使用量 (取得できたときだけ `plan` が生える。失敗は黙って省く)。
    // text は JSON そのものなので、後ろに文章を足さずキーとして載せる。
    const payload = await attachPlanNotice(
      { filePath },
      deps.resolvePlanNotice,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text',
          text: isSyncGenerationTimeout(err)
            ? `エラー: ${message}\n${SYNC_TIMEOUT_GUIDANCE}`
            : `エラー: ${message}`,
        },
      ],
      isError: true,
    };
  }
};
