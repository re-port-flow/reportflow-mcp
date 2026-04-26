import { Entry } from '@napi-rs/keyring';
import { TOKEN_STORE_SERVICE, TokenSet, TokenStore } from './types.js';

const entryFor = (account: string): Entry =>
  new Entry(TOKEN_STORE_SERVICE, account);

export const createKeychainStore = (): TokenStore => ({
  kind: 'keychain',
  load(account) {
    const raw = entryFor(account).getPassword();
    if (raw == null) return Promise.resolve(null);
    return Promise.resolve(JSON.parse(raw) as TokenSet);
  },
  save(account, tokens) {
    entryFor(account).setPassword(JSON.stringify(tokens));
    return Promise.resolve();
  },
  clear(account) {
    try {
      entryFor(account).deletePassword();
    } catch {
      // エントリが存在しない場合などは無視 (clear は冪等)
    }
    return Promise.resolve();
  },
});

export const isKeychainAvailable = (): boolean => {
  try {
    const probeAccount = `__probe__${Date.now()}`;
    const entry = entryFor(probeAccount);
    entry.setPassword('probe');
    entry.deletePassword();
    return true;
  } catch {
    return false;
  }
};
