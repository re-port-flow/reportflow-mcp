import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const saveTempFile = async (
  data: ArrayBuffer,
  fileName: string,
): Promise<string> => {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'reportflow-'),
  );
  const filePath = path.join(tempDir, path.basename(fileName));
  await fs.promises.writeFile(filePath, Buffer.from(data));
  return filePath;
};
