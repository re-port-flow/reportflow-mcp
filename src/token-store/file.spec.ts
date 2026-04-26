import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createFileStore, resolveStoreDir } from './file.js';
import { TokenSet } from './types.js';

const SAMPLE_TOKENS: TokenSet = {
  accessToken: '<JWT_REDACTED>',
  refreshToken: '<HEX_REDACTED>',
  expiresAt: 1893456000000,
  scope: 'openid profile designs:read',
  workspaceId: '00000000-0000-0000-0000-000000000000',
};

const ACCOUNT = 'test-client';

describe('token-store/file', () => {
  let tmpDir: string;
  const originalOverride = process.env['REPORTFLOW_TOKEN_STORE_PATH'];
  const originalXdg = process.env['XDG_STATE_HOME'];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-mcp-token-'));
    process.env['REPORTFLOW_TOKEN_STORE_PATH'] = tmpDir;
  });

  afterEach(async () => {
    process.env['REPORTFLOW_TOKEN_STORE_PATH'] = originalOverride;
    process.env['XDG_STATE_HOME'] = originalXdg;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('resolveStoreDir', () => {
    it('honors REPORTFLOW_TOKEN_STORE_PATH override', () => {
      process.env['REPORTFLOW_TOKEN_STORE_PATH'] = '/custom/path';
      expect(resolveStoreDir()).toEqual('/custom/path');
    });

    it('falls back to XDG_STATE_HOME when override unset', () => {
      delete process.env['REPORTFLOW_TOKEN_STORE_PATH'];
      process.env['XDG_STATE_HOME'] = '/xdg/state';
      expect(resolveStoreDir()).toEqual(
        path.join('/xdg/state', 'reportflow-mcp'),
      );
    });

    it('falls back to ~/.local/state when XDG and override unset', () => {
      delete process.env['REPORTFLOW_TOKEN_STORE_PATH'];
      delete process.env['XDG_STATE_HOME'];
      const expected = path.join(
        os.homedir(),
        '.local',
        'state',
        'reportflow-mcp',
      );
      expect(resolveStoreDir()).toEqual(expected);
    });
  });

  describe('createFileStore', () => {
    it('returns null when no token saved', async () => {
      const store = createFileStore();
      const loaded = await store.load(ACCOUNT);
      expect(loaded).toBeNull();
    });

    it('roundtrips a TokenSet', async () => {
      const store = createFileStore();
      await store.save(ACCOUNT, SAMPLE_TOKENS);
      const loaded = await store.load(ACCOUNT);
      expect(loaded).toEqual(SAMPLE_TOKENS);
    });

    it('writes file with mode 0600', async () => {
      const store = createFileStore();
      await store.save(ACCOUNT, SAMPLE_TOKENS);
      const target = path.join(tmpDir, `${ACCOUNT}.json`);
      const stat = await fs.stat(target);
      expect(stat.mode & 0o777).toEqual(0o600);
    });

    it('clears saved token', async () => {
      const store = createFileStore();
      await store.save(ACCOUNT, SAMPLE_TOKENS);
      await store.clear(ACCOUNT);
      const loaded = await store.load(ACCOUNT);
      expect(loaded).toBeNull();
    });

    it('clear is idempotent when file is absent', async () => {
      const store = createFileStore();
      await expect(store.clear(ACCOUNT)).resolves.toBeUndefined();
    });

    it('exposes kind=file', () => {
      expect(createFileStore().kind).toEqual('file');
    });
  });
});
