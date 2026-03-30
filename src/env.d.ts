declare global {
  namespace NodeJS {
    interface ProcessEnv {
      REPORTFLOW_API_BASE_URL?: string;
      REPORTFLOW_APP_KEY: string;
    }
  }
}

export {};
