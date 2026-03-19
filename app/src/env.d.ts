declare global {
  namespace NodeJS {
    interface ProcessEnv {
      LOGGER_LEVEL: string;
      APP_VERSION: string;
      APP_SERVICE: string;
      APP_URL: string;
      JWT_SECRET: string;
      HASH_SALT: string;
      INFO_TEMPLATE_PATH: string;
      DB_HOST: string;
      DB_PORT: string;
      DB_USER: string;
      DB_PASSWORD: string;
      DB_SCHEMA: string;
      MONGO_URL: string;
      MONGO_PORT: string;
      MONGO_USER: string;
      MONGO_PASS: string;
      MONGO_SCHEMA: string;
      MAIL_FROM: string;
      MAIL_BCC: string;
      MAIL_TEMPLATE_PATH: string;
      MAIL_HOST: string;
      MAIL_PORT: string;
      MAIL_USER: string;
      MAIL_PASS: string;
      AUTH_SERVICE_URL: string;
      PROJECT_SERVICE_URL: string;
      TEMPLATE_SERVICE_URL: string;
      LOG_SERVICE_URL: string;
      NOTIFICATION_SERVICE_URL: string;
      CONTENT_API_URL: string;
      BASIC_USER: string;
      BASIC_PASS: string;
      CONTENT_JWT: string;
      IS_NEXSTA: string;
      AUTH_USER_POOL_ID: string;
      AWS_IAM_NAME: string;
      AUTH_USER_POOL_WEB_CLIENT_ID: string;
      AWS_S3_BUCKET: string;
      AUTH_IDENTITY_POOL_ID: string;
      AWS_REGION: string;
      AWS_ACCESS_KEY_ID: string;
      AWS_SECRET_KEY: string;
      REDIS_HOST: string;
      REDIS_HOST_CLUSTER: string;
      REDIS_AUTH_TOKEN: string;
      REDIS_NON_TLS: string;
      SEND_GRID: string;
    }
  }
}

export {};
