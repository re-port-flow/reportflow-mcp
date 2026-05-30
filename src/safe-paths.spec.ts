import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveSafeOutputDir, _testExports } from './safe-paths.js';

const { isDescendantOrEqual } = _testExports;

// fs.promises をモック
jest.mock('fs', () => ({
  promises: {
    realpath: jest.fn(),
  },
}));

const mockRealpath = fs.promises.realpath as jest.MockedFunction<
  typeof fs.promises.realpath
>;

/**
 * realpath モックのヘルパー。
 * - existingPaths に含まれるパスは realpath がそのまま返す（存在する）
 * - それ以外は ENOENT を throw する（存在しない）
 */
const setupRealpath = (existingPaths: Record<string, string>) => {
  mockRealpath.mockImplementation((p: fs.PathLike) => {
    const s = p.toString();
    if (s in existingPaths) {
      return Promise.resolve(existingPaths[s]);
    }
    const err = Object.assign(
      new Error(`ENOENT: no such file or directory, stat '${s}'`),
      {
        code: 'ENOENT',
      },
    );
    return Promise.reject(err);
  });
};

describe('resolveSafeOutputDir', () => {
  const SAFE_ROOT = '/home/user/workspace';
  const CWD = process.cwd();
  const FALLBACK = path.join(os.tmpdir(), 'reportflow');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── outputDir undefined → デフォルトルートを返す ────────────────────────

  it('returns first allowedRoot when outputDir is undefined', async () => {
    setupRealpath({ [SAFE_ROOT]: SAFE_ROOT });

    const result = await resolveSafeOutputDir(undefined, [SAFE_ROOT]);

    expect(result).toBe(SAFE_ROOT);
  });

  it('returns DEFAULT_FALLBACK_DIR realpath when outputDir is undefined and allowedRoots is empty', async () => {
    // 既定 fallback は os.tmpdir()/reportflow (roots/index.ts:resolveDefaultOutputDir と semantic 統一)
    setupRealpath({ [FALLBACK]: FALLBACK });

    const result = await resolveSafeOutputDir(undefined, []);

    expect(result).toBe(FALLBACK);
  });

  it('treats empty string outputDir as undefined', async () => {
    setupRealpath({ [SAFE_ROOT]: SAFE_ROOT });

    const result = await resolveSafeOutputDir('', [SAFE_ROOT]);

    expect(result).toBe(SAFE_ROOT);
  });

  // ─── outputDir がルート内 → 解決済みパスを返す ────────────────────────────

  it('returns resolved path when outputDir is within allowed root', async () => {
    const target = `${SAFE_ROOT}/reports/2024`;
    setupRealpath({ [SAFE_ROOT]: SAFE_ROOT, [target]: target });

    const result = await resolveSafeOutputDir(target, [SAFE_ROOT]);

    expect(result).toBe(target);
  });

  it('accepts outputDir equal to the root itself', async () => {
    setupRealpath({ [SAFE_ROOT]: SAFE_ROOT });

    const result = await resolveSafeOutputDir(SAFE_ROOT, [SAFE_ROOT]);

    expect(result).toBe(SAFE_ROOT);
  });

  it('resolves relative ./foo path within root', async () => {
    // process.cwd() = CWD, ./reports → CWD/reports
    const target = path.join(CWD, 'reports');
    setupRealpath({ [CWD]: CWD, [target]: target });

    const result = await resolveSafeOutputDir('./reports', [CWD]);

    expect(result).toBe(target);
  });

  it('accepts not-yet-existing directory inside root (mkdir will create it later)', async () => {
    const target = `${SAFE_ROOT}/new-subdir/output`;
    // target と new-subdir は存在しないが、SAFE_ROOT は存在する
    setupRealpath({ [SAFE_ROOT]: SAFE_ROOT });

    const result = await resolveSafeOutputDir(target, [SAFE_ROOT]);

    // 実在する祖先 (SAFE_ROOT) を realpath して残りを join した結果
    expect(result).toBe(target);
  });

  // ─── outputDir がルート外 → エラー ───────────────────────────────────────

  it('rejects absolute path outside allowed root (/etc/passwd)', async () => {
    setupRealpath({ [SAFE_ROOT]: SAFE_ROOT, '/etc/passwd': '/etc/passwd' });

    await expect(
      resolveSafeOutputDir('/etc/passwd', [SAFE_ROOT]),
    ).rejects.toThrow('outside the allowed roots');
  });

  it('rejects parent-traversal path (../../etc)', async () => {
    // path.resolve('../../etc') は CWD から上がったパスになる
    const traversed = path.resolve('../../etc');
    setupRealpath({ [SAFE_ROOT]: SAFE_ROOT, [traversed]: traversed });

    await expect(
      resolveSafeOutputDir('../../etc', [SAFE_ROOT]),
    ).rejects.toThrow('outside the allowed roots');
  });

  it('rejects ~/.ssh path', async () => {
    const sshDir = path.join(os.homedir(), '.ssh');
    setupRealpath({ [SAFE_ROOT]: SAFE_ROOT, [sshDir]: sshDir });

    await expect(resolveSafeOutputDir('~/.ssh', [SAFE_ROOT])).rejects.toThrow(
      'outside the allowed roots',
    );
  });

  it('rejects not-yet-existing path with attacker-chosen prefix outside root', async () => {
    // /etc/evil-new-dir は存在しないが、祖先 /etc は SAFE_ROOT 外
    setupRealpath({ [SAFE_ROOT]: SAFE_ROOT, '/etc': '/etc' });

    await expect(
      resolveSafeOutputDir('/etc/evil-new-dir', [SAFE_ROOT]),
    ).rejects.toThrow('outside the allowed roots');
  });

  it('rejects symlink inside root that points outside root', async () => {
    // /home/user/workspace/escape は存在するが、realpath が /etc/secret を指す
    const symlinkPath = `${SAFE_ROOT}/escape`;
    setupRealpath({
      [SAFE_ROOT]: SAFE_ROOT,
      [symlinkPath]: '/etc/secret', // symlink → /etc/secret (root外)
    });

    await expect(
      resolveSafeOutputDir(symlinkPath, [SAFE_ROOT]),
    ).rejects.toThrow('outside the allowed roots');
  });

  it('accepts trailing slash in outputDir', async () => {
    const target = `${SAFE_ROOT}/reports`;
    // path.resolve でトレイリングスラッシュは除去される
    setupRealpath({ [SAFE_ROOT]: SAFE_ROOT, [target]: target });

    const result = await resolveSafeOutputDir(`${target}/`, [SAFE_ROOT]);

    expect(result).toBe(target);
  });
});

describe('isDescendantOrEqual', () => {
  it('returns true when target equals root', () => {
    expect(isDescendantOrEqual('/a/b', '/a/b')).toBe(true);
  });

  it('returns true when target is direct child of root', () => {
    expect(isDescendantOrEqual('/a/b/c', '/a/b')).toBe(true);
  });

  it('returns true when target is deep descendant', () => {
    expect(isDescendantOrEqual('/a/b/c/d/e', '/a/b')).toBe(true);
  });

  it('returns false when target is sibling (prefix-only match)', () => {
    // /a/bc は /a/b の descendant ではない（prefix だが sep を含まない）
    expect(isDescendantOrEqual('/a/bc', '/a/b')).toBe(false);
  });

  it('returns false when target is parent of root', () => {
    expect(isDescendantOrEqual('/a', '/a/b')).toBe(false);
  });

  it('returns false for completely different paths', () => {
    expect(isDescendantOrEqual('/etc/passwd', '/home/user')).toBe(false);
  });
});

// ─── case-insensitive FS (darwin/win32) での case-fold 比較 ─────────────────────
//
// Gemini code review (PRJ-3-485) で指摘された high-severity 回帰:
// realpath が返すパスの case が allowed root の case と異なる場合
// (macOS APFS 既定 / Windows NTFS) に、正規の outputDir が誤って拒否されていた。
describe('isDescendantOrEqual case sensitivity', () => {
  // process.platform を spec ごとに上書きするためのヘルパー。
  // Object.defineProperty を使う (Node の process.platform は readonly 扱い)。
  const originalPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };
  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('darwin: accepts case-different paths within root (root=/Users/Foo, target=/users/foo/work/output.pdf)', () => {
    setPlatform('darwin');
    expect(
      isDescendantOrEqual('/users/foo/work/output.pdf', '/Users/Foo/work'),
    ).toBe(true);
  });

  it('win32: accepts case-different drive letter (root=C:\\\\Users\\\\Foo, target=c:\\\\users\\\\foo\\\\out.pdf)', () => {
    setPlatform('win32');
    // Note: jest は POSIX path で動くが、isDescendantOrEqual は path.sep を見る。
    // win32 path.sep の挙動を直接検証するには別ファイル分離が必要なため、
    // ここでは「fold だけが効いている」ことを POSIX セパレータで確認する。
    expect(
      isDescendantOrEqual('/users/foo/work/out.pdf', '/Users/Foo/work'),
    ).toBe(true);
  });

  it('linux: rejects case-different paths (case-sensitive FS)', () => {
    setPlatform('linux');
    expect(
      isDescendantOrEqual('/users/foo/work/output.pdf', '/Users/Foo/work'),
    ).toBe(false);
  });

  it('darwin: still rejects sibling prefix even with case fold (/foo/Bar vs /foo/barbaz)', () => {
    // 回帰テスト: case-fold 後も `/foo/bar` と `/foo/barbaz` を取り違えないこと。
    // root + sep の境界判定が崩れていれば false-positive になる。
    setPlatform('darwin');
    expect(isDescendantOrEqual('/foo/BARBAZ/file.pdf', '/foo/bar')).toBe(false);
  });

  it('darwin: still rejects clearly outside root with case differences', () => {
    setPlatform('darwin');
    expect(
      isDescendantOrEqual('/Etc/Passwd', '/Users/Foo/work'),
    ).toBe(false);
  });

  it('linux: still accepts exact-case descendant (no regression)', () => {
    setPlatform('linux');
    expect(
      isDescendantOrEqual('/Users/Foo/work/output.pdf', '/Users/Foo/work'),
    ).toBe(true);
  });
});
