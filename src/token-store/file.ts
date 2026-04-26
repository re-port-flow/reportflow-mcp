import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TokenSet, TokenStore } from './types.js';

const SUBDIR = 'reportflow-mcp';

export const resolveStoreDir = (): string => {
  const override = process.env['REPORTFLOW_TOKEN_STORE_PATH'];
  if (override && override.trim().length > 0) {
    return override;
  }
  const xdgState =
    process.env['XDG_STATE_HOME'] ?? path.join(os.homedir(), '.local', 'state');
  return path.join(xdgState, SUBDIR);
};

const fileFor = (account: string): string =>
  path.join(resolveStoreDir(), `${account}.json`);

export const createFileStore = (): TokenStore => ({
  kind: 'file',
  async load(account) {
    try {
      const raw = await fs.readFile(fileFor(account), 'utf8');
      return JSON.parse(raw) as TokenSet;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  },
  async save(account, tokens) {
    const dir = resolveStoreDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = fileFor(account);
    await fs.writeFile(target, JSON.stringify(tokens), { mode: 0o600 });
    await fs.chmod(target, 0o600);
  },
  async clear(account) {
    try {
      await fs.unlink(fileFor(account));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  },
});
