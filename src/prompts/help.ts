import type { PromptResult } from './generate-pdf-recipe.js';

export const reportflowHelpPromptDef = {
  name: 'reportflow_help',
  description:
    'Re:port Flow MCP サーバーの利用可能機能（Tools / Prompts / Resources / Sampling）の概要を提示します。',
};

export const handleReportflowHelp = (): PromptResult => {
  const text = [
    '# Re:port Flow MCP サーバー — 機能概観',
    '',
    '## Prompts（スラッシュコマンドから呼ぶレシピ）',
    '- `/generate_pdf` — PDF を 1 件出力するステップガイド',
    '- `/generate_pdfs` — 複数の PDF を一括で出力するステップガイド',
    '- `/reportflow_help` — このヘルプ',
    '',
    '## Tools（AI が必要に応じて呼ぶ）',
    '- `authenticate` — OAuth2 PKCE 初回認証 / 再認証',
    '- `list_templates` — テンプレート一覧',
    '- `get_design_parameters` — パラメータスキーマ取得',
    '- `generate_pdf_sync` / `generate_pdf_async` — PDF を 1 件出力',
    '- `generate_pdfs_sync` / `generate_pdfs_async` — 複数の PDF を一括で出力',
    '- `get_generation_status` — 非同期出力 (requestId) の状態確認 (生成中 / 完了 / 失敗)',
    '- `download_file` / `download_zip` — 非同期で出力した PDF のダウンロード',
    '- `suggest_params` — Sampling でクライアント AI に params JSON を整形させる',
    '',
    '## Resources（コンテキストとして添付できる生データ）',
    '- `reportflow://designs` — テンプレート一覧 JSON',
    '- `reportflow://designs/{designId}/parameters` — 各テンプレートのパラメータスキーマ',
    '- `reportflow://errors` — Content Service エラーカタログ',
    '- `reportflow://server-info` — サーバー設定とフロー概観',
    '',
    '## Sampling',
    '`suggest_params` ツール内で `sampling/createMessage` を使い、サーバー側 API キー無しでクライアント AI に JSON 生成を委譲します。Sampling 未対応クライアント（stdio 単体クライアント等）では当該ツールはエラーになります。',
    '',
    '## Roots',
    '`generate_pdf_sync` / `generate_pdfs_sync` で `outputDir` 未指定時、クライアントが提示するワークスペース（VS Code 等）直下に保存します。Roots 未対応クライアント / 取得失敗時は OS の一時ディレクトリにフォールバックします。',
    '',
    '詳細は README / CLAUDE.md を参照してください。',
  ].join('\n');
  return {
    messages: [
      {
        role: 'user',
        content: { type: 'text', text },
      },
    ],
  };
};
