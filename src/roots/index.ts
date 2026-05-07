import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const FALLBACK_DIR_NAME = 'reportflow';

/**
 * クライアントがワークスペース（Roots）を提示している場合は最初の file:// URI を絶対パスへ変換して返す。
 * Roots 未対応クライアント / 取得失敗 / 空配列の場合は OS の一時ディレクトリ配下にフォールバック。
 */
export const resolveDefaultOutputDir = async (
  server: McpServer,
): Promise<string> => {
  try {
    const result = await server.server.listRoots();
    const fileRoot = result.roots.find((r) => r.uri.startsWith('file://'));
    if (fileRoot) {
      return fileURLToPath(fileRoot.uri);
    }
  } catch {
    // listRoots not supported by client — fallthrough to tmpdir.
  }
  return path.join(os.tmpdir(), FALLBACK_DIR_NAME);
};
