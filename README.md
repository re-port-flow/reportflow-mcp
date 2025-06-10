# 文書生成MCPサーバー 使用説明書

## 概要

このMCP（Model Context Protocol）サーバーは、Claude Desktopアプリケーションと連携して、テンプレートベースの文書生成機能を提供します。領収書、請求書、見積書、納品書などの各種ビジネス文書をPDF形式で作成することができます。

## 機能

- **文書テンプレート取得**: 文書タイプに応じたテンプレート構造の確認
- **PDF文書生成**: テンプレートを使用したカスタマイズされた文書の作成
- **リアルタイム進捗表示**: 文書作成プロセスの進捗をリアルタイムで確認
- **パラメータ検証**: 入力データの妥当性チェック

## セットアップ方法

### 1. 前提条件

- Node.js v22以上がインストールされていること
- Claude Desktopアプリケーションがインストールされていること
- 文書生成APIサーバーが稼働していること（デフォルト: http://localhost:3002）

### 2. プロジェクトのビルド

```bash
# プロジェクトディレクトリに移動
cd /Users/sudami/WebstormProjects/report-mcp

# 依存関係のインストール
npm install

# プロジェクトのビルド
npm run build
```

### 3. Claude Desktop設定

Claude Desktop の設定ファイル（`claude_desktop_config.json`）に以下の設定を追加してください：

```json
{
  "mcpServers": {
    "document-generation": {
      "command": "node",
      "args": [
        "/path/to/build"
      ],
      "env": {
        "API_BASE_URL": "http://localhost:3002",
        "APP_KEY": "xxx",
        "SECRET_KEY": "xxxxx",
        "PATH": "/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

### 4. 環境変数の設定

プロジェクトルートに`.env`ファイルを作成し、以下の環境変数を設定してください：

```env
API_BASE_URL=
APP_KEY=
SECRET_KEY=
```

## 利用可能なツール

### 1. `get_document_template`

文書タイプのテンプレート構造を取得して表示します。

**パラメータ:**
- `label` (string): 文書タイプ（例: "領収書", "請求書", "見積書", "納品書"）

**使用例:**
```
テンプレート情報を教えて。文書タイプは「領収書」です。
```

**出力内容:**
- デザインID
- バージョン
- ファイル名
- 必須フィールド一覧とその型

### 2. `create_document`

テンプレートを使用してPDF文書を作成します。

**パラメータ:**
- `designId` (string): デザインID（get_document_templateで取得）
- `version` (number): テンプレートのバージョン
- `fileName` (string, optional): ファイル名（省略時はテンプレートのデフォルトを使用）
- `label` (string, optional): 文書タイプ（fileNameを自動取得する場合に必要）
- `params` (object): 文書のパラメータ（テンプレートの必須フィールドに対応）

**重要な注意点:**
- `label`パラメータを提供すると、`fileName`は自動的にテンプレートから取得されます
- カスタムファイル名を使用したい場合のみ`fileName`パラメータを指定してください
- まず`get_document_template`でテンプレート情報を取得してから使用することを推奨します

## 使用例

### 例1: 領収書テンプレートの確認

**Claude への指示:**
```
領収書のテンプレート構造を教えてください。
```

**実行されるツール:**
- `get_document_template` with `label: "領収書"`

### 例2: 領収書の作成

**Claude への指示:**
```
以下の情報で領収書を作成してください：
- 会社名: 株式会社サンプル
- 金額: 50000
- 日付: 2024-01-15
- 項目: コンサルティング料
```

**実行の流れ:**
1. `get_document_template`で領収書テンプレートを取得
2. 必要なパラメータを確認
3. `create_document`で文書を作成

### 例3: カスタムファイル名での文書作成

**Claude への指示:**
```
請求書を作成してください。ファイル名は「invoice_2024_001.pdf」にしてください。
- 顧客名: 田中太郎
- 金額: 120000
- 請求日: 2024-01-20
```

