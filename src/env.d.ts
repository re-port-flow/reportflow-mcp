declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /** [任意] Content Service ベース URL (デフォルト: https://api.re-port-flow.com、開発/staging で上書き) */
      REPORTFLOW_API_BASE_URL?: string;
      /** [任意] reposts-api ベース URL (デフォルト: https://re-port-flow.com/api/v1、開発/staging で上書き) */
      REPORTFLOW_AUTH_URL?: string;
      /** [必須] OAuth2 Confidential client の client_id (ReportFlow Web で発行) */
      REPORTFLOW_CLIENT_ID?: string;
      /** [必須] OAuth2 Confidential client の client_secret (ReportFlow Web で発行) */
      REPORTFLOW_CLIENT_SECRET?: string;
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
    }
  }
}

export {};
