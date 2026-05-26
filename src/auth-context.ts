import { AsyncLocalStorage } from 'async_hooks';

/**
 * HTTP モード専用: per-request の Bearer access token を tools 層へ伝搬する。
 * stdio モードでは利用しない (OS keychain 経路をそのまま使う)。
 */
export type HttpAuthContext = {
  accessToken: string;
};

const storage = new AsyncLocalStorage<HttpAuthContext>();

export const runWithHttpAuth = <T>(
  ctx: HttpAuthContext,
  fn: () => Promise<T>,
): Promise<T> => storage.run(ctx, fn);

export const getHttpAuthContext = (): HttpAuthContext | undefined =>
  storage.getStore();
