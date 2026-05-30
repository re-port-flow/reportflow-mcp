import * as os from 'os';
import * as path from 'path';
import { resolveDefaultOutputDir, resolveAllowedRoots } from './index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const makeFakeServer = (
  listRoots: jest.Mock<Promise<{ roots: Array<{ uri: string; name?: string }> }>, []>,
): McpServer =>
  ({ server: { listRoots } }) as unknown as McpServer;

const FALLBACK = path.join(os.tmpdir(), 'reportflow');

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
    expect(dir).toEqual(FALLBACK);
  });

  it('falls back when no file:// root present', async () => {
    const listRoots = jest.fn().mockResolvedValueOnce({
      roots: [{ uri: 'http://example.test/' }],
    });
    const dir = await resolveDefaultOutputDir(makeFakeServer(listRoots));
    expect(dir).toEqual(FALLBACK);
  });

  it('falls back when roots array is empty', async () => {
    const listRoots = jest.fn().mockResolvedValueOnce({ roots: [] });
    const dir = await resolveDefaultOutputDir(makeFakeServer(listRoots));
    expect(dir).toEqual(FALLBACK);
  });
});

describe('resolveAllowedRoots', () => {
  it('returns all file:// root paths when client supports roots', async () => {
    const listRoots = jest.fn().mockResolvedValueOnce({
      roots: [
        { uri: 'file:///home/user/project', name: 'project' },
        { uri: 'file:///home/user/Downloads', name: 'downloads' },
      ],
    });
    const roots = await resolveAllowedRoots(makeFakeServer(listRoots));
    expect(roots).toEqual([
      path.resolve('/home/user/project'),
      path.resolve('/home/user/Downloads'),
    ]);
  });

  it('filters out non-file:// roots', async () => {
    const listRoots = jest.fn().mockResolvedValueOnce({
      roots: [
        { uri: 'http://example.test/' },
        { uri: 'file:///home/user/project' },
      ],
    });
    const roots = await resolveAllowedRoots(makeFakeServer(listRoots));
    expect(roots).toEqual([path.resolve('/home/user/project')]);
  });

  it('falls back to [tmpdir/reportflow] when listRoots throws', async () => {
    const listRoots = jest
      .fn()
      .mockRejectedValueOnce(new Error('Method not found'));
    const roots = await resolveAllowedRoots(makeFakeServer(listRoots));
    expect(roots).toEqual([FALLBACK]);
  });

  it('falls back to [tmpdir/reportflow] when roots array is empty', async () => {
    const listRoots = jest.fn().mockResolvedValueOnce({ roots: [] });
    const roots = await resolveAllowedRoots(makeFakeServer(listRoots));
    expect(roots).toEqual([FALLBACK]);
  });

  it('falls back to [tmpdir/reportflow] when only non-file:// roots present', async () => {
    const listRoots = jest.fn().mockResolvedValueOnce({
      roots: [{ uri: 'http://example.test/' }],
    });
    const roots = await resolveAllowedRoots(makeFakeServer(listRoots));
    expect(roots).toEqual([FALLBACK]);
  });

  it('always returns non-empty array (contract: caller never needs empty-check)', async () => {
    const listRoots = jest.fn().mockResolvedValueOnce({ roots: [] });
    const roots = await resolveAllowedRoots(makeFakeServer(listRoots));
    expect(roots.length).toBeGreaterThan(0);
  });
});
