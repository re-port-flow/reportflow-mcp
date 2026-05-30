import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// OS 一時ディレクトリ配下のデフォルトフォールバック名（roots/index.ts と合わせる）。
// allowedRoots が空のときに使う安全な書き込み領域。
export const DEFAULT_FALLBACK_DIR = path.join(os.tmpdir(), 'reportflow');

/**
 * outputDir をセキュアに解決する。
 *
 * ## 脅威モデル
 * MCP ツール引数 `outputDir` は AI エージェント経由で渡されるため、
 * プロンプトインジェクションにより攻撃者がコントロール可能。
 * 無検証で path.resolve するとプロセスが到達できる任意パス
 * (例: ~/.ssh, ~/.aws) への書き込みが可能になる。
 *
 * ## 許可ルートの決定順序
 * 1. `allowedRoots` 引数にパスが与えられた場合 — それを許可ルートとして使用。
 *    呼び出し元 (`src/roots/index.ts:resolveAllowedRoots`) が MCP Roots
 *    (server.server.listRoots) から取得した file:// URI をファイルパスに変換して渡す。
 * 2. `allowedRoots` が空 / 未提供の場合 — `os.tmpdir()/reportflow` を
 *    安全なデフォルトルートとして使用。`src/roots/index.ts:resolveDefaultOutputDir`
 *    のフォールバックと semantic を揃える (sensitive ファイルが無い書き込み可能領域)。
 *    TODO: MCP Roots spec (https://spec.modelcontextprotocol.io/specification/2025-03-26/client/roots/)
 *    が全クライアントで実装されれば、このフォールバックは不要になる。
 *
 * @param outputDir  ツール引数から来た出力先ディレクトリ（未信頼）
 * @param allowedRoots  許可する親ディレクトリのリスト（呼び出し元が決定）
 * @returns 検証済みの絶対パス（mkdir 前に呼ぶこと）
 * @throws outputDir が許可ルートの外にある場合
 */
export const resolveSafeOutputDir = async (
  outputDir?: string,
  allowedRoots: string[] = [],
): Promise<string> => {
  // 1. 許可ルートを決定
  const roots = allowedRoots.length > 0 ? allowedRoots : [DEFAULT_FALLBACK_DIR];

  // realpath で許可ルートのシンボリックリンクも解決する
  const resolvedRoots = await Promise.all(
    roots.map((r) => realpathOrResolve(r)),
  );

  // 2. outputDir が未指定 / 空文字 → 最初の許可ルートを返す
  if (!outputDir) {
    return resolvedRoots[0];
  }

  // 3. 要求パスを解決
  const requestedAbsolute = path.resolve(outputDir);

  // 4. realpath でシンボリックリンクを展開（パスが存在する場合）
  //    存在しない場合は「最長の存在する祖先」を realpath し、残りを連結する。
  const resolvedRequested = await realpathOfLongestExisting(requestedAbsolute);

  // 5. 許可ルートの子孫かどうかを検証
  for (const root of resolvedRoots) {
    if (isDescendantOrEqual(resolvedRequested, root)) {
      return resolvedRequested;
    }
  }

  throw new Error(
    `outputDir "${outputDir}" (resolved: "${resolvedRequested}") is outside the allowed roots: ${resolvedRoots.join(', ')}`,
  );
};

/**
 * 実行中の OS が case-insensitive なファイルシステムを既定で使うかどうか。
 * - macOS (APFS の既定は case-insensitive) / Windows (NTFS) → true
 * - Linux (ext4/xfs 等) → false
 *
 * 注: Linux でも case-insensitive にマウントすることは可能、また macOS で
 * case-sensitive APFS を選んでいるケースもあるため、これはあくまで OS 既定
 * に基づく heuristic。誤った fold は false-positive な「許可」(=root 内と
 * 誤判定) を生む可能性があるが、いずれのケースでも realpath が一致した
 * パスの大文字小文字違いを許す方向であり、root 外へ脱出する経路は無い。
 */
const isCaseInsensitiveFS = (): boolean =>
  process.platform === 'darwin' || process.platform === 'win32';

/**
 * case-insensitive FS でのみ ASCII fold する。
 * ASCII 範囲外 (例: 日本語ディレクトリ名) は realpath が正規化済みの
 * 表現を返すため、ロケール依存の `toLocaleLowerCase()` は使わない。
 */
const foldForCompare = (s: string): string =>
  isCaseInsensitiveFS() ? s.toLowerCase() : s;

/**
 * path が root と同一か、root の子孫であるか検証する。
 * 末尾セパレータの有無を正規化して比較する。
 *
 * case sensitivity:
 * - darwin (APFS 既定) / win32 (NTFS) は case-insensitive FS のため、両辺を
 *   `toLowerCase()` で fold してから比較する。これにより realpath 後の case
 *   が allowed root の case と異なる正規 outputDir (例: root=`/Users/Foo`,
 *   target=`/users/foo/out.pdf`) が誤って拒否されるのを防ぐ。
 * - linux は case-sensitive のため fold せず厳格に比較する。
 *
 * 境界判定 (`/foo/bar` vs `/foo/barbaz`) は `root + path.sep` を付与した
 * 前方一致で行うため、fold 後も同じ性質を保つ。
 */
const isDescendantOrEqual = (target: string, root: string): boolean => {
  const foldedTarget = foldForCompare(target);
  const foldedRoot = foldForCompare(root);
  const normalizedRoot = foldedRoot.endsWith(path.sep)
    ? foldedRoot
    : foldedRoot + path.sep;
  return foldedTarget === foldedRoot || foldedTarget.startsWith(normalizedRoot);
};

/**
 * パスが存在する場合は fs.realpath を返す。
 * 存在しない場合は path.resolve のみ行う（シンボリックリンク解決なし）。
 */
const realpathOrResolve = async (p: string): Promise<string> => {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * パスが存在しない場合、存在する最長の祖先ディレクトリを realpath して
 * 残りのパス部分を連結する。
 *
 * これにより、未作成の中間ディレクトリを含むシンボリックリンク経由の
 * エスケープを防ぐ（攻撃者が許可ルート外を指すシンボリックリンクを
 * 事前に配置するケースを含む）。
 */
const realpathOfLongestExisting = async (absPath: string): Promise<string> => {
  try {
    return await fs.promises.realpath(absPath);
  } catch {
    // パスが存在しない — 祖先を遡って realpath する
    const parts: string[] = [];
    let current = absPath;

    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) {
        // ルートに達した。ルート自体を realpath して連結する
        const resolvedRoot = await realpathOrResolve(current);
        parts.reverse();
        return path.join(resolvedRoot, ...parts);
      }
      parts.push(path.basename(current));
      current = parent;
      try {
        const resolvedParent = await fs.promises.realpath(current);
        parts.reverse();
        return path.join(resolvedParent, ...parts);
      } catch {
        // この祖先もまだ存在しない — さらに遡る
        continue;
      }
    }
  }
};

/**
 * テスト用エクスポート（内部実装の詳細）
 */
export const _testExports = {
  isDescendantOrEqual,
  realpathOfLongestExisting,
};
