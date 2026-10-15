import { z } from 'zod';
import type { PromptResult } from './generate-pdf-recipe.js';
import { TEMPLATE_SELECTION_INSTRUCTION } from './template-selection.js';

export const generatePdfsPromptDef = {
  name: 'generate_pdfs',
  description:
    '複数件の PDF を一括で出力するためのレシピプロンプト。CSV や表形式データから ZIP 出力する流れを Claude に提示します。',
  argsSchema: {
    designId: z
      .string()
      .optional()
      .describe(
        'designId（テンプレートのID。list_templates の id。16 文字の英数字で UUID ではない。例: 0eUDdgAjNXrrItA2）。未指定の場合は list_templates から選ぶ手順を含めます。',
      ),
    source: z
      .string()
      .optional()
      .describe(
        'データソースの説明（例: "./data.csv の各行を 1 件として処理" 等）',
      ),
    outputDir: z
      .string()
      .optional()
      .describe(
        '保存先ディレクトリ。未指定時はクライアントのワークスペース直下。',
      ),
    zipFileName: z
      .string()
      .optional()
      .describe('出力 ZIP のファイル名 (省略時は download.zip)'),
  },
};

export type GeneratePdfsPromptInput = {
  designId?: string;
  source?: string;
  outputDir?: string;
  zipFileName?: string;
};

export const handleGeneratePdfsPrompt = (
  input: GeneratePdfsPromptInput,
): PromptResult => {
  const lines = [
    'Re:port Flow で複数の PDF を一括で出力します。次の手順で進めてください。',
    '',
    input.designId
      ? `1. designId は \`${input.designId}\` を使用します。\`list_templates\` を呼んで該当テンプレートの \`latestVersion\` を確認し、続けて \`get_design_parameters\` でパラメータ構造を取得してください。`
      : TEMPLATE_SELECTION_INSTRUCTION,
    input.source
      ? `2. 以下のデータソースを 1 件 1 件展開して \`contents\` 配列を組み立ててください: ${input.source}`
      : '2. ユーザーから件数分のデータ（CSV / 表 / 配列）を受け取り、各行を `{ fileName, params }` の形に展開して `contents` 配列を組み立ててください。',
    '   - スキーマで型が "date" のフィールドは "YYYY-MM-DD" 形式に揃えること。',
    '   - 値が判断できないフィールドは必ずユーザーに確認すること（プレースホルダー禁止）。',
    `3. \`generate_pdfs_sync\` は生成が 60 秒を超えるとタイムアウト (504) し、ZIP を受け取れません。60 秒以内に終わると見込める少ない件数のときだけ \`generate_pdfs_sync\` で即時 ZIP 取得し、件数が多い・かかる時間が読めない場合は \`generate_pdfs_async\` → \`get_generation_status\` で status が completed になるのを確認 → \`download_zip\` の流れを使ってください（\`version\` は手順 1 で確認した \`latestVersion\` を渡すこと）。${
      input.outputDir
        ? `outputDir は \`${input.outputDir}\` を使用してください。`
        : 'outputDir はユーザーが明示した場合のみ指定すること。'
    }${input.zipFileName ? ` zipFileName は \`${input.zipFileName}\` を使用してください。` : ''}`,
    '4. 出力完了後の ZIP パスをユーザーに伝えてください。',
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
