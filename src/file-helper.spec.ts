import * as fs from 'fs';
import * as path from 'path';
import * as safePaths from './safe-paths.js';
import { saveTempFile } from './file-helper.js';

// fs モジュールをモック
jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    realpath: jest.fn(),
  },
}));

// safe-paths モジュールをモック（resolveSafeOutputDir の振る舞いをテストごとに制御）
jest.mock('./safe-paths.js', () => ({
  resolveSafeOutputDir: jest.fn(),
}));

const mockFs = fs.promises as jest.Mocked<typeof fs.promises>;
const mockResolveSafeOutputDir =
  safePaths.resolveSafeOutputDir as jest.MockedFunction<
    typeof safePaths.resolveSafeOutputDir
  >;

describe('saveTempFile', () => {
  const data = new ArrayBuffer(4);
  const fileName = 'output.pdf';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses resolveSafeOutputDir result as target directory', async () => {
    mockResolveSafeOutputDir.mockResolvedValueOnce('/safe/dir');

    const result = await saveTempFile(data, fileName, '/safe/dir');

    expect(mockResolveSafeOutputDir).toHaveBeenCalledWith('/safe/dir', []);
    expect(mockFs.mkdir).toHaveBeenCalledWith('/safe/dir', { recursive: true });
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      path.join('/safe/dir', 'output.pdf'),
      expect.any(Buffer),
    );
    expect(result).toBe(path.join('/safe/dir', 'output.pdf'));
  });

  it('passes allowedRoots to resolveSafeOutputDir', async () => {
    mockResolveSafeOutputDir.mockResolvedValueOnce('/workspace/project');

    await saveTempFile(data, fileName, undefined, ['/workspace/project']);

    expect(mockResolveSafeOutputDir).toHaveBeenCalledWith(undefined, [
      '/workspace/project',
    ]);
  });

  it('uses only basename of fileName (no path traversal via filename)', async () => {
    mockResolveSafeOutputDir.mockResolvedValueOnce('/safe/dir');

    const result = await saveTempFile(data, '../../etc/passwd', undefined);

    expect(result).toBe(path.join('/safe/dir', 'passwd'));
  });

  it('propagates error from resolveSafeOutputDir when path is outside root', async () => {
    mockResolveSafeOutputDir.mockRejectedValueOnce(
      new Error(
        'outputDir "/etc/passwd" (resolved: "/etc/passwd") is outside the allowed roots: /safe/dir',
      ),
    );

    await expect(
      saveTempFile(data, fileName, '/etc/passwd'),
    ).rejects.toThrow('outside the allowed roots');
  });
});

// Note: resolveSafeOutputDir 単体のテストは src/safe-paths.spec.ts を参照。
