import * as path from 'path';
import { pathToFileURL } from 'url';
import { generatePdfSync, ContentDto } from '../client.js';

export const generatePdfSyncTool = {
  name: 'generate_pdf_sync',
  description:
    'デザインIDとパラメータを指定してPDFを生成します。応答にダウンロード URL が含まれるため、本ツール 1 回の呼び出しで結果提示が完結します (別途ダウンロード用ツールを呼ぶ必要はありません)。\n- stdio モード (Claude Desktop / Code): ローカルに保存し絶対パスも返します。outputDir で保存先を指定できます (未指定時はクライアントのワークスペース Roots または OS 一時ディレクトリ)。\n- HTTP モード (claude.ai / n8n 等): サーバー側には保存しません。includePreview=true を指定すると inline preview 用のバイナリも併せて返します (claude.ai が PDF preview をサポートしていない現状ではデフォルト false 推奨)。\n\n【重要】呼び出し前に必ず get_design_parameters でデザインの必要パラメータ構造を確認し、ユーザーから必要な値を聞き出すこと。プレースホルダー値・架空の値を勝手に生成しないこと。',
};

export type GeneratePdfSyncInput = {
  designId: string;
  version: number;
  content: ContentDto;
  outputDir?: string;
  /**
   * true を指定すると EmbeddedResource (application/pdf, base64 blob) も返却する。
   * デフォルト false。claude.ai が PDF resource を inline 表示するように対応した
   * 段階で true を推奨に変更する想定。
   */
  includePreview?: boolean;
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
type EmbeddedResource = {
  type: 'resource';
  resource: {
    uri: string;
    mimeType: string;
    blob: string;
  };
};

/**
 * Tool 層の戻り値型。`client.ts` の `GeneratePdfSyncResult`
 * ({ data, filePath? }) と区別するため `Tool` を付ける。
 */
export type GeneratePdfSyncToolResult = {
  content: Array<TextContent | EmbeddedResource>;
  isError?: true;
};

const toBase64 = (data: ArrayBuffer): string =>
  Buffer.from(data).toString('base64');

/**
 * EmbeddedResource の `uri` を組み立てる。
 *
 * - filePath あり (stdio mode): `pathToFileURL` で OS 依存パスを RFC 8089 準拠の
 *   file URI に変換する。Windows の `C:\\Users\\...` も `file:///C:/Users/...`
 *   になる。空白等の特殊文字も URL-encode される。
 * - filePath なし (http mode): サーバ filesystem に書いていないので、fileName
 *   を URL-encode した合成 URI を返す。クライアントがファイル位置を解決する
 *   ことは期待されない (preview 用 placeholder)。
 */
const buildResourceUri = (
  filePath: string | undefined,
  fileName: string,
): string => {
  if (filePath) {
    return pathToFileURL(filePath).href;
  }
  const safeName = encodeURIComponent(path.basename(fileName));
  return `file:///${safeName}`;
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
  const includePreview = input.includePreview === true;
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
    const { data, filePath, fileUrl, requestId, fileId } =
      await generatePdfSync({
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

    const content: Array<TextContent | EmbeddedResource> = [
      { type: 'text', text },
    ];

    // ─── EmbeddedResource (opt-in) ──────────────────────────────────────
    // claude.ai は現状 PDF resource を inline 表示しないため、毎回 base64 blob を
    // 返すと payload bloat になる。includePreview=true 明示時のみ含める。
    if (includePreview) {
      const fileName = input.content.fileName;
      content.push({
        type: 'resource',
        resource: {
          uri: buildResourceUri(filePath, fileName),
          mimeType: 'application/pdf',
          blob: toBase64(data),
        },
      });
    }

    return { content };
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
