import * as os from 'os';
import * as path from 'path';
import { resolveDefaultOutputDir } from './index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const makeFakeServer = (
  listRoots: jest.Mock<Promise<{ roots: Array<{ uri: string; name?: string }> }>, []>,
): McpServer =>
  ({ server: { listRoots } }) as unknown as McpServer;

describe('resolveDefaultOutputDir', () => {
  it('returns first file:// root path when client supports roots', async () => {
    const listRoots = jest.fn().mockResolvedValueOnce({
      roots: [{ uri: 'file:///home/user/project', name: 'project' }],
    });
    const dir = await resolveDefaultOutputDir(makeFakeServer(listRoots));
    expect(dir).toEqual(path.resolve('/home/user/project'));
  });

  it('falls back to tmpdir/reportflow when listRoots throws', async () => {
    const listRoots = jest
      .fn()
      .mockRejectedValueOnce(new Error('Method not found'));
    const dir = await resolveDefaultOutputDir(makeFakeServer(listRoots));
    expect(dir).toEqual(path.join(os.tmpdir(), 'reportflow'));
  });

  it('falls back when no file:// root present', async () => {
    const listRoots = jest.fn().mockResolvedValueOnce({
      roots: [{ uri: 'http://example.test/' }],
    });
    const dir = await resolveDefaultOutputDir(makeFakeServer(listRoots));
    expect(dir).toEqual(path.join(os.tmpdir(), 'reportflow'));
  });

  it('falls back when roots array is empty', async () => {
    const listRoots = jest.fn().mockResolvedValueOnce({ roots: [] });
    const dir = await resolveDefaultOutputDir(makeFakeServer(listRoots));
    expect(dir).toEqual(path.join(os.tmpdir(), 'reportflow'));
  });
});
