import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export class SamplingUnsupportedError extends Error {
  constructor(detail?: string) {
    super(
      detail
        ? `クライアントが Sampling 未対応です: ${detail}`
        : 'クライアントが Sampling (LLM 呼び出し) 未対応です。Claude Desktop など Sampling 対応クライアントから再度実行してください。',
    );
    this.name = 'SamplingUnsupportedError';
  }
}

export type SamplingTextResult = {
  model: string;
  text: string;
};

export const requestSamplingText = async (
  server: McpServer,
  prompt: string,
  options: { maxTokens?: number; systemPrompt?: string } = {},
): Promise<SamplingTextResult> => {
  try {
    const response = await server.server.createMessage({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: prompt },
        },
      ],
      maxTokens: options.maxTokens ?? 1024,
      systemPrompt: options.systemPrompt,
    });
    const content = response.content;
    if (content.type !== 'text') {
      throw new SamplingUnsupportedError(
        `unexpected content type: ${content.type}`,
      );
    }
    return { model: response.model, text: content.text };
  } catch (err) {
    if (err instanceof SamplingUnsupportedError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (
      /method not found|not supported|unsupported|capability/i.test(message)
    ) {
      throw new SamplingUnsupportedError(message);
    }
    throw err;
  }
};
