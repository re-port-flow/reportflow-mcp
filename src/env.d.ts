declare global {
  namespace NodeJS {
    interface ProcessEnv {
      REPORTFLOW_API_BASE_URL?: string;
      /** 認証モード: 'appkey'（デフォルト）または 'oauth2' */
      REPORTFLOW_AUTH_MODE?: string;
      /** appkey モード: Content Service の appKey */
      REPORTFLOW_APP_KEY?: string;
      /** oauth2 モード: reposts-api のベース URL */
      REPORTFLOW_AUTH_URL?: string;
      /** oauth2 モード: OAuth2 client_id */
      REPORTFLOW_CLIENT_ID?: string;
      /** oauth2 モード: OAuth2 client_secret */
      REPORTFLOW_CLIENT_SECRET?: string;
    }
  }
}

export {};
