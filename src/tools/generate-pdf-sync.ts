import { generatePdfSync, ContentDto } from '../client.js';

export const generatePdfSyncTool = {
  name: 'generate_pdf_sync',
  description:
    'デザインIDとパラメータを指定してPDFを生成します。応答にダウンロード URL が含まれるため、本ツール 1 回の呼び出しで結果提示が完結します (別途ダウンロード用ツールを呼ぶ必要はありません)。\n- stdio モード (Claude Desktop / Code): ローカルに保存し絶対パスも返します。outputDir で保存先を指定できます (未指定時はクライアントのワークスペース Roots または OS 一時ディレクトリ)。\n- HTTP モード (claude.ai / n8n 等): サーバー側には保存せず、ダウンロード URL (fileUrl) と requestId / fileId を返します。\n\n【重要】呼び出し前に必ず get_design_parameters でデザインの必要パラメータ構造を確認し、ユーザーから必要な値を聞き出すこと。プレースホルダー値・架空の値を勝手に生成しないこと。\n\n【passthrough のプライバシー注意】content.passthrough のトップレベルの文字列/数値の値は生成 PDF の XMP メタデータに埋め込まれ、PDF 受領者や OS のファイル検索 (Spotlight / Windows Search) から閲覧可能になるため、個人情報・機微情報を入れないこと。',
};

export type GeneratePdfSyncInput = {
  designId: string;
  version: number;
  content: ContentDto;
  outputDir?: string;
};

export type GeneratePdfSyncDeps = {
  /**
   * stdio: 'stdio' (デフォルト) — ローカルファイル保存 + 戻り値に filePath を含める
   * http : 'http'  — ローカル保存をスキップ
   */
  mode?: 'stdio' | 'http';
  /**
   * outputDir 未指定時のフォールバック (stdio モード専用)。
   * server.ts で Roots を見てデフォルトディレクトリを返すために使う。
   */
  resolveOutputDir?: () => Promise<string | undefined>;
  /**
   * 明示 `outputDir` 指定時に「ここから外には書かない」と検証するための許可ルート集合
   * (stdio モード専用)。MCP Roots がある場合はそれを、無い場合は `os.tmpdir()/reportflow`
   * を返す `resolveAllowedRoots(server)` を server.ts でバインドして渡す。
   *
   * 未指定なら client.ts → safe-paths.ts のフォールバック (`DEFAULT_FALLBACK_DIR`) が
   * 使われる。テストや非 MCP 経路では未指定で OK。
   */
  resolveAllowedRoots?: () => Promise<string[]>;
};

type TextContent = { type: 'text'; text: string };

/**
 * Tool 層の戻り値型。`client.ts` の `GeneratePdfSyncResult`
 * ({ data, filePath? }) と区別するため `Tool` を付ける。
 *
 * claude.ai / Claude Desktop は MCP の EmbeddedResource から PDF を inline 表示
 * しないため、base64 blob は返さない (payload bloat を避け、fileUrl / filePath での
 * 受け渡しに一本化する)。
 */
export type GeneratePdfSyncToolResult = {
  content: TextContent[];
  isError?: true;
};

/**
 * 人間向け 1 行サマリを組み立てる。Claude (LLM) がそのままユーザーに提示できる
 * 形を目指す。stdio は保存先、HTTP は URL を提示。
 */
const buildHumanSummary = (
  filePath: string | undefined,
  fileUrl: string | undefined,
): string => {
  if (filePath && fileUrl) {
    return `PDF生成完了\n- 保存先: ${filePath}\n- ダウンロード: ${fileUrl}`;
  }
  if (filePath) return `PDF生成完了\n- 保存先: ${filePath}`;
  if (fileUrl) return `PDF生成完了\n- ダウンロード: ${fileUrl}`;
  return 'PDF生成完了';
};

export const handleGeneratePdfSync = async (
  input: GeneratePdfSyncInput,
  deps: GeneratePdfSyncDeps = {},
): Promise<GeneratePdfSyncToolResult> => {
  const mode = deps.mode ?? 'stdio';
  try {
    const outputDir =
      mode === 'http'
        ? undefined
        : (input.outputDir ?? (await deps.resolveOutputDir?.()));
    // 明示 outputDir があるときだけ allowedRoots を解決する (デフォルト fallback 経路では
    // resolveAllowedRoots を呼ぶ意味がない: outputDir 未指定なら検証対象が無い)。
    const allowedRoots =
      mode !== 'http' && input.outputDir != null && deps.resolveAllowedRoots
        ? await deps.resolveAllowedRoots()
        : undefined;
    const { filePath, fileUrl, requestId, fileId } = await generatePdfSync({
      designId: input.designId,
      version: input.version,
      content: input.content,
      outputDir,
      skipSave: mode === 'http',
      allowedRoots,
    });

    // ─── text content ───────────────────────────────────────────────────
    // 人間向け 1 行 + 構造化 JSON を 1 つの text に同梱。Claude (LLM) が一貫した
    // 形でユーザーに提示できるようにする。
    const structured: Record<string, unknown> = {};
    if (filePath) structured.filePath = filePath;
    if (fileUrl) structured.fileUrl = fileUrl;
    if (requestId) structured.requestId = requestId;
    if (fileId) structured.fileId = fileId;

    const summary = buildHumanSummary(filePath, fileUrl);
    const text =
      Object.keys(structured).length > 0
        ? `${summary}\n\n${JSON.stringify(structured, null, 2)}`
        : summary;

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text',
          text: `PDF生成に失敗しました: ${message}\n対処: designId / version / params を get_design_parameters の出力と照合してください。認証エラーの場合は再認証が必要です。`,
        },
      ],
      isError: true,
    };
  }
};
