import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const FALLBACK_DIR_NAME = 'reportflow';

/**
 * Roots 未取得時のフォールバックディレクトリ。
 * `os.tmpdir()/reportflow` — sensitive ファイルが無い書き込み可能領域。
 * `resolveDefaultOutputDir` と `resolveAllowedRoots` で共通利用する。
 */
const fallbackTmpRoot = (): string => path.join(os.tmpdir(), FALLBACK_DIR_NAME);

/**
 * `server.server.listRoots()` を呼び、file:// URI を持つ Roots のパスを配列で返す。
 * - Roots 未対応クライアント / 取得失敗 → 空配列
 * - file:// 以外の URI (http:// 等) はフィルタ
 *
 * 呼び出し側で空配列を tmpdir フォールバックに変換すること。
 */
const listFileRootPaths = async (server: McpServer): Promise<string[]> => {
  try {
    const result = await server.server.listRoots();
    return result.roots
      .filter((r) => r.uri.startsWith('file://'))
      .map((r) => fileURLToPath(r.uri));
  } catch {
    // listRoots not supported by client — caller will fallback.
    return [];
  }
};

/**
 * クライアントがワークスペース（Roots）を提示している場合は最初の file:// URI を絶対パスへ変換して返す。
 * Roots 未対応クライアント / 取得失敗 / 空配列の場合は OS の一時ディレクトリ配下にフォールバック。
 *
 * `outputDir` 未指定時のデフォルト保存先として使う。
 */
export const resolveDefaultOutputDir = async (
  server: McpServer,
): Promise<string> => {
  const roots = await listFileRootPaths(server);
  if (roots.length > 0) {
    return roots[0];
  }
  return fallbackTmpRoot();
};

/**
 * `outputDir` を許可するルート集合を返す。
 *
 * - Roots を宣言しているクライアント (Claude Desktop / Code / Cursor の最新版等) →
 *   宣言された file:// Roots 全てを返す。明示 `outputDir` が Roots 配下なら通る。
 * - Roots 未対応 / 取得失敗 → `[fallbackTmpRoot()]` (= `os.tmpdir()/reportflow`)。
 *   これにより明示 `outputDir` も tmpdir 配下にしか書けず、`/etc`, `~/.ssh` 等への
 *   任意書き込みを防ぐ。`resolveDefaultOutputDir` の fallback と semantic を揃える。
 *
 * 必ず非空配列を返すため、呼び出し側で空チェック不要。
 */
export const resolveAllowedRoots = async (
  server: McpServer,
): Promise<string[]> => {
  const roots = await listFileRootPaths(server);
  if (roots.length > 0) {
    return roots;
  }
  return [fallbackTmpRoot()];
};
