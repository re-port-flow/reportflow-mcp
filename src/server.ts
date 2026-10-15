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
import {
  getGenerationStatusTool,
  handleGetGenerationStatus,
} from './tools/get-generation-status.js';
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
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { registerPrompts } from './prompts/index.js';
import {
  registerResources,
  type RegisteredResourceHandles,
} from './resources/index.js';
import { registerWidgetResources } from './resources/widgets.js';
import { TEMPLATE_LIST_WIDGET_URI } from './widgets/template-list.js';
import { resolveDefaultOutputDir, resolveAllowedRoots } from './roots/index.js';
import {
  telemetryClientFromEnv,
  withTelemetry,
  type TelemetryClient,
} from './telemetry/index.js';
import { guardToolHandler, type GuardedToolResult } from './tool-guard.js';
import {
  applyCapabilities,
  PUBLIC_CAPABILITIES,
  requiredCapabilityForResource,
  requiredCapabilityForTool,
  sameCapabilities,
  type CapabilityToggle,
  type WorkspaceCapability,
} from './workspace-permission.js';
import {
  clearWorkspaceRoleCache,
  resolveWorkspaceAuthorization,
  type WorkspaceAuthorization,
} from './workspace-role.js';
import {
  trackGallerySearched,
  trackGalleryCopied,
} from './telemetry/gallery-demand.js';
import { withClientContext } from './telemetry/client-context.js';
import { trackMcpConnected } from './telemetry/connected.js';
import { getInvocationWorkspaceId } from './telemetry/workspace.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { name: string; version: string };

// ─── Common Zod Schemas ───────────────────────────────────

const designIdSchema = z
  .string()
  .describe(
    'designId（テンプレートのID。list_templates の id。16 文字程度の英数字の文字列で、UUID ではない。例: 0eUDdgAjNXrrItA2）',
  );
const versionSchema = z.number().int().describe('テンプレートのバージョン番号');

export const contentDtoSchema = z.object({
  fileName: z
    .string()
    .describe(
      '出力する PDF のファイル名（例: invoice.pdf）。次の文字は使えない: / \\ : * ? " < > | と制御文字。空白・日本語は使える。複数出力では contents 内で重複不可（大文字小文字を区別しない）。',
    ),
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
      '任意の透過メタデータ。Webhook 通知と X-File-Mapping ヘッダーにそのまま含まれる。さらにトップレベルの文字列/数値の値は出力した PDF の XMP メタデータに「キー名=値」で埋め込まれ、PDF 受領者や OS のファイル検索 (Spotlight / Windows Search) から閲覧可能になるため、個人情報・機微情報を入れないこと。',
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
  content: contentDtoSchema.describe('出力する PDF の内容'),
});

const multiplePdfSchema = z.object({
  designId: designIdSchema,
  version: versionSchema,
  contents: z
    .array(contentDtoSchema)
    .min(1)
    .describe('出力する PDF の内容の配列（PDF 1 件につき 1 要素）'),
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
  /**
   * この接続 / リクエストで認可済みのワークスペース capability 集合
   * (PRJ-3-1584 / ST-3)。`tools/list` と `resources/list` はここに含まれる
   * capability を要求するものだけを見せる。
   *
   * **省略時は `PUBLIC_CAPABILITIES` (未認証相当)**。fail-closed の既定にして
   * あるので、呼び出し側が解決を忘れてもワークスペース権限は漏れない
   * (`http-server.ts` の per-request factory と `startServer` が
   * `resolveWorkspaceAuthorization()` の結果を渡す)。
   */
  capabilities?: ReadonlySet<WorkspaceCapability>;
  /**
   * call ガードがロールを引き直すときの解決関数。既定は本番の resolver
   * (`resolveWorkspaceAuthorization`) で、`capabilities` を解決したのと同じ
   * 60 秒キャッシュを共有するため、通常はカタログと同じ答えになる。
   *
   * テストからロールを固定するための差し替え口でもある。
   */
  resolveAuthorization?: () => Promise<WorkspaceAuthorization>;
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
  const baseTelemetry = opts.telemetry ?? telemetryClientFromEnv();
  const server = new McpServer(
    {
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
    },
    {
      // 接続直後の初回行動をクライアント AI に指示する (PRJ-3-1373)。
      // SDK は旧仕様接続の initialize 応答と 2026-07-28 の server/discover の
      // 両方にそのまま載せる (ServerOptions.instructions)。stdio / http 共通。
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // `integration.mcp.*` に MCP クライアント種別を付ける (PRJ-3-1438 / ST-1)。
  // **遅延解決にする**: initialize ハンドシェイクはここより後に完了するので、
  // 生成時点で `getClientVersion()` を読むと必ず undefined になる。
  // 呼び出し側 (withTelemetry の 15 箇所以上) は変更しない。
  const telemetry = withClientContext(baseTelemetry, () =>
    server.server.getClientVersion(),
  );

  // ─── ワークスペース権限 (PRJ-3-1584 / ST-3) ────────────────────────────────
  // 認可は**二重**にする。
  //
  // 1. カタログ: ツールとリソースを全部登録したうえで、許可されないものを
  //    `disable()` する。`registerTool` の戻り値 (`RegisteredTool`) が持つ
  //    `enable()` / `disable()` と `server.sendToolListChanged()` は SDK v2 の
  //    公式 API で、内部実装には触らない。「登録しない」ではなく「無効にする」
  //    のは、stdio が接続ごとに 1 インスタンスで、`authenticate` の後や降格の
  //    後に一覧を貼り替えられる必要があるため。
  //    **SDK は無効なツールへの `tools/call` を handler より前に
  //    `ProtocolError(InvalidParams, "Tool X disabled")` で拒否する**
  //    (SDK 実装の tools/call ハンドラが `enabled` を検査。実読で確認済み)。
  //    副作用は起きないが、文言は「権限不足」とは読めない。
  //
  // 2. call ガード (`withGuardedTelemetry`): handler の直前でロールを引き直す。
  //    カタログが古い場合 —— HTTP でロール解決のキャッシュが切れた後や、stdio で
  //    接続後に降格された場合 —— **カタログ上は有効なまま呼び出しが届く**ので、
  //    ここが実際の認可境界になる。上流 fetch の前に止め、原因 (未認証 /
  //    権限不足 / 上流障害) を区別した文言と `tool_denied` テレメトリを返す。
  //
  // どちらか一方では足りない: 1 だけだと降格が次の一覧取得まで反映されず、
  // 2 だけだと権限外のツールが一覧に出続ける。
  let appliedCapabilities = opts.capabilities ?? PUBLIC_CAPABILITIES;
  const toolHandles = new Map<string, CapabilityToggle>();
  // 登録は関数の末尾で行うが、`syncCatalog` が閉包で参照するため先に宣言する。
  let resourceHandles: RegisteredResourceHandles = new Map();

  /** `server.registerTool` の戻り値を名前付きで控える (一覧の出し入れに使う)。 */
  const recordTool = <T extends CapabilityToggle>(
    name: string,
    registered: T,
  ): T => {
    // 表に無いツールをここで落とす。登録時に落ちるので、capability 未定義のまま
    // 出荷されることがない (`requiredCapabilityForTool` は throw する)。
    requiredCapabilityForTool(name);
    toolHandles.set(name, registered);
    return registered;
  };

  /**
   * ロール解決の結果で一覧を貼り替える (**stdio 専用**)。
   *
   * HTTP はリクエストごとに `createMcpServer` を作り直すため、次のリクエストで
   * 自動的に最新のロールが反映される。そこで通知を送っても、stateless な
   * per-request サーバーからの `notifications/tools/list_changed` になり意味が無い。
   */
  const syncCatalog = (authorization: WorkspaceAuthorization): void => {
    if (mode !== 'stdio') return;
    if (sameCapabilities(authorization.capabilities, appliedCapabilities))
      return;
    appliedCapabilities = authorization.capabilities;
    const toolsChanged = applyCapabilities(
      toolHandles,
      appliedCapabilities,
      requiredCapabilityForTool,
    );
    const resourcesChanged = applyCapabilities(
      resourceHandles,
      appliedCapabilities,
      requiredCapabilityForResource,
    );
    // 変化があったときだけ通知する (毎回送るとクライアントが一覧を取り直し続ける)。
    // 送信失敗でツール実行を壊さない —— 認可そのものは call ガードが担うので、
    // 通知が届かなくても「見えているが呼べない」に留まり、権限は漏れない。
    if (toolsChanged) {
      try {
        server.sendToolListChanged();
      } catch {
        // 未接続 / 送信失敗は無視する。
      }
    }
    if (resourcesChanged) {
      try {
        server.sendResourceListChanged();
      } catch {
        // 同上。
      }
    }
  };

  /**
   * `withTelemetry` と capability ガードをまとめて掛ける。
   *
   * ガードは `withTelemetry` の**内側**。拒否も 1 回の呼び出しとして
   * `integration.mcp.invoked` に残り (`success: false`)、加えて
   * `integration.mcp.tool_denied` が拒否理由つきで出る。
   */
  const withGuardedTelemetry = <I, R extends GuardedToolResult>(
    toolName: string,
    handler: (input: I) => Promise<R>,
  ): ((input: I) => Promise<R>) =>
    withTelemetry(
      telemetry,
      toolName,
      guardToolHandler(toolName, handler, {
        mode,
        telemetry,
        onAuthorized: syncCatalog,
        ...(opts.resolveAuthorization
          ? { resolve: opts.resolveAuthorization }
          : {}),
      }),
    );

  // authenticate (OAuth2 PKCE flow — stdio モードのみ提供)
  if (mode === 'stdio') {
    recordTool(
      authenticateTool.name,
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
        withGuardedTelemetry(authenticateTool.name, async (input) => {
          const result = await handleAuthenticate(input);
          // OAuth 完了 = ST-1 の `mcp_connected`。**成功時だけ**送る。
          //
          // 帰属先は**この呼び出しのスコープに記録された**資格情報から読む:
          // `authorize()` が交換直後に `recordCredentialWorkspace` へ書いているので
          // (`auth.ts` の `rememberWorkspace`)、ここでは同期・I/O 無しで確定する。
          // 保存済みトークンを読み直す (`getAuthWorkspaceId()`) 形にすると、並行する
          // `authenticate force=true` が別ワークスペースを保存した瞬間に帰属先が
          // すり替わる (PRJ-3-1117 が設計から消した競合)。
          //
          // handleAuthenticate の戻り値から抜くのも採らない — 人間向けテキストで、
          // 文言を変えるだけで壊れる。
          // 読めなければ帰属を付けずに送る — 接続した事実は失わない。
          if (result.isError !== true) {
            trackMcpConnected(telemetry, {
              workspaceId: getInvocationWorkspaceId(),
            });
            // 認証が変わればロールも変わる (別ワークスペースを選び直せる)。
            // 古い解決結果を捨ててから引き直し、ツール一覧を貼り替える
            // (`force: true` でのワークスペース切り替えを次の tools/list に反映)。
            clearWorkspaceRoleCache();
            syncCatalog(
              await (
                opts.resolveAuthorization ??
                (() => resolveWorkspaceAuthorization('stdio'))
              )(),
            );
          }
          return result;
        }),
      ),
    );
  }

  // get_design_parameters
  recordTool(
    getDesignParametersTool.name,
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
      withGuardedTelemetry(getDesignParametersTool.name, async (input) =>
        handleGetDesignParameters(input),
      ),
    ),
  );

  // list_templates
  recordTool(
    listTemplatesTool.name,
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
      withGuardedTelemetry(listTemplatesTool.name, async (input) =>
        handleListTemplates(input),
      ),
    ),
  );

  // ─── generate_pdf_sync (両モード共通) ──────────────────────────────────
  // HTTP モードでは fileUrl + requestId + fileId を返すのみで、サーバー側
  // filesystem には保存しない (コンテナ内パスはクライアント不可達)。
  // stdio モードでは Roots/outputDir に保存し絶対パスを返す。
  // どちらのモードでも PDF の base64 blob は返さない (claude.ai / Claude Desktop は
  // MCP EmbeddedResource から PDF を inline 表示しないため、payload bloat を避ける)。
  if (mode === 'stdio') {
    recordTool(
      generatePdfSyncTool.name,
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
        withGuardedTelemetry(generatePdfSyncTool.name, async (input) =>
          handleGeneratePdfSync(input, {
            mode: 'stdio',
            resolveOutputDir: () => resolveDefaultOutputDir(server),
            resolveAllowedRoots: () => resolveAllowedRoots(server),
          }),
        ),
      ),
    );
  } else {
    // HTTP モード: outputDir は受け付けない (サーバ filesystem には保存しない)。
    // 応答は fileUrl + requestId + fileId のみ。
    recordTool(
      generatePdfSyncTool.name,
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
        withGuardedTelemetry(generatePdfSyncTool.name, async (input) =>
          handleGeneratePdfSync(input, { mode: 'http' }),
        ),
      ),
    );
  }

  // ─── 他の filesystem-writing tools は stdio モード専用 ──────────────────
  // generate_pdfs_sync (ZIP) と download_* は claude.ai 等のリモートクライアントから
  // プレビュー対象にならないため、HTTP モードでは async 版のみ提供する。
  if (mode === 'stdio') {
    // generate_pdfs_sync (Roots-aware)
    recordTool(
      generatePdfsSyncTool.name,
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
        withGuardedTelemetry(generatePdfsSyncTool.name, async (input) =>
          handleGeneratePdfsSync(input, {
            resolveOutputDir: () => resolveDefaultOutputDir(server),
            resolveAllowedRoots: () => resolveAllowedRoots(server),
          }),
        ),
      ),
    );

    // download_file
    recordTool(
      downloadFileTool.name,
      server.registerTool(
        downloadFileTool.name,
        {
          description: downloadFileTool.description,
          inputSchema: z.object({
            requestId: z
              .string()
              .describe(
                'generate_pdf_asyncで返されたrequestId（16 文字の英数字。UUID ではない）',
              ),
            fileId: z.string().describe('generate_pdf_asyncのfiles[].fileId'),
            fileName: z
              .string()
              .optional()
              .describe('保存ファイル名（省略時はfileId.pdf）'),
            outputDir: outputDirSchema,
          }),
          annotations: {
            title: 'Download Generated PDF',
            // Writes the downloaded PDF to disk (saveTempFile → fs.writeFile)
            // under outputDir or cwd, so NOT read-only despite "download" naming.
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
          },
        },
        withGuardedTelemetry(downloadFileTool.name, async (input) =>
          handleDownloadFile(input, {
            resolveAllowedRoots: () => resolveAllowedRoots(server),
          }),
        ),
      ),
    );

    // download_zip
    recordTool(
      downloadZipTool.name,
      server.registerTool(
        downloadZipTool.name,
        {
          description: downloadZipTool.description,
          inputSchema: z.object({
            requestId: z
              .string()
              .describe(
                'generate_pdfs_asyncで返されたrequestId（16 文字の英数字。UUID ではない）',
              ),
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
        withGuardedTelemetry(downloadZipTool.name, async (input) =>
          handleDownloadZip(input, {
            resolveAllowedRoots: () => resolveAllowedRoots(server),
          }),
        ),
      ),
    );

    // generate_pdf_async は HTTP モードでは非公開化 (sync が data+fileUrl+fileId を
    // 1 リクエストで返せるため、リモートクライアント側で async を呼び分ける合理性が
    // 薄く、Claude がツール選択を誤る原因になる)。stdio モードでは Claude Desktop /
    // Code 内のローカル開発で個別生成 → download_file の組み合わせを使うケースが
    // あるため引き続き提供。
    recordTool(
      generatePdfAsyncTool.name,
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
        withGuardedTelemetry(generatePdfAsyncTool.name, async (input) =>
          handleGeneratePdfAsync(input),
        ),
      ),
    );
  }

  // generate_pdfs_async (両モード共通: 複数 PDF を非同期生成。
  // 単数 sync では捌けない bulk 用途のため HTTP モードでも残す)
  recordTool(
    generatePdfsAsyncTool.name,
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
      withGuardedTelemetry(generatePdfsAsyncTool.name, async (input) =>
        handleGeneratePdfsAsync(input),
      ),
    ),
  );

  // get_generation_status (両モード共通, PRJ-3-2018): 非同期生成の完了・失敗を
  // ダウンロードを試さずに確認する読み取りツール。HTTP モードでも
  // generate_pdfs_async が登録されるので、その状態確認の手段として両モードに置く。
  recordTool(
    getGenerationStatusTool.name,
    server.registerTool(
      getGenerationStatusTool.name,
      {
        description: getGenerationStatusTool.description,
        inputSchema: z.object({
          requestId: z
            .string()
            .describe(
              'generate_pdf_async / generate_pdfs_async で返された requestId（16 文字の英数字。UUID ではない）',
            ),
        }),
        annotations: {
          title: 'Get PDF Generation Status',
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      withGuardedTelemetry(getGenerationStatusTool.name, async (input) =>
        handleGetGenerationStatus(input, { mode }),
      ),
    ),
  );

  // suggest_params (Sampling-backed)
  // NOTE: Sampling は 2026-07-28 で Deprecated (SEP-2577)。旧仕様接続 (stdio の
  // Claude Desktop 等) では従来どおり push 型 sampling/createMessage を使い、
  // 2026-07-28 接続や Sampling 非対応クライアントでは既存のスキーマフォールバック
  // (samplingUnavailableResult) が自動で効く (capability 判定 + 例外捕捉)。
  recordTool(
    suggestParamsTool.name,
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
              '出力する PDF の内容を自然文で記述（例: "請求書、宛先A社、合計1万円"）',
            ),
        }),
        annotations: {
          title: 'Suggest Parameters via Sampling',
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      withGuardedTelemetry(suggestParamsTool.name, async (input) =>
        handleSuggestParams(server, input),
      ),
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
  recordTool(
    searchTool.name,
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
      withGuardedTelemetry(searchTool.name, async (input) =>
        handleSearch(input),
      ),
    ),
  );

  recordTool(
    fetchTool.name,
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
      withGuardedTelemetry(fetchTool.name, async (input) => handleFetch(input)),
    ),
  );

  // ─── 公開ギャラリーツール (search_gallery_templates / get_gallery_template) ──
  // ワークスペース内デザインを対象とする既存 search / fetch / list_templates とは
  // 別系統で、公開テンプレートギャラリー (認証不要 API) を参照する。テンプレートを
  // 1 件も持たないユーザーでも会話が詰まらないようにするための読み取り導線
  // (PRJ-3-1237)。両モード (stdio / HTTP) に登録する。
  recordTool(
    searchGalleryTemplatesTool.name,
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
      // integration.mcp.invoked (呼び出し回数) に加えて、検索語そのものを
      // integration.mcp.gallery.searched として送る (PRJ-3-1350)。公開一覧 API に
      // テキスト検索が無くフィルタは MCP 側で行うため、ここで拾わないと
      // 「どの帳票が探されたか」はどこにも残らない。
      withGuardedTelemetry(searchGalleryTemplatesTool.name, async (input) =>
        handleSearchGalleryTemplates(input, {
          onSearched: (observation) =>
            trackGallerySearched(telemetry, observation),
        }),
      ),
    ),
  );

  recordTool(
    getGalleryTemplateTool.name,
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
      withGuardedTelemetry(getGalleryTemplateTool.name, async (input) =>
        handleGetGalleryTemplate(input),
      ),
    ),
  );

  // copy_gallery_template (PRJ-3-1238): report-mcp 初の書き込みツール。
  // 複製先はアクセストークン JWT の workspace_id 固定（引数で受けない）。
  // 呼ぶたびに新しいデザインが作成されるため idempotentHint: false。
  recordTool(
    copyGalleryTemplateTool.name,
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
      // 検索 → 複製の転換を見るため slug も記録する (PRJ-3-1350)。
      withGuardedTelemetry(copyGalleryTemplateTool.name, async (input) =>
        handleCopyGalleryTemplate(input, {
          onCopied: (observation) => trackGalleryCopied(telemetry, observation),
        }),
      ),
    ),
  );

  // Prompts (recipe cards) & Resources (read-only data) — 各 register 関数が
  // 内部で server.registerPrompt() / server.registerResource() を呼んで
  // capability を自動登録します。
  //
  // Prompts はロールで出し分けない。中身は静的なレシピ文だけで、ワークスペースの
  // API を一切叩かないため (`prompts/*.ts` は上流呼び出しを持たない)。ST-1 判断3 の
  // 「未認証では公開ギャラリー系ツールと静的リソースのみ」に対応する。
  registerPrompts(server);
  resourceHandles = registerResources(server, pkg, () => appliedCapabilities);

  // Apps SDK widget リソース (ui://) は widget 有効時 (ChatGPT App 経路) のみ登録。
  // search の outputTemplate から参照される。claude.ai / stdio では登録しない。
  // widget は静的 HTML なので capability は public (ChatGPT 経路だけ権限集合が
  // ずれることが無いよう、通常経路と同じ表から引く)。
  if (enableWidgets) {
    resourceHandles.set(
      'template-list-widget',
      registerWidgetResources(server),
    );
  }

  // 認可済み capability を初期状態として反映する (未許可のものは `disable()`)。
  applyCapabilities(
    toolHandles,
    appliedCapabilities,
    requiredCapabilityForTool,
  );
  applyCapabilities(
    resourceHandles,
    appliedCapabilities,
    requiredCapabilityForResource,
  );

  return server;
};

/**
 * stdio 接続を開くときの capability 解決。
 *
 * 未認証 (トークン未保存) なら 1 バイトもネットワークへ出ずに
 * `unauthenticated` へ落ちる (`getAuthHeaders` が `AuthRequiredError`)。
 * 保存済みトークンがあるときだけ `GET /workspace/list` を 1 回引く。
 * どちらの場合も**例外は投げない**ので、オフラインでも接続そのものは成立し、
 * 公開ギャラリーツールと `authenticate` は使える。
 */
export const resolveStdioCapabilities = async (): Promise<
  ReadonlySet<WorkspaceCapability>
> => (await resolveWorkspaceAuthorization('stdio')).capabilities;

/**
 * stdio エントリ。serveStdio が接続の opening exchange で世代を判定し、
 * 旧仕様 (initialize ハンドシェイク) と 2026-07-28 (server/discover +
 * per-request _meta envelope) の両方を単一 factory で処理する。
 * serveStdio は同期にハンドルを返し、以降のライフサイクル (transport の
 * 起動・切断) はハンドル側が持つ。HTTP モードはこの関数を使わない。
 */
export const startServer = (): void => {
  serveStdio(
    async () =>
      createMcpServer({ capabilities: await resolveStdioCapabilities() }),
    {
      // stdout は MCP プロトコルチャンネルのため、エラーは stderr へ流す
      // (v1 の connect().catch(console.error) 相当の可視性を維持)。
      onerror: (err: Error) => console.error('[reportflow-mcp]', err),
    },
  );
};
