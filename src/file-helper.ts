import * as fs from 'fs';
import * as path from 'path';

/**
 * 生成したファイルをローカルに保存し、絶対パスを返す。
 *
 * - outputDir 指定あり: そのディレクトリに出力 (相対パスは process.cwd() 基準で絶対化)
 * - outputDir 未指定 : process.cwd() に出力
 *
 * fileName は basename のみが使われる (パスセパレータは無視)。
 */
export const saveTempFile = async (
  data: ArrayBuffer,
  fileName: string,
  outputDir?: string,
): Promise<string> => {
  const targetDir = outputDir ? path.resolve(outputDir) : process.cwd();
  await fs.promises.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, path.basename(fileName));
  await fs.promises.writeFile(filePath, Buffer.from(data));
  return filePath;
};
