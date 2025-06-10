import type { Request } from 'express';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Progress } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Tool, Context } from '@/mcp';
import { McpService } from '@/mcp/mcp.service';
import { CreateDocumentDto } from '@/mcp/dto/create-document.dto';

@Injectable()
export class DocumentTool {
  constructor() {}
  private readonly logger = new Logger('Document');
  @Inject(McpService)
  private readonly mcpService: McpService;

  @Tool({
    name: 'get_document_template',
    description: '文書タイプのテンプレート構造を取得して表示します。',
    parameters: z.object({
      label: z
        .string()
        .describe('文書タイプ（例: "領収書", "請求書", "見積書", "納品書"）'),
    }),
  })
  async getDocumentTemplate({ label }, context: Context) {
    try {
      const template = await this.mcpService.getDesignTemplate(label);

      const requiredFields = Object.entries(template.contents.params)
        .map(([key, type]) => `- ${key} (${type})`)
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `"${label}" テンプレート情報:

デザインID: ${template.designId}
バージョン: ${template.version}
ファイル名: ${template.contents.fileName}

必須フィールド:
${requiredFields}

このテンプレートを使用して文書を作成するには、上記のフィールドすべてに値を入力する必要があります。`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ テンプレート取得エラー: ${error.message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'create_document',
    description:
      'テンプレートを使用して文書（PDF）を作成します。まずget_document_templateでテンプレート情報を取得してから使用してください。',
    parameters: z.object({
      designId: z
        .string()
        .describe('デザインID（get_document_templateで取得）'),
      version: z.number().describe('テンプレートのバージョン'),
      fileName: z.string().describe('ファイル名'),
      params: z
        .record(z.any())
        .describe('文書のパラメータ（テンプレートの必須フィールドに対応）'),
    }),
  })
  async createDocument(
    {
      designId,
      version,
      fileName,
      params,
    }: {
      designId: string;
      version: number;
      fileName: string;
      params: CreateDocumentDto;
    },
    context: Context,
  ) {
    try {
      // Progress report: Starting document creation
      await context.reportProgress({
        progress: 10,
        total: 100,
      } as Progress);

      this.logger.log(`Creating document with designId: ${designId}`);

      // Validate the document structure
      const documentData: CreateDocumentDto = {
        designId: designId,
        version,
        content: {
          fileName,
          params,
        },
      };

      // Progress report: Sending request
      await context.reportProgress({
        progress: 30,
        total: 100,
      } as Progress);

      // Call the API to create the document
      const result = await this.mcpService.createDocument(documentData);

      // Progress report: Document created
      await context.reportProgress({
        progress: 100,
        total: 100,
      } as Progress);

      this.logger.log(`Document creation successful:`, result);

      return {
        content: [
          {
            type: 'text',
            text: `✅ 文書作成成功！

📄 **作成された文書:**
- ファイル名: ${fileName}
- デザインID: ${designId}
- パラメータ: ${JSON.stringify(params, null, 2)}

📊 **結果:**
${JSON.stringify(result, null, 2)}

🎉 PDF文書が正常に生成されました！`,
          },
        ],
      };
    } catch (error) {
      this.logger.error('Document creation error:', error);
      return {
        content: [
          {
            type: 'text',
            text: `❌ 文書作成エラー: ${error.message}

🔍 **入力データを確認してください:**
- デザインID: ${designId}
- バージョン: ${version}
- ファイル名: ${fileName}
- パラメータ: ${JSON.stringify(params, null, 2)}`,
          },
        ],
      };
    }
  }
}
