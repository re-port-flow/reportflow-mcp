jest.mock('@napi-rs/keyring', () => {
  const setPassword = jest.fn();
  const getPassword = jest.fn();
  const deletePassword = jest.fn();
  const Entry = jest.fn().mockImplementation(() => ({
    setPassword,
    getPassword,
    deletePassword,
  }));
  return {
    Entry,
    __setPassword: setPassword,
    __getPassword: getPassword,
    __deletePassword: deletePassword,
  };
});

import { createKeychainStore, isKeychainAvailable } from './keychain.js';

const mod = jest.requireMock('@napi-rs/keyring') as {
  __setPassword: jest.Mock;
  __getPassword: jest.Mock;
  __deletePassword: jest.Mock;
};

describe('token-store/keychain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mod.__setPassword.mockImplementation(() => undefined);
    mod.__deletePassword.mockImplementation(() => undefined);
    mod.__getPassword.mockReturnValue(null);
  });

  describe('clear', () => {
    it('resolves when deletePassword succeeds', async () => {
      const store = createKeychainStore();
      await expect(store.clear('account-1')).resolves.toBeUndefined();
      expect(mod.__deletePassword).toHaveBeenCalledTimes(1);
    });

    it('is idempotent when deletePassword throws (entry not found)', async () => {
      mod.__deletePassword.mockImplementationOnce(() => {
        throw new Error('Entry not found');
      });
      const store = createKeychainStore();
      await expect(store.clear('account-x')).resolves.toBeUndefined();
    });

    it('is idempotent on multiple consecutive calls', async () => {
      const store = createKeychainStore();
      await store.clear('account-1');
      mod.__deletePassword.mockImplementationOnce(() => {
        throw new Error('Entry not found');
      });
      await expect(store.clear('account-1')).resolves.toBeUndefined();
    });
  });

  describe('isKeychainAvailable', () => {
    it('returns true when probe write+delete succeed', () => {
      expect(isKeychainAvailable()).toEqual(true);
    });

    it('returns false when setPassword throws', () => {
      mod.__setPassword.mockImplementationOnce(() => {
        throw new Error('keychain access denied');
      });
      expect(isKeychainAvailable()).toEqual(false);
    });
  });
});
