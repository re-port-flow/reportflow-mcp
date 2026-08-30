#!/usr/bin/env node
/**
 * Markdown の相対リンク・アンカーリンクが実際に解決するかを検査する。
 *
 * なぜ要るか: このリポジトリは PRIVATE リポジトリから手動で同期される。PRIVATE 側に
 * だけ存在するディレクトリ (docs/ 等) を参照した行が README ごと同期されると、PUBLIC
 * では 404 になるリンクが残る。実際に README の `./docs/security.md` がこの形で壊れて
 * いた。人が気づく前提の運用では再発するので、CI で落とす。
 *
 * 検査するのはリポジトリ内で完結する参照だけ:
 *   - 相対パス       → ファイル/ディレクトリの実在を確認する
 *   - `#anchor`      → 同一ファイルの見出しから GitHub 互換の slug を作って照合する
 *   - `path#anchor`  → 参照先ファイルの見出しまで照合する
 *
 * 外部 URL (http/https/mailto 等) は検査しない。ネットワークに依存すると CI が外部
 * サービスの一時障害で赤くなり、「壊れている」と「到達できなかった」の区別がつかなく
 * なる。ここで守りたいのはリポジトリ同期で壊れる参照であって、外部サイトの生死ではない。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Git の管理下にある Markdown を対象にする (node_modules 等を自然に除外できる)。 */
function listMarkdownFiles() {
  const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '*.md', '*.mdx'], {
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

/**
 * コードブロック内を検査対象から外す。設定例やトラブルシュートの中の `[...](...)`
 * らしき文字列はリンクではないので、実在確認するとノイズになる。
 */
function stripFencedCodeBlocks(text) {
  const lines = text.split('\n');
  let fence = null;
  return lines
    .map((line) => {
      const m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (m) {
        if (fence === null) {
          fence = m[1][0].repeat(3);
          return '';
        }
        if (m[1][0].repeat(3) === fence) {
          fence = null;
          return '';
        }
      }
      return fence === null ? line : '';
    })
    .join('\n');
}

/** インラインコード `` `...` `` も同様に外す。 */
function stripInlineCode(text) {
  return text.replace(/`[^`\n]*`/g, '');
}

/**
 * GitHub の見出しアンカー生成規則に合わせる。GitHub は `{#custom-id}` 形式の明示 ID も
 * 解釈するので、それがあれば優先する。
 */
function headingAnchors(text) {
  const anchors = new Set();
  const seen = new Map();
  for (const line of stripFencedCodeBlocks(text).split('\n')) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    let title = m[2];

    const explicit = /\{#([^}]+)\}\s*$/.exec(title);
    if (explicit) {
      anchors.add(explicit[1].toLowerCase());
      title = title.slice(0, explicit.index);
    }

    const slug = title
      .replace(/`/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // リンク記法はテキストだけ残す
      .replace(/[*_~]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-');
    if (!slug) continue;

    // 同名見出しには GitHub が -1, -2 … を足す。
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    anchors.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return anchors;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** `[text](target "title")` の target 部分だけを取り出す。 */
function linkTargets(text) {
  const found = [];
  const re = /!?\[(?:[^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({ target: m[1], index: m.index });
  }
  return found;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

const anchorCache = new Map();
function anchorsFor(absPath) {
  if (!anchorCache.has(absPath)) {
    anchorCache.set(absPath, headingAnchors(readFileSync(absPath, 'utf8')));
  }
  return anchorCache.get(absPath);
}

const problems = [];
let checked = 0;

for (const file of listMarkdownFiles()) {
  const abs = resolve(repoRoot, file);
  const raw = readFileSync(abs, 'utf8');
  const scannable = stripInlineCode(stripFencedCodeBlocks(raw));

  for (const { target, index } of linkTargets(scannable)) {
    if (EXTERNAL.test(target)) continue;

    const line = lineOf(scannable, index);
    const [pathPart, anchor] = target.split('#');
    checked += 1;

    if (pathPart === '') {
      // 同一ファイル内アンカー
      if (anchor && !anchorsFor(abs).has(decodeURIComponent(anchor).toLowerCase())) {
        problems.push(`${file}:${line}: anchor not found: #${anchor}`);
      }
      continue;
    }

    const targetAbs = pathPart.startsWith('/')
      ? resolve(repoRoot, `.${pathPart}`)
      : resolve(dirname(abs), decodeURIComponent(pathPart));

    if (!existsSync(targetAbs)) {
      problems.push(`${file}:${line}: missing path: ${target}`);
      continue;
    }
    // リポジトリ外を指していないか (../.. で外に出る参照は同期先で必ず壊れる)
    if (relative(repoRoot, targetAbs).startsWith('..')) {
      problems.push(`${file}:${line}: points outside the repository: ${target}`);
      continue;
    }
    if (anchor && statSync(targetAbs).isFile() && /\.mdx?$/.test(targetAbs)) {
      if (!anchorsFor(targetAbs).has(decodeURIComponent(anchor).toLowerCase())) {
        problems.push(`${file}:${line}: anchor not found in ${pathPart}: #${anchor}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Broken Markdown links (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`OK: ${checked} internal Markdown link(s) resolve.`);
