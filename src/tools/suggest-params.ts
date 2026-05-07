import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDesignParameters } from '../client.js';
import { requestSamplingText } from '../sampling/request.js';

export const suggestParamsTool = {
  name: 'suggest_params',
  description:
    '自然文の要件と designId からクライアント AI（Sampling）を使って generate_pdf_sync の params JSON を組み立てます。サーバー側 API キー不要。Sampling 未対応クライアントでは利用不可です。生成された params は内容確認のうえユーザーの承認を得てから generate_pdf_sync に渡してください。',
};

export type SuggestParamsInput = {
  designId: string;
  version?: number;
  description: string;
};

export type SuggestParamsResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

export const parseJsonLoose = (raw: string): unknown => {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as unknown;
    } catch {
      return null;
    }
  }
};

const buildPrompt = (schema: unknown, description: string): string =>
  [
    'ReportFlow の PDF テンプレート用 params JSON を生成してください。',
    '',
    '【パラメータスキーマ】',
    JSON.stringify(schema, null, 2),
    '',
    '【ユーザー要件】',
    description,
    '',
    'ルール:',
    '- スキーマで型が "date" のフィールドは "YYYY-MM-DD" 形式の文字列にしてください。',
    '- スキーマに存在しないキーを追加しないでください。',
    '- 値が要件から判断できないフィールドは null を入れてください（プレースホルダー文字列禁止）。',
    '- 出力は JSON オブジェクトのみ。コードフェンス禁止。',
  ].join('\n');

export const handleSuggestParams = async (
  server: McpServer,
  input: SuggestParamsInput,
): Promise<SuggestParamsResult> => {
  try {
    const schema = await getDesignParameters(input.designId, input.version);
    const prompt = buildPrompt(schema, input.description);
    const sampled = await requestSamplingText(server, prompt, {
      maxTokens: 2048,
      systemPrompt:
        'あなたは厳密な JSON 生成エンジンです。要求された JSON のみを返してください。',
    });
    const parsed = parseJsonLoose(sampled.text);
    if (parsed != null) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { params: parsed, model: sampled.model },
              null,
              2,
            ),
          },
        ],
      };
    }
    // Self-correction once
    const retryPrompt = [
      '直前の出力が JSON として解釈できませんでした。次の文字列を有効な JSON オブジェクトに修正してください。',
      sampled.text,
      '',
      '出力は JSON のみ。',
    ].join('\n');
    const retry = await requestSamplingText(server, retryPrompt, {
      maxTokens: 2048,
    });
    const retried = parseJsonLoose(retry.text);
    if (retried == null) {
      throw new Error(
        `Sampling 結果を JSON として解釈できませんでした: ${sampled.text.slice(0, 200)}`,
      );
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { params: retried, model: retry.model, retried: true },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
