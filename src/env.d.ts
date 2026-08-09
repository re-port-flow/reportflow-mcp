declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /** [任意] Content Service ベース URL (デフォルト: https://api.re-port-flow.com、開発/staging で上書き) */
      REPORTFLOW_API_BASE_URL?: string;
      /** [任意] reposts-api ベース URL (デフォルト: https://re-port-flow.com/api/v1、開発/staging で上書き) */
      REPORTFLOW_AUTH_URL?: string;
      /** [任意] OAuth2 client_id を上書き (デフォルト: 公式 'reportflow-mcp') */
      REPORTFLOW_CLIENT_ID?: string;
      /**
       * [任意] テンプレート複製 API へ送る app-key ヘッダーを上書き
       * (デフォルト: 'reportflow-mcp')。reposts-api の VerifyVersion ガードが
       * 必須とするヘッダーで、ガードは値を検証しない。CDN / WAF が特定の値を
       * 要求する場合のみ設定する (PRJ-3-1245)
       */
      REPORTFLOW_APP_KEY?: string;
      /** ローカルコールバックサーバーのポート番号 (デフォルト 53682) */
      REPORTFLOW_CALLBACK_PORT?: string;
      /** 要求するスコープ (空白区切り。未指定時はデフォルト全権限) */
      REPORTFLOW_SCOPE?: string;
      /** トークン保存方式: 'keychain' | 'file' (未指定時は keychain → file 自動 fallback) */
      REPORTFLOW_TOKEN_STORE?: string;
      /** file モード時のトークン保存ディレクトリ (未指定時は $XDG_STATE_HOME/reportflow-mcp) */
      REPORTFLOW_TOKEN_STORE_PATH?: string;
      /** XDG Base Directory: state ディレクトリ */
      XDG_STATE_HOME?: string;
      /** [任意] HTTP 版 MCP の Open API 連携トークン */
      OPENAI_APPS_CHALLENGE_TOKEN?: string;
    }
  }
}

export {};
