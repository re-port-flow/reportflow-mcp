import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
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
    .record(z.unknown())
    .describe('PDFに埋め込むパラメータ（get_design_parametersで構造を確認）'),
});

const outputDirSchema = z
  .string()
  .optional()
  .describe(
    '出力先ディレクトリ (相対/絶対)。未指定時はクライアントのワークスペース (Roots) または現在の作業ディレクトリに保存。ユーザーが場所を指定した場合のみセットすること。',
  );

const includePreviewSchema = z
  .boolean()
  .optional()
  .describe(
    'true 指定時のみ EmbeddedResource (application/pdf, base64 blob) を応答に含める。claude.ai は現状 PDF resource を inline 表示しないため、通常は省略 (false) で fileUrl のみを利用するのが効率的。',
  );

const singlePdfSchema = {
  designId: designIdSchema,
  version: versionSchema,
  content: contentDtoSchema.describe('PDF生成コンテンツ'),
};

const singlePdfSyncHttpSchema = {
  ...singlePdfSchema,
  includePreview: includePreviewSchema,
};

const multiplePdfSchema = {
  designId: designIdSchema,
  version: versionSchema,
  contents: z
    .array(contentDtoSchema)
    .min(1)
    .describe('PDF生成コンテンツの配列（複数ファイル）'),
};

const singlePdfSyncSchema = {
  ...singlePdfSchema,
  outputDir: outputDirSchema,
  includePreview: includePreviewSchema,
};

const multiplePdfSyncSchema = {
  ...multiplePdfSchema,
  outputDir: outputDirSchema,
  zipFileName: z
    .string()
    .optional()
    .describe('出力 ZIP のファイル名 (省略時は download.zip)'),
};

export type CreateMcpServerOptions = {
  /**
   * stdio: ローカル CLI として動作。authenticate ツール (ブラウザ起動 + OS keychain 保存) を提供する。
   * http: リモート HTTP サーバー。claude.ai 等の外部クライアントが OAuth を担うため、
   *       authenticate ツールは登録しない (誤呼び出しで stdio 専用処理を走らせない)。
   */
  mode?: 'stdio' | 'http';
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
  const telemetry = opts.telemetry ?? telemetryClientFromEnv();
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  // authenticate (OAuth2 PKCE flow — stdio モードのみ提供)
  if (mode === 'stdio') {
    server.tool(
      authenticateTool.name,
      authenticateTool.description,
      {
        force: z
          .boolean()
          .optional()
          .describe('既存トークンを破棄して再認証する場合 true'),
      },
      {
        title: 'Authenticate with ReportFlow',
        openWorldHint: true,
        destructiveHint: false,
      },
      withTelemetry(telemetry, authenticateTool.name, async (input) =>
        handleAuthenticate(input),
      ),
    );
  }

  // get_design_parameters
  server.tool(
    getDesignParametersTool.name,
    getDesignParametersTool.description,
    {
      designId: designIdSchema,
      version: versionSchema
        .optional()
        .describe('バージョン番号（省略時は最新版）'),
    },
    {
      title: 'Get Template Parameters',
      readOnlyHint: true,
      idempotentHint: true,
    },
    withTelemetry(telemetry, getDesignParametersTool.name, async (input) =>
      handleGetDesignParameters(input),
    ),
  );

  // list_templates
  server.tool(
    listTemplatesTool.name,
    listTemplatesTool.description,
    {},
    {
      title: 'List ReportFlow Templates',
      readOnlyHint: true,
      idempotentHint: true,
    },
    withTelemetry(telemetry, listTemplatesTool.name, async (input) =>
      handleListTemplates(input),
    ),
  );

  // ─── generate_pdf_sync (両モード共通) ──────────────────────────────────
  // HTTP モードでは EmbeddedResource (application/pdf, base64 blob) のみを返し、
  // サーバー側 filesystem には保存しない (コンテナ内パスはクライアント不可達)。
  // stdio モードでは従来通り Roots/outputDir に保存 + EmbeddedResource も併せて返す。
  if (mode === 'stdio') {
    server.tool(
      generatePdfSyncTool.name,
      generatePdfSyncTool.description,
      singlePdfSyncSchema,
      {
        title: 'Generate PDF (sync)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
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
    // HTTP モード: outputDir は除外、代わりに includePreview を受け付ける
    server.tool(
      generatePdfSyncTool.name,
      generatePdfSyncTool.description,
      singlePdfSyncHttpSchema,
      {
        title: 'Generate PDF (sync)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
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
    server.tool(
      generatePdfsSyncTool.name,
      generatePdfsSyncTool.description,
      multiplePdfSyncSchema,
      {
        title: 'Generate Multiple PDFs (sync)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      withTelemetry(telemetry, generatePdfsSyncTool.name, async (input) =>
        handleGeneratePdfsSync(input, {
          resolveOutputDir: () => resolveDefaultOutputDir(server),
          resolveAllowedRoots: () => resolveAllowedRoots(server),
        }),
      ),
    );

    // download_file
    server.tool(
      downloadFileTool.name,
      downloadFileTool.description,
      {
        requestId: z
          .string()
          .describe('generate_pdf_asyncで返されたrequestId（UUID）'),
        fileId: z.string().describe('generate_pdf_asyncのfiles[].fileId'),
        fileName: z
          .string()
          .optional()
          .describe('保存ファイル名（省略時はfileId.pdf）'),
        outputDir: outputDirSchema,
      },
      {
        title: 'Download Generated File',
        // Writes the downloaded PDF to disk (saveTempFile → fs.writeFile)
        // under outputDir or cwd, so NOT read-only despite "download" naming.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      withTelemetry(telemetry, downloadFileTool.name, async (input) =>
        handleDownloadFile(input, {
          resolveAllowedRoots: () => resolveAllowedRoots(server),
        }),
      ),
    );

    // download_zip
    server.tool(
      downloadZipTool.name,
      downloadZipTool.description,
      {
        requestId: z
          .string()
          .describe('generate_pdfs_asyncで返されたrequestId（UUID）'),
        fileName: z
          .string()
          .optional()
          .describe('保存ファイル名（省略時はrequestId.zip）'),
        outputDir: outputDirSchema,
      },
      {
        title: 'Download Batch ZIP',
        // Writes the batch ZIP to disk under outputDir or cwd
        // (same rationale as download_file).
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
    server.tool(
      generatePdfAsyncTool.name,
      generatePdfAsyncTool.description,
      singlePdfSchema,
      {
        title: 'Generate PDF (async)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      withTelemetry(telemetry, generatePdfAsyncTool.name, async (input) =>
        handleGeneratePdfAsync(input),
      ),
    );
  }

  // generate_pdfs_async (両モード共通: 複数 PDF を非同期生成。
  // 単数 sync では捌けない bulk 用途のため HTTP モードでも残す)
  server.tool(
    generatePdfsAsyncTool.name,
    generatePdfsAsyncTool.description,
    multiplePdfSchema,
    {
      title: 'Generate Multiple PDFs (async)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    withTelemetry(telemetry, generatePdfsAsyncTool.name, async (input) =>
      handleGeneratePdfsAsync(input),
    ),
  );

  // suggest_params (Sampling-backed)
  server.tool(
    suggestParamsTool.name,
    suggestParamsTool.description,
    {
      designId: designIdSchema,
      version: versionSchema
        .optional()
        .describe('バージョン番号（省略時は最新版）'),
      description: z
        .string()
        .describe(
          '帳票の内容を自然文で記述（例: "請求書、宛先A社、合計1万円"）',
        ),
    },
    {
      title: 'Suggest Parameters via Sampling',
      readOnlyHint: true,
    },
    withTelemetry(telemetry, suggestParamsTool.name, async (input) =>
      handleSuggestParams(server, input),
    ),
  );

  // Prompts (recipe cards) & Resources (read-only data) — 各 register 関数が
  // 内部で server.prompt() / server.resource() を呼んで capability を自動登録します。
  registerPrompts(server);
  registerResources(server, pkg);

  return server;
};

/**
 * stdio エントリ用の従来 API。createMcpServer() で生成したインスタンスを
 * StdioServerTransport に connect する。HTTP モードはこの関数を使わない。
 */
export const startServer = async (): Promise<void> => {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
};
