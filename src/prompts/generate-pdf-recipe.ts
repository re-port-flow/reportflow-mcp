import { z } from 'zod';
import { TEMPLATE_SELECTION_INSTRUCTION } from './template-selection.js';

export const generatePdfPromptDef = {
  name: 'generate_pdf',
  description:
    '単一の PDF 帳票を生成するためのレシピプロンプト。テンプレート選択 → パラメータ確認 → 生成のステップを Claude に提示します。',
  argsSchema: {
    designId: z
      .string()
      .optional()
      .describe(
        'デザインID（UUID）。未指定の場合は list_templates から選ぶ手順を含めます。',
      ),
    description: z
      .string()
      .optional()
      .describe('帳票の内容を自然文で記述（例: "請求書、宛先A社、合計1万円"）'),
    outputDir: z
      .string()
      .optional()
      .describe(
        '保存先ディレクトリ。未指定時はクライアントのワークスペース直下。',
      ),
  },
};

export type GeneratePdfPromptInput = {
  designId?: string;
  description?: string;
  outputDir?: string;
};

export type PromptResult = {
  messages: Array<{
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string };
  }>;
};

export const handleGeneratePdfPrompt = (
  input: GeneratePdfPromptInput,
): PromptResult => {
  const lines = [
    'Re:port Flow で単一の PDF 帳票を生成します。次の手順で進めてください。',
    '',
    input.designId
      ? `1. designId は \`${input.designId}\` を使用します。\`list_templates\` を呼んで該当 design の \`latestVersion\` を確認し、続けて \`get_design_parameters\` でパラメータ構造を取得してください。`
      : TEMPLATE_SELECTION_INSTRUCTION,
    input.description
      ? `2. 以下の要件に基づき、必要な \`params\` を組み立てます: ${input.description}\n   - スキーマの各フィールドに \`description\` があれば、その意味・入力ガイドに沿って値を解釈すること。\n   - スキーマに該当する値が要件にない場合は、ユーザーに具体値を必ず質問すること（プレースホルダー文字列禁止）。`
      : '2. ユーザーから帳票の中身（金額・日付・宛先など）を聞き出し、`get_design_parameters` のスキーマに沿って `params` を組み立ててください。各フィールドに `description` があればその意味・入力ガイドに従い、判断できない値はユーザーに必ず確認すること。',
    `3. \`generate_pdf_sync\` を呼んで PDF を生成します（\`version\` は手順 1 で確認した \`latestVersion\` を渡すこと）。${
      input.outputDir
        ? `outputDir は \`${input.outputDir}\` を使用してください。`
        : 'outputDir はユーザーが明示した場合のみ指定し、未指定なら省略してください（クライアントのワークスペース直下に保存されます）。'
    }`,
    '4. 生成結果のローカルパスをユーザーに伝えてください。',
    '',
    'もし途中で「再認証が必要です」を含むエラーが出た場合は、最初に `authenticate` ツールを呼び直してください。',
  ];
  return {
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: lines.join('\n') },
      },
    ],
  };
};
