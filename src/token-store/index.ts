import { createFileStore } from './file.js';
import { createKeychainStore, isKeychainAvailable } from './keychain.js';
import { TokenStore } from './types.js';

export type { TokenSet, TokenStore } from './types.js';
export { TOKEN_STORE_SERVICE } from './types.js';

export const createTokenStore = (): TokenStore => {
  const forced = process.env['REPORTFLOW_TOKEN_STORE'];
  if (forced === 'file') return createFileStore();
  if (forced === 'keychain') return createKeychainStore();
  if (isKeychainAvailable()) return createKeychainStore();
  return createFileStore();
};
