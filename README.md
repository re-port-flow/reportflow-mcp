# @reportflow/mcp-server

ReportFlow の PDF 帳票生成機能を Claude や AI エージェントから利用するための MCP（Model Context Protocol）サーバーです。

## 機能

| ツール | 概要 |
|--------|------|
| `authenticate` | **初回認証 / 再認証**。ブラウザで OAuth2 + ワークスペース選択を行い、トークンを keychain (または XDG file) に保存 |
| `list_templates` | ワークスペース内のデザイン一覧を取得 |
| `get_design_parameters` | デザインに必要なパラメータ構造を取得 |
| `generate_pdf_sync` | PDF を同期生成してローカルパスを返す |
| `generate_pdf_async` | PDF を非同期生成して requestId を返す |
| `generate_pdfs_sync` | 複数 PDF を一括同期生成（ZIP）してローカルパスを返す |
| `generate_pdfs_async` | 複数 PDF を一括非同期生成して requestId を返す |
| `download_file` | 非同期生成した単一 PDF をダウンロード |
| `download_zip` | 非同期生成した ZIP をダウンロード |

---

## 認証方式

OAuth2 **authorization_code + PKCE (S256)** Public client。シークレット (`client_secret`) は使用しません。

- 公式 OAuth client (`reportflow-mcp`) は ReportFlow 側で配布済み — **ユーザー側で発行作業は不要**
- MCP は `authenticate` ツール起動でブラウザを開き、ログイン → ワークスペース選択 → consent → JWT 取得 → ローカル保存
- consent 画面で毎回ワークスペースを選択 → 同じインストールで複数ワークスペース横断で利用可能
- 取得 JWT は OS の **Keychain** (macOS Keychain / Windows Credential Manager / Linux libsecret) に優先保存。失敗時は XDG file (chmod 0600) にフォールバック
- access_token 失効時は refresh_token で自動更新

---

## セットアップ

### 1. Claude Code (`.mcp.json`)

プロジェクトの `.mcp.json` に以下を追加するだけ:

```json
{
  "mcpServers": {
    "reportflow": {
      "command": "npx",
      "args": ["-y", "@reportflow/mcp-server"]
    }
  }
}
```

env はすべて任意。staging/local で別 URL を使う場合のみ `REPORTFLOW_AUTH_URL` / `REPORTFLOW_API_BASE_URL` を上書き設定してください。

### 2. Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` も同形式。

### 3. 初回認証

Claude Code をリロード後、Claude に依頼:

```
ReportFlow で認証して
```

Claude が `authenticate` ツールを呼び、ブラウザが起動します。ログイン → ワークスペース選択 → 同意 で完了 (`gh auth login` と同等)。
以後はトークンが期限切れになるまで他のツール (list_templates 等) を使えます。期限切れは自動 refresh、refresh も失敗したら `authenticate` を再実行してください。

---

## 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `REPORTFLOW_CLIENT_ID` | 任意 | `reportflow-mcp` | 公式 client_id を上書きする場合のみ |
| `REPORTFLOW_API_BASE_URL` | 任意 | `https://api.re-port-flow.com` | Content Service の URL (staging/local で上書き) |
| `REPORTFLOW_AUTH_URL` | 任意 | `https://re-port-flow.com/api/v1` | reposts-api OAuth2 ベース URL (staging/local で上書き) |
| `REPORTFLOW_CALLBACK_PORT` | 任意 | `53682` | ローカルコールバックサーバーのポート (redirect_uri と一致必須) |
| `REPORTFLOW_SCOPE` | 任意 | `openid profile designs:read designs:write templates:read templates:write pdf:generate` | 要求スコープ (空白区切り) |
| `REPORTFLOW_TOKEN_STORE` | 任意 | 自動 (keychain → file) | `keychain` / `file` 強制指定 |
| `REPORTFLOW_TOKEN_STORE_PATH` | 任意 | `$XDG_STATE_HOME/reportflow-mcp` | file モード時の保存ディレクトリ |

---

## 帳票生成の基本フロー

### 1. テンプレート選択 → パラメータ確認 → PDF 生成（同期）

```
0. authenticate            → 初回のみ。ブラウザでログイン・workspace 選択
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
- 保存先: ./output  ← 任意。指定しなければ現在の作業ディレクトリに保存
```

### 出力先の指定

`generate_pdf_sync` / `generate_pdfs_sync` / `download_file` / `download_zip` は、
`outputDir` パラメータでファイル保存先を指定できます。

- `outputDir` 指定あり: そのディレクトリに保存 (相対パスは現在の作業ディレクトリ基準で解決、ディレクトリは自動作成)
- `outputDir` 未指定 : 現在の作業ディレクトリ (`process.cwd()`) に保存

ユーザーが明示的に保存先を指示した場合のみ Claude が `outputDir` をセットします。

### 2. 非同期生成（大量ファイル向け）

```
0. authenticate            → 初回のみ
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
| `authenticate` | 初回認証 / 再認証 (他のツールが認証エラーを出したら最初に呼ぶ) |
| `list_templates` | デザイン一覧取得（designId の確認に使う） |
| `get_design_parameters` | 指定デザインの必要パラメータ構造を取得 |
| `generate_pdf_sync` | 単一 PDF を即時生成 → ローカルパスを返す |
| `generate_pdf_async` | 単一 PDF を非同期生成 → requestId + fileId を返す |
| `generate_pdfs_sync` | 複数 PDF を一括即時生成 → ZIP パスを返す |
| `generate_pdfs_async` | 複数 PDF を一括非同期生成 → requestId を返す |
| `download_file` | requestId + fileId でファイルをダウンロード |
| `download_zip` | requestId で ZIP をダウンロード |

### 帳票生成の流れ

1. (初回のみ) `authenticate` でブラウザログイン・ワークスペース選択
2. `list_templates` でデザイン一覧を取得し、目的の `id`（designId）を確認
3. `get_design_parameters` で `designId` と `version`（latestVersion）を指定してパラメータ構造を確認
4. パラメータを埋めて `generate_pdf_sync` で PDF を生成

### 注意事項

- 認証エラー (`再認証が必要です` を含むメッセージ) が出たら、まず `authenticate` を呼ぶこと
- `params` の型は `get_design_parameters` の結果に従うこと
  - `"string"` → 文字列、`"number"` → 数値、`"date"` → "YYYY-MM-DD" 形式
  - 配列型（`[{...}]`）はオブジェクトの配列を渡す
- `version` は `list_templates` で返る `latestVersion` を使用
- 同期生成（sync）は即座にファイルパスが返る。件数が多い場合は async を使うこと
````

---

## 開発

```bash
yarn install
yarn test       # ユニットテスト実行
yarn build      # TypeScript ビルド
yarn lint       # ESLint チェック
```

### 認証フロー (内部実装)

1. `authenticate` ツール起動 → PKCE `code_verifier` / `code_challenge` を生成
2. ローカルコールバックサーバーを `localhost:CALLBACK_PORT` で起動
3. ブラウザで `<AUTH_URL>/oauth/authorize?response_type=code&client_id=...&redirect_uri=...&code_challenge=...&code_challenge_method=S256&state=...` を開く
4. ユーザーがログイン → ワークスペース選択 → 同意 → callback に code 飛ぶ
5. `<AUTH_URL>/oauth/token` (POST, `grant_type=authorization_code`) で code + code_verifier を送り JWT 取得 (Public client: client_secret なし)
6. JWT を keychain (or XDG file) に保存。`account = client_id`、`service = reportflow-mcp`
7. 以後の API 呼び出しは `Authorization: Bearer <jwt>` ヘッダ
8. `expires_in` 経過時は refresh_token で自動更新
