jest.mock('@napi-rs/keyring', () => {
  const setPassword = jest.fn();
  const deletePassword = jest.fn();
  const Entry = jest.fn().mockImplementation(() => ({
    setPassword,
    deletePassword,
    getPassword: jest.fn().mockReturnValue(null),
  }));
  return {
    Entry,
    __setPassword: setPassword,
    __deletePassword: deletePassword,
  };
});

import { createTokenStore } from './index.js';

const mod = jest.requireMock('@napi-rs/keyring') as {
  __setPassword: jest.Mock;
  __deletePassword: jest.Mock;
};

describe('token-store/index factory', () => {
  const originalForce = process.env['REPORTFLOW_TOKEN_STORE'];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env['REPORTFLOW_TOKEN_STORE'];
  });

  afterAll(() => {
    process.env['REPORTFLOW_TOKEN_STORE'] = originalForce;
  });

  it('returns file store when REPORTFLOW_TOKEN_STORE=file', () => {
    process.env['REPORTFLOW_TOKEN_STORE'] = 'file';
    expect(createTokenStore().kind).toEqual('file');
  });

  it('returns keychain store when REPORTFLOW_TOKEN_STORE=keychain', () => {
    process.env['REPORTFLOW_TOKEN_STORE'] = 'keychain';
    expect(createTokenStore().kind).toEqual('keychain');
  });

  it('falls back to file when keychain probe throws', () => {
    mod.__setPassword.mockImplementationOnce(() => {
      throw new Error('keychain unavailable');
    });
    expect(createTokenStore().kind).toEqual('file');
  });

  it('selects keychain when probe succeeds', () => {
    mod.__setPassword.mockImplementation(() => undefined);
    mod.__deletePassword.mockImplementation(() => undefined);
    expect(createTokenStore().kind).toEqual('keychain');
  });
});
