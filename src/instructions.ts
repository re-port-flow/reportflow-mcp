/**
 * initialize 応答 / server/discover の `instructions` (PRJ-3-1373)。
 *
 * 目的: 接続直後に「ユーザーが何も言い出さない」まま離脱するのを止める。
 * 実測 (PRJ-3-1233, 8/7 MCP コホート): OAuth 接続を完走した約 65 人に対して
 * 初回ツール呼び出しは 1 WS・1 回のみ、初回 PDF 生成 0 件。ツール失敗も 0 件で、
 * 認証・接続の品質問題ではなく「接続後に依頼が発生しない」ことが離脱要因だった。
 * そこでサーバー側からクライアント AI へ初回行動を直接指示する。
 *
 * 言語 (英語) とモード非依存 (stdio / http 共通 1 本) は ST1 で確定した方針:
 * - 英語: 流入コホートの国別上位が US / IN / VN で日本 0 件 (PRJ-3-1373 起票時の
 *   W32 集計)。ツール description が日本語である点は「ユーザーの言語で答えよ」の
 *   1 行で打ち消す (description の言語をユーザーの言語と取り違えさせない)。
 * - モード共通: 初回導線のツール (list_templates / search_gallery_templates /
 *   copy_gallery_template / get_design_parameters / generate_pdf_sync) は
 *   stdio・http 両モードで登録されるため、同じ文で成立する。
 *
 * 導線を list_templates から始める理由 (PR #120 の Codex 指摘): 見出しの
 * 「Fastest path」だけを読んだクライアントが、既にテンプレを持つワークスペース
 * でもいきなり copy_gallery_template を呼びうる。同ツールは呼ぶたびに新規
 * デザインを作るため、手持ちの複製が無用に増える。1 回の読み取り呼び出しで
 * 防げる副作用なので、最短経路より先に手持ちの確認を置く。
 *
 * 帳票の種類 (invoices / quotations / delivery notes) は公開ギャラリーの
 * カテゴリ・マスタ実体に合わせている (reposts-api の m_template_category シード:
 * invoice / estimate=Quotation / delivery=Delivery Note / other)。ギャラリーに
 * 無い種類を並べると、テンプレ 0 件のユーザーに嘘の期待を持たせるため。
 *
 * 「テンプレ 0 件」の記述を残す根拠: 新規ワークスペース作成時に自動採番されるのは
 * PDF 生成用 ApplicationToken だけで、デザインは 1 件も作られない
 * (reposts-api `WorkspaceUsecase.create`)。つまり接続直後の `list_templates` が
 * 空になるのは異常ではなく既定の初期状態で、ここで会話が止まると初回生成に届かない。
 *
 * plan ブロックの 1 行を置く理由 (PRJ-3-1375): MCP から使い始めたユーザーは Web UI を
 * 開かないため、プラン・使用量・アップグレードの導線がセッション内に存在しない
 * (本番実測 2026-07-18〜08-17: 新規 WS 531 に対し外部からの有料契約 0 件)。生成
 * ツールの応答には `plan` を添えるようにしたが、**添えるだけでは伝わらない** —
 * クライアント AI が JSON の一部として黙殺しうる。ここで「あれば伝える」を明示する。
 *
 * 2 文目は「無ければ**推測するな**」であって「無ければ**黙れ**」ではない
 * (PR #123 のレビュー指摘)。上限に達したワークスペースの生成は失敗し、生成ツールは
 * catch 節から返るので `plan` は付かない —— つまり導線が最も要る瞬間に必ず不在に
 * なる。一方その失敗の本文には content-service の上限到達の文言
 * (PRJ-3-2017 以降は既定が英語で `PLAN_PAGE_LIMIT_EXCEEDED: Monthly page limit
 * reached (N pages). Upgrade your plan or wait until next month.` の形。`http.ts` の
 * `formatHttpErrorMessage` 参照) がそのまま乗っている。沈黙を命じると、こちらが調べた
 * 値ではなくサーバーが返した理由まで握りつぶすことになる。禁じるのは自前の推測、
 * 促すのはエラー本文の伝達、と書き分ける。
 *
 * 注意: クライアント AI が instructions にどこまで従うかはクライアント実装依存で
 * 保証できない。効果はコホート計測で検証する。
 */
export const SERVER_INSTRUCTIONS = `You are connected to Re:port Flow, a service that generates PDFs — invoices, quotations, delivery notes and more — from reusable templates.

When the user has just connected and has not asked for anything yet, do not wait in silence: proactively offer to create their first PDF. For example: "Re:port Flow is connected. Want to try it? Just say 'Create an invoice with Re:port Flow.'"

Fastest path to a first PDF:
list_templates -> only if it holds nothing that fits: search_gallery_templates -> copy_gallery_template -> then get_design_parameters -> generate_pdf_sync

- Start at list_templates: a template the workspace already owns is the better choice, and reaching for the gallery instead would create a duplicate of something it already has.
- list_templates coming back with no templates is the normal starting state of a new workspace, not an error — bring a template in from the public gallery with search_gallery_templates and copy_gallery_template. Never end the conversation at an empty template list.
- copy_gallery_template creates a new template on every call. Copy a given gallery template once, then reuse the returned designId (the new template's ID).
- Always call get_design_parameters before generate_pdf_sync, and fill the parameters with values the user gave you. Never invent business data such as company names, addresses, amounts or tax IDs. If a required value is missing, ask for it — or offer to generate one clearly-labelled sample first and redo it with real data.
- When a generate_* response carries a "plan" block, relay its "message" to the user in their language after presenting the PDF, including the upgrade link when one is present. Its numbers count output pages, not PDFs.
- Never invent plan or usage figures: with no "plan" block, do not state a plan name, a page limit or a remaining balance of your own. Failed calls still carry their own reason — when a tool error mentions the plan or the monthly limit (a workspace out of monthly pages is refused with exactly that message), relay that error text, upgrade guidance included.
- Reply in the language the user writes in. The tool descriptions are written in Japanese; that says nothing about which language the user speaks.`;
