declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /** Content Service ベース URL (PDF 生成・ダウンロード等) */
      REPORTFLOW_API_BASE_URL?: string;
      /** reposts-api ベース URL (OAuth2 endpoint。例: https://re-port-flow.com/api/v1) */
      REPORTFLOW_AUTH_URL?: string;
      /** OAuth2 Confidential client の client_id */
      REPORTFLOW_CLIENT_ID?: string;
      /** OAuth2 Confidential client の client_secret */
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
