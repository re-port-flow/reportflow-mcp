# @reportflow/mcp-server

ReportFlow の PDF 帳票生成機能を Claude や AI エージェントから利用するための MCP（Model Context Protocol）サーバーです。

MCP の 5 つの機能ブロックをすべてサポートしています: **Tools / Prompts / Resources / Sampling / Roots**。

## 機能

### Tools（AI が必要に応じて呼び出す）

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
| `suggest_params` | **Sampling 使用**。自然文の要件からクライアント AI に params JSON を整形させる |

### Prompts（スラッシュコマンドとしてユーザーが呼ぶレシピカード）

| Prompt | 概要 |
|--------|------|
| `/generate_pdf` | 単一 PDF 生成のステップガイド。`designId` / `description` / `outputDir` を引数として受け取ります |
| `/generate_pdfs` | 複数 PDF 一括生成のステップガイド。`designId` / `source` / `outputDir` / `zipFileName` |
| `/reportflow_help` | 提供機能の概要ヘルプ |

### Resources（AI のコンテキストに負担をかけず貼り付けられる生データ）

| URI | 概要 |
|-----|------|
| `reportflow://designs` | デザイン一覧（`list_templates` 同等の JSON） |
| `reportflow://designs/{designId}/parameters` | 各デザインのパラメータスキーマ（動的テンプレート） |
| `reportflow://errors` | Content Service が返す主要エラーメッセージカタログ |
| `reportflow://server-info` | サーバー提供機能・対応ワークフローの概観 |

### Sampling

`suggest_params` ツールは `sampling/createMessage` を使い、**サーバー側 API キーを持たずにクライアント AI に作業を委譲**します。スキーマを入手した上で自然文の要件を params JSON に整形し、解釈不可なら一回だけ自己修正します。Sampling 未対応クライアント (stdio 単体を読んでいる補助ツール等) では当該ツールはエラーとなります。

### Roots

`generate_pdf_sync` / `generate_pdfs_sync` で `outputDir` 未指定時、クライアントが提示するワークスペース (Roots) の最初の `file://` を outputDir として使用します。VS Code ・ Claude Desktop から接続したときはそのワークスペース直下に出力されます。Roots 未対応クライアント・取得失敗時は OS 一時ディレクトリ (`<tmp>/reportflow`) にフォールバックします。

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

`~/Library/Application Support/Claude/claude_desktop_config.json` も同形式。Sampling と Roots に対応しているため、`suggest_params` ツールやワークスペース自動保存もそのまま動きます。

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
| `REPORTFLOW_AUTH_URL` | 任意 | `https://re-port-flow.com/api/v1` | ReportFlow OAuth2 サーバーのベース URL (staging/local で上書き) |
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

またはスラッシュコマンドで一括依頼:

```
/generate_pdf description="請求書、宛先株式会社サンプル、3万円"
```

または Sampling を使って params を AI に整形させる:

```
suggest_params ツールを呼び、返った params を generate_pdf_sync に渡して
```

### 2. 非同期生成（大量ファイル向け）

```
0. authenticate            → 初回のみ
1. list_templates          → designId 一覧を確認
2. get_design_parameters   → パラメータ構造を確認
3. generate_pdfs_async     → 複数件を非同期生成
4. download_zip            → requestId で ZIP をダウンロード
```

### 出力先の決定ルール

`generate_pdf_sync` / `generate_pdfs_sync` / `download_file` / `download_zip` の保存先は次の順で決まります。

1. `outputDir` が明示指定されている → そのディレクトリ
2. クライアントが Roots を提示 (VS Code / Claude Desktop のワークスペース等) → そのパス
3. いずれもない → OS 一時ディレクトリ (`<tmp>/reportflow`)

ユーザーが明示的に保存先を指示した場合のみ Claude が `outputDir` をセットします。

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
| `suggest_params` | 自然文要件 + スキーマから params JSON を Sampling で生成 |

### 帳票生成の流れ

1. (初回のみ) `authenticate` でブラウザログイン・ワークスペース選択
2. `list_templates` でデザイン一覧を取得し、目的の `id`（designId）を確認
3. `get_design_parameters` で `designId` と `version`（latestVersion）を指定してパラメータ構造を確認
4. パラメータを埋めて `generate_pdf_sync` で PDF を生成

または、`/generate_pdf` / `/generate_pdfs` スラッシュコマンドからレシピを受け取るとよりスムーズ。

### Resources の活用

- `reportflow://designs` や `reportflow://designs/{designId}/parameters` を Resource としてコンテキストに添付すれば、ツール呼び出しを加えずにテンプレを参照できます。
- エラー判別に迷ったときは `reportflow://errors` を見るとメッセージカタログがあります。

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
