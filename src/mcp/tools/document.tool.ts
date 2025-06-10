import { Inject, Injectable, Logger } from '@nestjs/common';
import { Progress } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Tool, Context } from '@/mcp';
import { McpService } from '@/mcp/mcp.service';
import { CreateDocumentDto } from '@/mcp/dto/create-document.dto';
import { AxiosError } from 'axios';

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
  async getDocumentTemplate({ label }: { label: string }) {
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
            text: `❌ テンプレート取得エラー: ${(error as AxiosError).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'create_document',
    description: `テンプレートを使用して文書（PDF）を作成します。まずget_document_templateでテンプレート情報を取得してから使用してください。
    
重要: labelパラメータを提供すると、fileNameは自動的にテンプレートから取得されます。カスタムfileNameを使用したい場合のみfileNameパラメータを指定してください。`,
    parameters: z.object({
      designId: z
        .string()
        .describe('デザインID（get_document_templateで取得）'),
      version: z.number().describe('テンプレートのバージョン'),
      fileName: z
        .string()
        .optional()
        .describe(
          'ファイル名（省略時はテンプレートのデフォルトファイル名を使用）',
        ),
      label: z
        .string()
        .optional()
        .describe('文書タイプ（fileNameを自動取得する場合に必要）'),
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
      label,
      params,
    }: {
      designId: string;
      version: number;
      fileName?: string;
      label?: string;
      params: Record<string, any>;
    },
    context: Context,
  ) {
    try {
      await context.reportProgress({
        progress: 10,
        total: 100,
      } as Progress);

      this.logger.log(`Creating document with designId: ${designId}`);

      let finalFileName = fileName;
      if (!finalFileName && label) {
        this.logger.log(
          `Fetching template to get default fileName for label: ${label}`,
        );
        const template = await this.mcpService.getDesignTemplate(label);
        finalFileName = template.contents.fileName;
        this.logger.log(`Using template fileName: ${finalFileName}`);
      }

      if (!finalFileName) {
        throw new Error(
          'fileNameが必要です。fileNameパラメータを指定するか、labelパラメータを提供してテンプレートから自動取得してください。',
        );
      }

      await context.reportProgress({
        progress: 20,
        total: 100,
      } as Progress);

      if (label) {
        const validation = await this.mcpService.validateDocumentParams(
          label,
          params,
        );
        if (!validation.valid) {
          throw new Error(
            `パラメータ検証エラー:\n${validation.errors.join('\n')}`,
          );
        }
      }

      const documentData: CreateDocumentDto = {
        designId: designId,
        version,
        content: {
          fileName: finalFileName,
          params,
        },
      };

      // Progress report: Sending request
      await context.reportProgress({
        progress: 50,
        total: 100,
      } as Progress);

      // Call the API to create the document
      const result = await this.mcpService.createDocument(
        documentData,
        label || '',
      );

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
- ファイル名: ${finalFileName}
- デザインID: ${designId}
- パラメータ: ${JSON.stringify(params, null, 2)}

📊 **結果:**
${JSON.stringify(result, null, 2)}

🎉 PDF文書が正常に生成されました！`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ 文書作成エラー: ${(error as AxiosError).message}

🔍 **入力データを確認してください:**
- デザインID: ${designId}
- バージョン: ${version}
- ファイル名: ${fileName || '(テンプレートから自動取得)'}
- ラベル: ${label || '(未指定)'}
- パラメータ: ${JSON.stringify(params, null, 2)}`,
          },
        ],
      };
    }
  }
}
