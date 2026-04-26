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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { name: string; version: string };

// ─── Common Zod Schemas ─────────────────────────────────────────────────────

const designIdSchema = z.string().describe('デザインID（UUID形式）');
const versionSchema = z.number().int().describe('デザインバージョン番号');

const contentDtoSchema = z.object({
  fileName: z.string().describe('出力ファイル名（例: invoice.pdf）'),
  shareType: z
    .enum(['private', 'public'])
    .optional()
    .describe('共有タイプ（省略時はprivate）'),
  passcodeEnabled: z.boolean().optional().describe('パスコード保護の有効化'),
  params: z
    .record(z.unknown())
    .describe('PDFに埋め込むパラメータ（get_design_parametersで構造を確認）'),
});

const singlePdfSchema = {
  designId: designIdSchema,
  version: versionSchema,
  content: contentDtoSchema.describe('PDF生成コンテンツ'),
};

const multiplePdfSchema = {
  designId: designIdSchema,
  version: versionSchema,
  contents: z
    .array(contentDtoSchema)
    .min(1)
    .describe('PDF生成コンテンツの配列（複数ファイル）'),
};

export const startServer = async (): Promise<void> => {
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  // authenticate (OAuth2 PKCE flow — call this first or when other tools error with auth)
  server.tool(
    authenticateTool.name,
    authenticateTool.description,
    {
      force: z
        .boolean()
        .optional()
        .describe('既存トークンを破棄して再認証する場合 true'),
    },
    async (input) => handleAuthenticate(input),
  );

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
    async (input) => handleGetDesignParameters(input),
  );

  // list_templates
  server.tool(
    listTemplatesTool.name,
    listTemplatesTool.description,
    {},
    async (input) => handleListTemplates(input),
  );

  // generate_pdf_sync
  server.tool(
    generatePdfSyncTool.name,
    generatePdfSyncTool.description,
    singlePdfSchema,
    async (input) => handleGeneratePdfSync(input),
  );

  // generate_pdf_async
  server.tool(
    generatePdfAsyncTool.name,
    generatePdfAsyncTool.description,
    singlePdfSchema,
    async (input) => handleGeneratePdfAsync(input),
  );

  // generate_pdfs_sync
  server.tool(
    generatePdfsSyncTool.name,
    generatePdfsSyncTool.description,
    multiplePdfSchema,
    async (input) => handleGeneratePdfsSync(input),
  );

  // generate_pdfs_async
  server.tool(
    generatePdfsAsyncTool.name,
    generatePdfsAsyncTool.description,
    multiplePdfSchema,
    async (input) => handleGeneratePdfsAsync(input),
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
    },
    async (input) => handleDownloadFile(input),
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
    },
    async (input) => handleDownloadZip(input),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
};
