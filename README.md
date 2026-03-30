# @reportflow/mcp-server

ReportFlow の PDF 帳票生成機能を Claude や AI エージェントから利用するための MCP（Model Context Protocol）サーバーです。

## 機能

| ツール | 概要 |
|--------|------|
| `list_templates` | ワークスペース内のデザイン一覧を取得 |
| `get_design_parameters` | デザインに必要なパラメータ構造を取得 |
| `generate_pdf_sync` | PDF を同期生成してローカルパスを返す |
| `generate_pdf_async` | PDF を非同期生成して requestId を返す |
| `generate_pdfs_sync` | 複数 PDF を一括同期生成（ZIP）してローカルパスを返す |
| `generate_pdfs_async` | 複数 PDF を一括非同期生成して requestId を返す |
| `download_file` | 非同期生成した単一 PDF をダウンロード |
| `download_zip` | 非同期生成した ZIP をダウンロード |

---

## セットアップ

### 1. インストール・ビルド

```bash
npm install
npm run build
```

### 2. 環境変数

`.env.sample` をコピーして `.env` を作成してください。

```env
# ReportFlow Content Service
REPORTFLOW_API_BASE_URL=http://localhost:3002
REPORTFLOW_APP_KEY=your-app-key
REPORTFLOW_SECRET_KEY=your-secret-key
```

### 3. Claude Desktop 設定

`~/Library/Application Support/Claude/claude_desktop_config.json` に以下を追加します。

```json
{
  "mcpServers": {
    "reportflow": {
      "command": "node",
      "args": ["/path/to/report-mcp/dist/index.js"],
      "env": {
        "REPORTFLOW_API_BASE_URL": "http://localhost:3002",
        "REPORTFLOW_APP_KEY": "your-app-key",
        "REPORTFLOW_SECRET_KEY": "your-secret-key",
        "PATH": "/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

---

## 帳票生成の基本フロー

### 1. テンプレート選択 → パラメータ確認 → PDF 生成（同期）

```
1. list_templates          → designId 一覧を確認
2. get_design_parameters   → designId でパラメータ構造を確認
3. generate_pdf_sync       → パラメータを埋めて PDF を即時生成
```

**Claude への指示例:**
```
請求書テンプレートの一覧を見せて、その中から「請求書」を選んで
以下の内容で PDF を作成してください：
- 宛名: 株式会社サンプル
- 金額: 50,000円
- 発行日: 2026-03-13
```

### 2. 非同期生成（大量ファイル向け）

```
1. list_templates          → designId 一覧を確認
2. get_design_parameters   → パラメータ構造を確認
3. generate_pdfs_async     → 複数件を非同期生成
4. download_zip            → requestId で ZIP をダウンロード
```

---

## CLAUDE.md への追加スニペット

ReportFlow MCP サーバーを使うプロジェクトの `CLAUDE.md` に以下を追記することで、Claude が帳票生成ツールを正しく活用できるようになります。

````markdown
## ReportFlow MCP 帳票生成

### 利用可能ツール

| ツール | 用途 |
|--------|------|
| `list_templates` | デザイン一覧取得（designId の確認に使う） |
| `get_design_parameters` | 指定デザインの必要パラメータ構造を取得 |
| `generate_pdf_sync` | 単一 PDF を即時生成 → ローカルパスを返す |
| `generate_pdf_async` | 単一 PDF を非同期生成 → requestId + fileId を返す |
| `generate_pdfs_sync` | 複数 PDF を一括即時生成 → ZIP パスを返す |
| `generate_pdfs_async` | 複数 PDF を一括非同期生成 → requestId を返す |
| `download_file` | requestId + fileId でファイルをダウンロード |
| `download_zip` | requestId で ZIP をダウンロード |

### 帳票生成の流れ

1. `list_templates` でデザイン一覧を取得し、目的の `id`（designId）を確認
2. `get_design_parameters` で `designId` と `version`（latestVersion）を指定してパラメータ構造を確認
3. パラメータを埋めて `generate_pdf_sync` で PDF を生成

### 注意事項

- `params` の型は `get_design_parameters` の結果に従うこと
  - `"string"` → 文字列、`"number"` → 数値、`"date"` → "YYYY-MM-DD" 形式
  - 配列型（`[{...}]`）はオブジェクトの配列を渡す
- `version` は `list_templates` で返る `latestVersion` を使用
- 同期生成（sync）は即座にファイルパスが返る。件数が多い場合は async を使うこと
````

---

## 開発

```bash
npm test      # ユニットテスト実行
npm run build # TypeScript ビルド
npm run lint  # ESLint チェック
```
