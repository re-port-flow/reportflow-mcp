# reportflow-mcp

[![npm version](https://img.shields.io/npm/v/reportflow-mcp.svg)](https://www.npmjs.com/package/reportflow-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

[ReportFlow](https://re-port-flow.com) で作成したテンプレートから PDF 帳票 (請求書・契約書・報告書など) を生成する MCP (Model Context Protocol) サーバー。Claude や AI エージェントから自然言語で帳票を依頼できます。

## できること

- 「請求書を株式会社サンプル宛に 3 万円で作って」のような自然文で **PDF 即時生成**
- ReportFlow のデザイン一覧・パラメータスキーマを **AI のコンテキストに直接貼り付け**
- 複数件を **ZIP で一括生成**
- 生成した PDF は **作業中のワークスペース直下に自動保存**

## セットアップ

### Claude Desktop / Claude Code / Cursor

設定ファイル (`.mcp.json`, `claude_desktop_config.json`, `~/.cursor/mcp.json` など) に追加:

```json
{
  "mcpServers": {
    "reportflow": {
      "command": "npx",
      "args": ["-y", "reportflow-mcp"]
    }
  }
}
```

これだけです。

### VS Code (MCP 対応版)

`.vscode/mcp.json` に同形式で追加。

### 動作要件

- Node.js 18+ (npx 経由なので自動取得)
- ブラウザが起動できるローカル環境 (初回認証時に必要)
- ReportFlow アカウント (https://re-port-flow.com)

## 使い方

### 1. 初回認証

クライアントをリロード後、AI にこう頼みます:

> ReportFlow で認証して

ブラウザが起動するので、**ログイン → ワークスペース選択 → 同意** で完了。
トークンは OS の Keychain (macOS Keychain / Windows Credential Manager / Linux libsecret) に保存され、以後は自動更新されます。

### 2. 帳票を作る

#### 自然文で依頼 (一番楽)

> 請求書テンプレで、宛先「株式会社サンプル」、合計 33,000 円の PDF を作って

AI が `list_templates` でデザインを探し、`get_design_parameters` で必要項目を確認し、`generate_pdf_sync` で PDF を生成 → ローカルパスを返します。

#### スラッシュコマンド

| コマンド | 用途 |
|---|---|
| `/generate_pdf` | 単一 PDF 生成のステップガイド |
| `/generate_pdfs` | 複数 PDF 一括生成のガイド |
| `/reportflow_help` | 機能ヘルプ |

### 3. 保存先のルール

PDF の保存先は次の順で決まります:

1. AI に「Desktop に保存して」のように明示指示 → そのパス
2. 指示なし → クライアントの開いているワークスペース直下
3. 上記が取れない → OS の一時ディレクトリ

## できること詳細

### Tools (AI が呼び出す)

| ツール | 用途 |
|---|---|
| `authenticate` | 初回 / 再認証 |
| `list_templates` | デザイン一覧を取得 |
| `get_design_parameters` | デザインに必要なパラメータ構造を取得 |
| `generate_pdf_sync` / `_async` | 単一 PDF 生成 (即時 / 非同期) |
| `generate_pdfs_sync` / `_async` | 複数 PDF 一括生成 (ZIP 即時 / 非同期) |
| `download_file` / `download_zip` | 非同期生成したファイルをダウンロード |
| `suggest_params` | 自然文要件から params JSON を整形 (Sampling 対応クライアント要) |

### Resources (AI に直接コンテキスト追加できる URI)

| URI | 内容 |
|---|---|
| `reportflow://designs` | 利用可能なデザイン一覧 |
| `reportflow://designs/{designId}/parameters` | デザインのパラメータスキーマ |
| `reportflow://errors` | エラーメッセージカタログ |
| `reportflow://server-info` | サーバー機能の概観 |

### Prompts (スラッシュコマンドのレシピカード)

`/generate_pdf` `/generate_pdfs` `/reportflow_help` の 3 種類。引数を入れれば AI がそのまま実行手順を組み立てます。

## トラブルシューティング

| 症状 | 対応 |
|---|---|
| `再認証が必要です` のエラー | AI に「ReportFlow で再認証して」と依頼 |
| `npx` が package を見つけない | `npm cache clean --force` 後に再実行 |
| Linux で Keychain が無い | 自動的に `$XDG_STATE_HOME/reportflow-mcp/` (chmod 0600) にフォールバック保存 |
| SSH/リモート環境でブラウザが開かない | 認証は **ローカル端末で 1 回**実施。トークンが Keychain に保存されたあとはリモート利用も可 |

## ライセンス

MIT — [LICENSE](./LICENSE) を参照。

## リンク

- ReportFlow 本体: https://re-port-flow.com
- npm: https://www.npmjs.com/package/reportflow-mcp
- Issue 報告: https://github.com/re-port-flow/reportflow-mcp/issues
