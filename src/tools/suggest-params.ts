import type { McpServer } from '@modelcontextprotocol/server';
import { getDesignParameters } from '../client.js';
import type { GetDesignParametersResponse } from '../client.js';
import {
  requestSamplingText,
  SamplingUnsupportedError,
} from '../sampling/request.js';

export const suggestParamsTool = {
  name: 'suggest_params',
  description:
    '自然文の要件と designId から、クライアント AI（Sampling）で generate_pdf_sync 用の params JSON を下書きします。【Sampling 必須】claude.ai 等の Sampling 非対応クライアントでは自動生成できず、その場合はパラメータスキーマをそのまま返すので手動で params を埋めてください。パラメータ構造の確認だけが目的なら get_design_parameters を使ってください。サーバー側 API キー不要。生成された params は必ずユーザー承認のうえ generate_pdf_sync に渡してください。',
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
    'Re:port Flow の PDF テンプレート用 params JSON を生成してください。',
    '',
    '【パラメータスキーマ】',
    JSON.stringify(schema, null, 2),
    '',
    '【ユーザー要件】',
    description,
    '',
    'ルール:',
    '- スキーマ内の "name" / "type" / "label" / "description" / "spec" は各パラメータの定義（メタデータ）を表すプロパティ名です。これらのプロパティ名そのものを出力 JSON のキーにしないでください。',
    '- 出力 JSON のキーには実際のパラメータ名（各定義の "name" の値）を使ってください。"name" の値が "description" 等であれば、それは正当な出力キーになります（メタデータ用キーと混同しないこと）。',
    '- 定義に "description" があれば、それはそのパラメータの意味・入力ガイドです。値を解釈・選択する際は必ず参照してください。',
    '- "type" が "date" のパラメータは "YYYY-MM-DD" 形式の文字列にしてください。',
    '- "type" が "array" / "collection" のパラメータは "spec" の構造に従って入れ子の値にし、それ以外は要件から導出した具体値（文字列・数値・真偽値・null）を直接設定してください。',
    '- 値が要件から判断できないフィールドは null を入れてください（プレースホルダー文字列禁止）。',
    '- 出力は JSON オブジェクトのみ。コードフェンス禁止。',
  ].join('\n');

/** クライアントが Sampling (LLM 呼び出し) capability を宣言しているか。 */
const clientSupportsSampling = (server: McpServer): boolean => {
  // 古い SDK / カスタム実装では getClientCapabilities を持たない可能性がある。
  // その場合に false を返すと対応クライアントでも Sampling を無効化してしまうため、
  // 判定不能時は実行を試み、requestSamplingText 側の SamplingUnsupportedError
  // 捕捉に委ねる（未定義メソッド呼び出しによるクラッシュも防ぐ）。
  if (typeof server.server.getClientCapabilities !== 'function') {
    return true;
  }
  return server.server.getClientCapabilities()?.sampling != null;
};

/**
 * Sampling 非対応クライアント (claude.ai 等) 向けフォールバック。
 * 取得済みのパラメータスキーマと手動入力ガイドを返し、
 * 「suggest_params に逃げても何も得られない」デッドエンドを防ぐ。
 * get_design_parameters と同等の情報を返すため、後続の手動 params 組み立てに使える。
 */
const samplingUnavailableResult = (
  schema: GetDesignParametersResponse,
  reason: string,
): SuggestParamsResult => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(
        {
          samplingUnavailable: true,
          reason,
          guidance:
            'このクライアントは Sampling（LLM 呼び出し）非対応のため params を自動生成できません。下記 parameters のスキーマに従って各値をユーザーに確認し、generate_pdf_sync の content.params へ手動で渡してください。スキーマに無いキーは追加しないこと。構造確認だけが目的なら get_design_parameters を使ってください。',
          parameters: schema,
        },
        null,
        2,
      ),
    },
  ],
});

export const handleSuggestParams = async (
  server: McpServer,
  input: SuggestParamsInput,
): Promise<SuggestParamsResult> => {
  let schema: GetDesignParametersResponse;
  try {
    schema = await getDesignParameters(input.designId, input.version);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }

  // Sampling 非対応クライアントでは LLM 呼び出しができないため、無駄な往復をせず
  // 取得済みスキーマ + 手動入力ガイドを返して処理を成立させる。
  if (!clientSupportsSampling(server)) {
    return samplingUnavailableResult(schema, 'client-capability-missing');
  }

  try {
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
    // 安全網: capability 上は Sampling 可でも、実際の呼び出しが Method not found 等で
    // 失敗するクライアントでも、エラーで終わらせずスキーマを返す。
    if (err instanceof SamplingUnsupportedError) {
      return samplingUnavailableResult(schema, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
