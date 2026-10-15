import { generatePdfsAsync, ContentDto, ExportResponse } from '../client.js';
import {
  attachPlanNotice,
  type PlanNoticeResolver,
} from '../workspace-usage.js';

export const generatePdfsAsyncTool = {
  name: 'generate_pdfs_async',
  description:
    '複数のパラメータセットでPDFを一括で非同期出力します。即座にrequestIdとfiles情報を返します。生成の完了・失敗は get_generation_status で確認できます。ZIPダウンロードはdownload_zipツールを使用してください (stdio モードのみ)。\n\n【重要】呼び出し前に必ず get_design_parameters でテンプレートの必要パラメータ構造を確認し、ユーザーから必要な値を聞き出すこと。ユーザーが指定していないパラメータがある場合は、本ツールを呼ぶ前にユーザーに必ず確認すること。プレースホルダー値・架空の値を勝手に生成しないこと。パラメータが一切提供されていない場合も、まずユーザーに値を尋ねること。\n\n【passthrough のプライバシー注意】contents[].passthrough のトップレベルの文字列/数値の値は出力した PDF の XMP メタデータに埋め込まれ、PDF 受領者や OS のファイル検索 (Spotlight / Windows Search) から閲覧可能になるため、個人情報・機微情報を入れないこと。',
};

export type GeneratePdfsAsyncInput = {
  designId: string;
  version: number;
  contents: ContentDto[];
};

export type GeneratePdfsAsyncResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export type GeneratePdfsAsyncDeps = {
  /**
   * 生成成功時に応答へ添えるプラン / 使用量ブロックの解決関数
   * (既定: `workspace-usage.ts` の `resolvePlanNotice`)。テストからの差し替え用。
   */
  resolvePlanNotice?: PlanNoticeResolver;
};

export const handleGeneratePdfsAsync = async (
  input: GeneratePdfsAsyncInput,
  deps: GeneratePdfsAsyncDeps = {},
): Promise<GeneratePdfsAsyncResult> => {
  try {
    const result: ExportResponse = await generatePdfsAsync(input);
    // プラン / 使用量 (取得できたときだけ `plan` が生える。失敗は黙って省く)。
    // text は JSON そのものなので、後ろに文章を足さずキーとして載せる。
    //
    // `excludesPendingJob`: async エンドポイントは requestId を即返し、ページ数の
    // 記録 (`_postFileGeneration`) は応答後に走るため、ここで読む使用量には
    // **いま受理したジョブぶんが入っていない**。現在値として読ませない
    // (PR #123 のレビュー指摘)。
    const payload = await attachPlanNotice(result, deps.resolvePlanNotice, {
      excludesPendingJob: true,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
