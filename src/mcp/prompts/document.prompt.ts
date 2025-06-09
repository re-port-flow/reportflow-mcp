// src/mcp/prompts/document.prompt.ts
import { Injectable, Logger } from '@nestjs/common';
import { Prompt } from '@/mcp';
import { z } from 'zod';
import { McpService } from '@/mcp/mcp.service';

@Injectable()
export class DocumentPrompt {
  private readonly logger = new Logger(DocumentPrompt.name);

  constructor(private readonly mcpService: McpService) {}

  @Prompt({
    name: 'create_receipt',
    description: '領収書を作成するためのプロンプト',
    parameters: z.object({
      宛名: z.string().describe('領収書の宛名（例：ABC株式会社）'),
      金額: z.string().describe('金額（例：10000）'),
      日付: z.string().optional().describe('発行日（省略時は今日の日付）'),
      但し書き: z.string().optional().describe('但し書き（省略可）'),
    }),
  })
  async createReceipt(params: any) {
    try {
      // Get template first
      const template = await this.mcpService.getDesignTemplate('領収書');

      // Convert string amount to number if needed
      const processedParams = {
        ...params,
        金額:
          typeof params.金額 === 'string'
            ? parseInt(params.金額.replace(/[,，円]/g, ''), 10)
            : params.金額,
      };

      // Set default date if not provided
      if (!processedParams.日付) {
        const today = new Date();
        processedParams.日付 = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
      }

      return {
        description: '領収書作成の確認',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `以下の内容で領収書を作成します：

宛名: ${processedParams.宛名}
金額: ¥${processedParams.金額.toLocaleString()}
日付: ${processedParams.日付}
${processedParams.但し書き ? `但し書き: ${processedParams.但し書き}` : ''}

この内容で領収書を作成する場合は、create_document_from_prompt ツールを使用してください。
設計ID: ${template.designId}
パラメータ: ${JSON.stringify(processedParams)}`,
            },
          },
        ],
      };
    } catch (error) {
      this.logger.error('Failed to prepare receipt prompt:', error);
      return {
        description: 'エラー',
        messages: [
          {
            role: 'assistant',
            content: {
              type: 'text',
              text: `領収書テンプレートの取得に失敗しました: ${error.message}`,
            },
          },
        ],
      };
    }
  }

  @Prompt({
    name: 'create_invoice',
    description: '請求書を作成するためのプロンプト',
    parameters: z.object({
      宛名: z.string().describe('請求書の宛名（例：XYZ商事）'),
      金額: z.string().describe('請求金額（例：50000）'),
      件名: z.string().describe('請求件名'),
      請求日: z.string().optional().describe('請求日（省略時は今日の日付）'),
      支払期限: z.string().optional().describe('支払期限'),
    }),
  })
  async createInvoice(params: any) {
    try {
      const template = await this.mcpService.getDesignTemplate('請求書');

      const processedParams = {
        ...params,
        金額:
          typeof params.金額 === 'string'
            ? parseInt(params.金額.replace(/[,，円]/g, ''), 10)
            : params.金額,
      };

      if (!processedParams.請求日) {
        const today = new Date();
        processedParams.請求日 = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
      }

      return {
        description: '請求書作成の確認',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `以下の内容で請求書を作成します：

宛名: ${processedParams.宛名}
件名: ${processedParams.件名}
金額: ¥${processedParams.金額.toLocaleString()}
請求日: ${processedParams.請求日}
${processedParams.支払期限 ? `支払期限: ${processedParams.支払期限}` : ''}

この内容で請求書を作成する場合は、create_document_from_prompt ツールを使用してください。
設計ID: ${template.designId}
パラメータ: ${JSON.stringify(processedParams)}`,
            },
          },
        ],
      };
    } catch (error) {
      return {
        description: 'エラー',
        messages: [
          {
            role: 'assistant',
            content: {
              type: 'text',
              text: `請求書テンプレートの取得に失敗しました: ${error.message}`,
            },
          },
        ],
      };
    }
  }

  @Prompt({
    name: 'create_quote',
    description: '見積書を作成するためのプロンプト',
    parameters: z.object({
      宛名: z.string().describe('見積書の宛名'),
      金額: z.string().describe('見積金額'),
      件名: z.string().describe('見積件名'),
      有効期限: z.string().optional().describe('見積有効期限'),
      納期: z.string().optional().describe('納期'),
    }),
  })
  async createQuote(params: any) {
    try {
      const template = await this.mcpService.getDesignTemplate('見積書');

      const processedParams = {
        ...params,
        金額:
          typeof params.金額 === 'string'
            ? parseInt(params.金額.replace(/[,，円]/g, ''), 10)
            : params.金額,
      };

      const today = new Date();
      if (!processedParams.見積日) {
        processedParams.見積日 = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
      }

      return {
        description: '見積書作成の確認',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `以下の内容で見積書を作成します：

宛名: ${processedParams.宛名}
件名: ${processedParams.件名}
金額: ¥${processedParams.金額.toLocaleString()}
${processedParams.有効期限 ? `有効期限: ${processedParams.有効期限}` : ''}
${processedParams.納期 ? `納期: ${processedParams.納期}` : ''}

この内容で見積書を作成する場合は、create_document_from_prompt ツールを使用してください。
設計ID: ${template.designId}
パラメータ: ${JSON.stringify(processedParams)}`,
            },
          },
        ],
      };
    } catch (error) {
      return {
        description: 'エラー',
        messages: [
          {
            role: 'assistant',
            content: {
              type: 'text',
              text: `見積書テンプレートの取得に失敗しました: ${error.message}`,
            },
          },
        ],
      };
    }
  }
}
