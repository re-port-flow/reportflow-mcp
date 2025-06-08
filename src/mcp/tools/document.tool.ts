// src/mcp/tools/document.tool.ts
import { Injectable, Logger } from '@nestjs/common';
import { Tool, Context } from '@/mcp';
import { z } from 'zod';
import { McpService } from '@/mcp/mcp.service';

@Injectable()
export class DocumentTool {
  private readonly logger = new Logger(DocumentTool.name);

  constructor(private readonly mcpService: McpService) {}

  @Tool({
    name: 'create_document',
    description: `Creates a document based on a template.
    Use this tool when the user wants to create documents like receipts (領収書), invoices, or other templated documents.
    The tool will fetch the template structure and create the document with the provided data.`,
    parameters: z.object({
      label: z
        .string()
        .describe('The document type label (e.g., "領収書" for receipt)'),
      documentData: z
        .record(z.any())
        .describe(
          'The data to fill in the template. This should match the template parameters.',
        ),
    }),
  })
  async createDocument({ label, documentData }, context: Context) {
    try {
      // Step 1: Get the design template
      this.logger.log(`Fetching template for label: ${label}`);
      const template = await this.mcpService.getDesignTemplate(label);

      // Step 2: Validate that all required parameters are provided
      const validation = await this.mcpService.validateDocumentParams(
        label,
        documentData,
      );

      if (!validation.valid) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Validation failed:\n${validation.errors.join('\n')}\n\nRequired parameters: ${JSON.stringify(validation.template, null, 2)}`,
            },
          ],
        };
      }

      // Step 3: Create the document
      const documentRequest = {
        designId: template.designId,
        version: template.version,
        contents: {
          fileName: template.contents.fileName,
          params: documentData,
        },
      };

      this.logger.log(
        `Creating document with data: ${JSON.stringify(documentRequest)}`,
      );
      const result = await this.mcpService.createDocument(documentRequest);

      return {
        content: [
          {
            type: 'text',
            text: `✅ Document created successfully!\n\nDesign ID: ${template.designId}\nFile Name: ${template.contents.fileName}\nParameters used: ${JSON.stringify(documentData, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      this.logger.error(`Failed to create document: ${error.message}`);
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error creating document: ${error.message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'get_document_template',
    description:
      'Fetches the template structure for a specific document type. Use this to understand what parameters are required for a document.',
    parameters: z.object({
      label: z
        .string()
        .describe('The document type label (e.g., "領収書" for receipt)'),
    }),
  })
  async getDocumentTemplate({ label }, context: Context) {
    try {
      const template = await this.mcpService.getDesignTemplate(label);

      return {
        content: [
          {
            type: 'text',
            text: `Template for "${label}":\n\nDesign ID: ${template.designId}\nVersion: ${template.version}\nFile Name: ${template.contents.fileName}\n\nRequired Parameters:\n${JSON.stringify(template.contents.params, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error fetching template: ${error.message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'parse_japanese_document_request',
    description: `Parses a Japanese document creation request and extracts the label and parameters.
    Common patterns:
    - "〇〇宛に△△円の領収書を作成" → Receipt for 〇〇 with amount △△
    - "〇〇様への請求書を作成" → Invoice for 〇〇
    This tool helps identify the document type and extract relevant data.`,
    parameters: z.object({
      userMessage: z.string().describe('The user message in Japanese'),
    }),
  })
  async parseJapaneseRequest({ userMessage }, context: Context) {
    // Common document type patterns
    const documentPatterns = [
      { pattern: /領収書/, label: '領収書', type: 'receipt' },
      { pattern: /請求書/, label: '請求書', type: 'invoice' },
      { pattern: /見積書/, label: '見積書', type: 'quote' },
      { pattern: /納品書/, label: '納品書', type: 'delivery_note' },
    ];

    // Find which document type is mentioned
    const matchedDoc = documentPatterns.find((doc) =>
      doc.pattern.test(userMessage),
    );

    if (!matchedDoc) {
      return {
        content: [
          {
            type: 'text',
            text: 'No recognized document type found in the message.',
          },
        ],
      };
    }

    // Extract common parameters
    const extractedData: Record<string, any> = {
      documentType: matchedDoc.label,
    };

    // Extract recipient (宛名)
    const recipientMatch = userMessage.match(/(.+?)(宛|様|御中|さん|さま)/);
    if (recipientMatch) {
      extractedData.宛名 = recipientMatch[1].trim();
    }

    // Extract amount (金額)
    const amountMatch = userMessage.match(/(\d+(?:,\d{3})*|\d+)円/);
    if (amountMatch) {
      extractedData.金額 = parseInt(amountMatch[1].replace(/,/g, ''), 10);
    }

    // Extract date patterns
    const dateMatch = userMessage.match(/(\d{4}年\d{1,2}月\d{1,2}日)/);
    if (dateMatch) {
      extractedData.日付 = dateMatch[1];
    }

    return {
      content: [
        {
          type: 'text',
          text: `Parsed request:\n\nDocument Type: ${matchedDoc.label}\nExtracted Data:\n${JSON.stringify(extractedData, null, 2)}\n\n💡 Tip: Use the 'get_document_template' tool with label "${matchedDoc.label}" to see required parameters, then use 'create_document' to generate the document.`,
        },
      ],
    };
  }
}
