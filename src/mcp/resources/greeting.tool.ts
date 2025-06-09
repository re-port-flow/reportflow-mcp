import type { Request } from 'express';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Progress } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Tool, Context } from '@/mcp';
import { McpService } from '@/mcp/mcp.service';

@Injectable()
export class GreetingTool {
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
    outputSchema: z.object({
      type: z.literal('text'),
      text: z.string(),
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
    name: 'test-structured',
    description:
      'Returns a greeting and simulates a long operation with progress updates',
    parameters: z.object({
      name: z.string().default('World'),
    }),
    outputSchema: z.object({
      type: z.literal('text'),
      text: z.string(),
    }),
    annotations: {
      title: 'Greeting Tool',
      destructiveHint: false,
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async sayHelloStructured({ name }, context: Context, request: Request) {
    let greeting: string;

    // request is not defined for stdio server
    if (request && typeof request.get === 'function') {
      const userAgent = request.get('user-agent') || 'Unknown';
      greeting = `Hello, ${name}! Your user agent is: ${userAgent}`;
    } else {
      greeting = `Hello, ${name}!`;
    }

    const totalSteps = 5;
    for (let i = 0; i < totalSteps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Send a progress update.
      await context.reportProgress({
        progress: (i + 1) * 20,
        total: 100,
      } as Progress);
    }

    const structuredContent = { type: 'text', text: greeting };
    return {
      structuredContent,
      content: [
        {
          type: 'text',
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
    };
  }
}
