import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  getDesignParametersTool,
  handleGetDesignParameters,
} from './tools/get-design-parameters.js';
import {
  listTemplatesTool,
  handleListTemplates,
} from './tools/list-templates.js';
import {
  generatePdfSyncTool,
  handleGeneratePdfSync,
} from './tools/generate-pdf-sync.js';
import {
  generatePdfAsyncTool,
  handleGeneratePdfAsync,
} from './tools/generate-pdf-async.js';
import {
  generatePdfsSyncTool,
  handleGeneratePdfsSync,
} from './tools/generate-pdfs-sync.js';
import {
  generatePdfsAsyncTool,
  handleGeneratePdfsAsync,
} from './tools/generate-pdfs-async.js';
import { downloadFileTool, handleDownloadFile } from './tools/download-file.js';
import { downloadZipTool, handleDownloadZip } from './tools/download-zip.js';
import { authenticateTool, handleAuthenticate } from './tools/authenticate.js';
import {
  suggestParamsTool,
  handleSuggestParams,
} from './tools/suggest-params.js';
import { searchTool, searchInputSchema, handleSearch } from './tools/search.js';
import { fetchTool, fetchInputSchema, handleFetch } from './tools/fetch.js';
import {
  searchGalleryTemplatesTool,
  searchGalleryTemplatesInputSchema,
  handleSearchGalleryTemplates,
} from './tools/search-gallery-templates.js';
import {
  getGalleryTemplateTool,
  getGalleryTemplateInputSchema,
  handleGetGalleryTemplate,
} from './tools/get-gallery-template.js';
import {
  copyGalleryTemplateTool,
  copyGalleryTemplateInputSchema,
  handleCopyGalleryTemplate,
} from './tools/copy-gallery-template.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerWidgetResources } from './resources/widgets.js';
import { TEMPLATE_LIST_WIDGET_URI } from './widgets/template-list.js';
import { resolveDefaultOutputDir, resolveAllowedRoots } from './roots/index.js';
import {
  telemetryClientFromEnv,
  withTelemetry,
  type TelemetryClient,
} from './telemetry/index.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { name: string; version: string };

// ─── Common Zod Schemas ───────────────────────────────────

const designIdSchema = z.string().describe('デザインID（UUID形式）');
const versionSchema = z.number().int().describe('デザインバージョン番号');

export const contentDtoSchema = z.object({
  fileName: z.string().describe('出力ファイル名（例: invoice.pdf）'),
  shareType: z
    .union([
      z
        .literal('01')
        .describe(
          'ワークスペース内共有: 同一ワークスペースのメンバーのみアクセス可能（デフォルト）',
        ),
      z
        .literal('02')
        .describe(
          '招待者共有: 招待されたメールアドレスを持つユーザーのみアクセス可能',
        ),
      z
        .literal('03')
        .describe(
          '公開URL共有: URL を知る誰でもアクセス可能（オプションでパスコード保護）',
        ),
    ])
    .default('01')
    .describe(
      "共有タイプ（数値コード）。省略時は '01'。レスポンスの share.shareType は 'workspace'/'invited'/'public' で返る。",
    ),
  passcodeEnabled: z.boolean().optional().describe('パスコード保護の有効化'),
  params: z
    .record(z.string(), z.unknown())
    .describe('PDFに埋め込むパラメータ（get_design_parametersで構造を確認）'),
  passthrough: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      '任意の透過メタデータ。Webhook 通知と X-File-Mapping ヘッダーにそのまま含まれる。さらにトップレベルの文字列/数値の値は生成 PDF の XMP メタデータに「キー名=値」で埋め込まれ、PDF 受領者や OS のファイル検索 (Spotlight / Windows Search) から閲覧可能になるため、個人情報・機微情報を入れないこと。',
    ),
});

const outputDirSchema = z
  .string()
  .optional()
  .describe(
    '出力先ディレクトリ (相対/絶対)。未指定時はクライアントのワークスペース (Roots) または現在の作業ディレクトリに保存。ユーザーが場所を指定した場合のみセットすること。',
  );

const singlePdfSchema = z.object({
  designId: designIdSchema,
  version: versionSchema,
  content: contentDtoSchema.describe('PDF生成コンテンツ'),
});

const multiplePdfSchema = z.object({
  designId: designIdSchema,
  version: versionSchema,
  contents: z
    .array(contentDtoSchema)
    .min(1)
    .describe('PDF生成コンテンツの配列（複数ファイル）'),
});

const singlePdfSyncSchema = singlePdfSchema.extend({
  outputDir: outputDirSchema,
});

const multiplePdfSyncSchema = multiplePdfSchema.extend({
  outputDir: outputDirSchema,
  zipFileName: z
    .string()
    .optional()
    .describe('出力 ZIP のファイル名 (省略時は download.zip)'),
});

export type CreateMcpServerOptions = {
  /**
   * stdio: ローカル CLI として動作。authenticate ツール (ブラウザ起動 + OS keychain 保存) を提供する。
   * http: リモート HTTP サーバー。claude.ai 等の外部クライアントが OAuth を担うため、
   *       authenticate ツールは登録しない (誤呼び出しで stdio 専用処理を走らせない)。
   */
  mode?: 'stdio' | 'http';
  /**
   * Apps SDK の UI widget (ui:// リソース + search の openai/outputTemplate _meta)
   * を公開するか。HTTP モードかつ本フラグが true のときのみ公開する。
   *
   * ChatGPT App 経路でのみ有効化し、claude.ai 等の汎用 MCP クライアントには
   * widget を一切見せない (claude.ai は通常 URL、ChatGPT App は `?widgets=1`
   * 付き URL で接続する想定。http-server.ts がクエリから本フラグを決定する)。
   * 既定は false。
   */
  enableWidgets?: boolean;
  /**
   * Telemetry client used to emit `integration.mcp.invoked` events. Defaults
   * to a no-op when `TELEMETRY_ENDPOINT_URL` is unset. Override in tests.
   */
  telemetry?: TelemetryClient;
};

/**
 * 全ツール / Prompts / Resources を登録した McpServer を生成して返す。
 * Transport への接続は呼び出し側で行う（stdio: index.ts、HTTP: http-server.ts）。
 */
export const createMcpServer = (
  opts: CreateMcpServerOptions = {},
): McpServer => {
  const mode = opts.mode ?? 'stdio';
  // widget は HTTP モードかつ明示的に有効化されたとき (ChatGPT App 経路) のみ公開。
  // claude.ai 等の汎用クライアントには見せない。
  const enableWidgets = mode === 'http' && (opts.enableWidgets ?? false);
  const telemetry = opts.telemetry ?? telemetryClientFromEnv();
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
    // title / websiteUrl / icons は MCP 2025-11-25 spec の Implementation 拡張
    // (SDK v2 の Implementation 型で公式サポート)。旧仕様接続では initialize 応答の
    // serverInfo、2026-07-28 接続では server/discover と結果 _meta の serverInfo に
    // 反映され、リモート接続したクライアント (Claude.ai 等) が表示名・掲載アイコン
    // として利用する。
    // icons の src は server と同一オリジン (mcp.re-port-flow.com) で配信中の実アイコン
    // → MCP spec の icon same-origin 推奨を満たす。
    title: 'Re:port Flow MCP',
    websiteUrl: 'https://re-port-flow.com',
    icons: [
      {
        src: 'https://mcp.re-port-flow.com/favicon.svg',
        mimeType: 'image/svg+xml',
      },
      {
        src: 'https://mcp.re-port-flow.com/favicon.ico',
        mimeType: 'image/png',
      },
    ],
  });

  // authenticate (OAuth2 PKCE flow — stdio モードのみ提供)
  if (mode === 'stdio') {
    server.registerTool(
      authenticateTool.name,
      {
        description: authenticateTool.description,
        inputSchema: z.object({
          force: z
            .boolean()
            .optional()
            .describe('既存トークンを破棄して再認証する場合 true'),
        }),
        annotations: {
          title: 'Authenticate with Re:port Flow',
          openWorldHint: true,
          destructiveHint: false,
        },
      },
      withTelemetry(telemetry, authenticateTool.name, async (input) =>
        handleAuthenticate(input),
      ),
    );
  }

  // get_design_parameters
  server.registerTool(
    getDesignParametersTool.name,
    {
      description: getDesignParametersTool.description,
      inputSchema: z.object({
        designId: designIdSchema,
        version: versionSchema
          .optional()
          .describe('バージョン番号（省略時は最新版）'),
      }),
      annotations: {
        title: 'Get Template Parameters',
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withTelemetry(telemetry, getDesignParametersTool.name, async (input) =>
      handleGetDesignParameters(input),
    ),
  );

  // list_templates
  server.registerTool(
    listTemplatesTool.name,
    {
      description: listTemplatesTool.description,
      inputSchema: z.object({}),
      annotations: {
        title: 'List Re:port Flow Templates',
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withTelemetry(telemetry, listTemplatesTool.name, async (input) =>
      handleListTemplates(input),
    ),
  );

  // ─── generate_pdf_sync (両モード共通) ──────────────────────────────────
  // HTTP モードでは fileUrl + requestId + fileId を返すのみで、サーバー側
  // filesystem には保存しない (コンテナ内パスはクライアント不可達)。
  // stdio モードでは Roots/outputDir に保存し絶対パスを返す。
  // どちらのモードでも PDF の base64 blob は返さない (claude.ai / Claude Desktop は
  // MCP EmbeddedResource から PDF を inline 表示しないため、payload bloat を避ける)。
  if (mode === 'stdio') {
    server.registerTool(
      generatePdfSyncTool.name,
      {
        description: generatePdfSyncTool.description,
        inputSchema: singlePdfSyncSchema,
        annotations: {
          title: 'Generate PDF (sync)',
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      withTelemetry(telemetry, generatePdfSyncTool.name, async (input) =>
        handleGeneratePdfSync(input, {
          mode: 'stdio',
          resolveOutputDir: () => resolveDefaultOutputDir(server),
          resolveAllowedRoots: () => resolveAllowedRoots(server),
        }),
      ),
    );
  } else {
    // HTTP モード: outputDir は受け付けない (サーバ filesystem には保存しない)。
    // 応答は fileUrl + requestId + fileId のみ。
    server.registerTool(
      generatePdfSyncTool.name,
      {
        description: generatePdfSyncTool.description,
        inputSchema: singlePdfSchema,
        annotations: {
          title: 'Generate PDF (sync)',
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      withTelemetry(telemetry, generatePdfSyncTool.name, async (input) =>
        handleGeneratePdfSync(input, { mode: 'http' }),
      ),
    );
  }

  // ─── 他の filesystem-writing tools は stdio モード専用 ──────────────────
  // generate_pdfs_sync (ZIP) と download_* は claude.ai 等のリモートクライアントから
  // プレビュー対象にならないため、HTTP モードでは async 版のみ提供する。
  if (mode === 'stdio') {
    // generate_pdfs_sync (Roots-aware)
    server.registerTool(
      generatePdfsSyncTool.name,
      {
        description: generatePdfsSyncTool.description,
        inputSchema: multiplePdfSyncSchema,
        annotations: {
          title: 'Generate Multiple PDFs (sync)',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      withTelemetry(telemetry, generatePdfsSyncTool.name, async (input) =>
        handleGeneratePdfsSync(input, {
          resolveOutputDir: () => resolveDefaultOutputDir(server),
          resolveAllowedRoots: () => resolveAllowedRoots(server),
        }),
      ),
    );

    // download_file
    server.registerTool(
      downloadFileTool.name,
      {
        description: downloadFileTool.description,
        inputSchema: z.object({
          requestId: z
            .string()
            .describe('generate_pdf_asyncで返されたrequestId（UUID）'),
          fileId: z.string().describe('generate_pdf_asyncのfiles[].fileId'),
          fileName: z
            .string()
            .optional()
            .describe('保存ファイル名（省略時はfileId.pdf）'),
          outputDir: outputDirSchema,
        }),
        annotations: {
          title: 'Download Generated File',
          // Writes the downloaded PDF to disk (saveTempFile → fs.writeFile)
          // under outputDir or cwd, so NOT read-only despite "download" naming.
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      withTelemetry(telemetry, downloadFileTool.name, async (input) =>
        handleDownloadFile(input, {
          resolveAllowedRoots: () => resolveAllowedRoots(server),
        }),
      ),
    );

    // download_zip
    server.registerTool(
      downloadZipTool.name,
      {
        description: downloadZipTool.description,
        inputSchema: z.object({
          requestId: z
            .string()
            .describe('generate_pdfs_asyncで返されたrequestId（UUID）'),
          fileName: z
            .string()
            .optional()
            .describe('保存ファイル名（省略時はrequestId.zip）'),
          outputDir: outputDirSchema,
        }),
        annotations: {
          title: 'Download Batch ZIP',
          // Writes the batch ZIP to disk under outputDir or cwd
          // (same rationale as download_file).
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      withTelemetry(telemetry, downloadZipTool.name, async (input) =>
        handleDownloadZip(input, {
          resolveAllowedRoots: () => resolveAllowedRoots(server),
        }),
      ),
    );

    // generate_pdf_async は HTTP モードでは非公開化 (sync が data+fileUrl+fileId を
    // 1 リクエストで返せるため、リモートクライアント側で async を呼び分ける合理性が
    // 薄く、Claude がツール選択を誤る原因になる)。stdio モードでは Claude Desktop /
    // Code 内のローカル開発で個別生成 → download_file の組み合わせを使うケースが
    // あるため引き続き提供。
    server.registerTool(
      generatePdfAsyncTool.name,
      {
        description: generatePdfAsyncTool.description,
        inputSchema: singlePdfSchema,
        annotations: {
          title: 'Generate PDF (async)',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      withTelemetry(telemetry, generatePdfAsyncTool.name, async (input) =>
        handleGeneratePdfAsync(input),
      ),
    );
  }

  // generate_pdfs_async (両モード共通: 複数 PDF を非同期生成。
  // 単数 sync では捌けない bulk 用途のため HTTP モードでも残す)
  server.registerTool(
    generatePdfsAsyncTool.name,
    {
      description: generatePdfsAsyncTool.description,
      inputSchema: multiplePdfSchema,
      annotations: {
        title: 'Generate Multiple PDFs (async)',
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withTelemetry(telemetry, generatePdfsAsyncTool.name, async (input) =>
      handleGeneratePdfsAsync(input),
    ),
  );

  // suggest_params (Sampling-backed)
  // NOTE: Sampling は 2026-07-28 で Deprecated (SEP-2577)。旧仕様接続 (stdio の
  // Claude Desktop 等) では従来どおり push 型 sampling/createMessage を使い、
  // 2026-07-28 接続や Sampling 非対応クライアントでは既存のスキーマフォールバック
  // (samplingUnavailableResult) が自動で効く (capability 判定 + 例外捕捉)。
  server.registerTool(
    suggestParamsTool.name,
    {
      description: suggestParamsTool.description,
      inputSchema: z.object({
        designId: designIdSchema,
        version: versionSchema
          .optional()
          .describe('バージョン番号（省略時は最新版）'),
        description: z
          .string()
          .describe(
            '帳票の内容を自然文で記述（例: "請求書、宛先A社、合計1万円"）',
          ),
      }),
      annotations: {
        title: 'Suggest Parameters via Sampling',
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    withTelemetry(telemetry, suggestParamsTool.name, async (input) =>
      handleSuggestParams(server, input),
    ),
  );

  // ─── ChatGPT Apps コネクター規約ツール (search / fetch) ──────────────────
  // ChatGPT は Developer Mode 無し (一般 Apps 経路) の MCP サーバーに対し、
  // 固定名ツール `search` / `fetch` の存在を期待する。list_templates /
  // get_design_parameters のラッパーで、両モードに登録する (Claude 系クライアント
  // でも検索導線として機能するため stdio でも提供)。
  // widget 有効時 (ChatGPT App 経路) は search の結果を ui:// widget でカード表示する。
  // _meta["openai/outputTemplate"] が widget リソース URI を参照し、ChatGPT は
  // tools/call 後にそのリソースを読み取り iframe でレンダリングする。widget 無効時
  // (claude.ai / stdio 等) では _meta を付けない。
  server.registerTool(
    searchTool.name,
    {
      description: searchTool.description,
      inputSchema: z.object(searchInputSchema),
      annotations: {
        title: 'Search Re:port Flow Templates',
        readOnlyHint: true,
        // 参照範囲はユーザー自身のワークスペース内テンプレートカタログに限定され、
        // 外部サイト / Web へはアクセスしない (closed-world)。ChatGPT 等の安全判定で
        // 「外部探索ツール」と誤認されるのを避けるため明示する。
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      ...(enableWidgets
        ? { _meta: { 'openai/outputTemplate': TEMPLATE_LIST_WIDGET_URI } }
        : {}),
    },
    withTelemetry(telemetry, searchTool.name, async (input) =>
      handleSearch(input),
    ),
  );

  server.registerTool(
    fetchTool.name,
    {
      description: fetchTool.description,
      inputSchema: z.object(fetchInputSchema),
      annotations: {
        title: 'Fetch Re:port Flow Template Details',
        readOnlyHint: true,
        // search と同様 closed-world: 内部テンプレートカタログのみを参照する。
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withTelemetry(telemetry, fetchTool.name, async (input) =>
      handleFetch(input),
    ),
  );

  // ─── 公開ギャラリーツール (search_gallery_templates / get_gallery_template) ──
  // ワークスペース内デザインを対象とする既存 search / fetch / list_templates とは
  // 別系統で、公開テンプレートギャラリー (認証不要 API) を参照する。テンプレートを
  // 1 件も持たないユーザーでも会話が詰まらないようにするための読み取り導線
  // (PRJ-3-1237)。両モード (stdio / HTTP) に登録する。
  server.registerTool(
    searchGalleryTemplatesTool.name,
    {
      description: searchGalleryTemplatesTool.description,
      inputSchema: z.object(searchGalleryTemplatesInputSchema),
      annotations: {
        title: 'Search Public Template Gallery',
        readOnlyHint: true,
        // 参照先は Re:port Flow 自身の公開ギャラリー API に限定され、
        // 外部サイト / Web へはアクセスしない (closed-world)。
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withTelemetry(telemetry, searchGalleryTemplatesTool.name, async (input) =>
      handleSearchGalleryTemplates(input),
    ),
  );

  server.registerTool(
    getGalleryTemplateTool.name,
    {
      description: getGalleryTemplateTool.description,
      inputSchema: z.object(getGalleryTemplateInputSchema),
      annotations: {
        title: 'Get Public Gallery Template Details',
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withTelemetry(telemetry, getGalleryTemplateTool.name, async (input) =>
      handleGetGalleryTemplate(input),
    ),
  );

  // copy_gallery_template (PRJ-3-1238): report-mcp 初の書き込みツール。
  // 複製先はアクセストークン JWT の workspace_id 固定（引数で受けない）。
  // 呼ぶたびに新しいデザインが作成されるため idempotentHint: false。
  server.registerTool(
    copyGalleryTemplateTool.name,
    {
      description: copyGalleryTemplateTool.description,
      inputSchema: z.object(copyGalleryTemplateInputSchema),
      annotations: {
        title: 'Copy Gallery Template to Workspace',
        readOnlyHint: false,
        openWorldHint: false,
        // 既存データを一切変更・削除しない（新規作成のみ）
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withTelemetry(telemetry, copyGalleryTemplateTool.name, async (input) =>
      handleCopyGalleryTemplate(input),
    ),
  );

  // Prompts (recipe cards) & Resources (read-only data) — 各 register 関数が
  // 内部で server.registerPrompt() / server.registerResource() を呼んで
  // capability を自動登録します。
  registerPrompts(server);
  registerResources(server, pkg);

  // Apps SDK widget リソース (ui://) は widget 有効時 (ChatGPT App 経路) のみ登録。
  // search の outputTemplate から参照される。claude.ai / stdio では登録しない。
  if (enableWidgets) {
    registerWidgetResources(server);
  }

  return server;
};

/**
 * stdio エントリ。serveStdio が接続の opening exchange で世代を判定し、
 * 旧仕様 (initialize ハンドシェイク) と 2026-07-28 (server/discover +
 * per-request _meta envelope) の両方を単一 factory で処理する。
 * serveStdio は同期にハンドルを返し、以降のライフサイクル (transport の
 * 起動・切断) はハンドル側が持つ。HTTP モードはこの関数を使わない。
 */
export const startServer = (): void => {
  serveStdio(() => createMcpServer(), {
    // stdout は MCP プロトコルチャンネルのため、エラーは stderr へ流す
    // (v1 の connect().catch(console.error) 相当の可視性を維持)。
    onerror: (err: Error) => console.error('[reportflow-mcp]', err),
  });
};
