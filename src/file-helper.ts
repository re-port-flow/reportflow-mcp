import * as fs from 'fs';
import * as path from 'path';
import { resolveSafeOutputDir } from './safe-paths.js';

/**
 * 生成したファイルをローカルに保存し、絶対パスを返す。
 *
 * - outputDir 指定あり: 許可ルート内であることを検証してから出力
 * - outputDir 未指定 : process.cwd() (安全なデフォルト) に出力
 *
 * fileName は basename のみが使われる (パスセパレータは無視)。
 *
 * @param allowedRoots  MCP Roots から取得した許可ディレクトリ一覧。
 *                      空の場合は process.cwd() を安全なデフォルトとして使用。
 */
export const saveTempFile = async (
  data: ArrayBuffer,
  fileName: string,
  outputDir?: string,
  allowedRoots: string[] = [],
): Promise<string> => {
  const targetDir = await resolveSafeOutputDir(outputDir, allowedRoots);
  await fs.promises.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, path.basename(fileName));
  await fs.promises.writeFile(filePath, Buffer.from(data));
  return filePath;
};
