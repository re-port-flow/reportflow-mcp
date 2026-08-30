#!/usr/bin/env node
/**
 * package.json の scripts が参照するローカルファイル / 他の script の実在を検査する。
 *
 * なぜ要るか: このリポジトリは PRIVATE リポジトリから手動で同期される。package.json が
 * 同期されて参照先 (scripts/ 等) が同期されないと、エントリだけが残って実行不能になる。
 * 実際に `test:packaging` が `scripts/packaging-smoke.mjs` を指したまま、そのファイルが
 * PUBLIC に存在しない状態になっていた。README の壊れたリンク (check-markdown-links.mjs)
 * と同じクラスの破損で、CI がこの script を呼んでいなければ緑のまま素通りする。人が
 * 気づく前提の運用では再発するので、CI で落とす。
 *
 * 検査するのは「無ければ確実に実行不能になる参照」だけ。誤検知が出る検査は無視される
 * ようになり、結局この破損を止められなくなる:
 *   - ランナーの引数        `node scripts/x.mjs` / `bash x.sh` / `ts-node src/x.ts`
 *   - 明示的な相対パス      `./x.sh`
 *   - 設定ファイル指定      `tsc -p tsconfig.build.json` / `--config x.json`
 *   - script 間の参照       `npm run other` / `yarn run other`
 *
 * 検査しないもの (それぞれ「壊れている」と言えないため):
 *   - glob パターン         `src/**\/*.ts` は 0 件マッチでも実行できる
 *   - gitignore 対象        `dist/index.js` はビルド生成物で、リポジトリに無いのが正常
 *   - URL / npm パッケージ名  ローカルパスではない
 *   - 素の引数              `--max-warnings 0` のような値をパス扱いすると誤検知になる
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** ローカルファイルを実行するコマンド。直後の非フラグ引数がスクリプト本体。 */
const RUNNERS = new Set(['node', 'bash', 'sh', 'zsh', 'python', 'python3', 'ts-node', 'tsx']);
/** 直後の引数が設定ファイルパスになるフラグ。 */
const CONFIG_FLAGS = new Set(['-p', '--project', '-c', '--config', '--tsconfig']);
/** 直後の引数が package.json の別 script 名になるコマンド列。 */
const RUN_PREFIXES = [
  ['npm', 'run'],
  ['yarn', 'run'],
  ['pnpm', 'run'],
  ['npm', 'run-script'],
];

const GLOB = /[*?[\]{}]/;

/**
 * シェルの語分割を最小限だけ再現する。クォートを解釈しないと
 * `--ignore-pattern "src/**\/*.spec.ts"` が語の途中で割れて、glob の断片が
 * 「実在しないファイル」に見える (実測で誤検知した)。
 */
function tokenize(command) {
  const commands = [];
  let tokens = [];
  let cur = '';
  let quoted = false;
  let quote = null;

  const pushToken = () => {
    if (cur !== '' || quoted) tokens.push(cur);
    cur = '';
    quoted = false;
  };
  const pushCommand = () => {
    pushToken();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += command[i + 1];
      i += 1;
      continue;
    }
    // コマンド区切り: 後続を別コマンドとして扱わないと `a && node b.mjs` の
    // ランナー判定が前のコマンドに引きずられる。
    if (ch === '&' || ch === '|' || ch === ';') {
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||') i += 1;
      pushCommand();
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    cur += ch;
  }
  pushCommand();
  return commands;
}

const isFlag = (t) => t.startsWith('-');
const isExternal = (t) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(t);

/** そのコマンドで「実在していなければならない」パスを取り出す。 */
function requiredPaths(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (RUNNERS.has(t)) {
      // ランナー自身のフラグを読み飛ばして最初の実引数を取る
      for (let j = i + 1; j < tokens.length; j += 1) {
        if (isFlag(tokens[j])) continue;
        out.push({ path: tokens[j], why: `${t} の実行対象` });
        break;
      }
      continue;
    }
    if (CONFIG_FLAGS.has(t) && tokens[i + 1] !== undefined && !isFlag(tokens[i + 1])) {
      out.push({ path: tokens[i + 1], why: `${t} の指定先` });
      continue;
    }
    if (t.startsWith('./') || t.startsWith('../')) {
      out.push({ path: t, why: '相対パス指定' });
    }
  }
  return out;
}

/** そのコマンドが参照している他の script 名を取り出す。 */
function referencedScripts(tokens) {
  for (const [bin, sub] of RUN_PREFIXES) {
    if (tokens[0] === bin && tokens[1] === sub && tokens[2] && !isFlag(tokens[2])) {
      return [tokens[2]];
    }
  }
  return [];
}

/**
 * gitignore の解釈は自前で書かず git に聞く。`.gitignore` を正規表現で近似すると
 * 否定パターン (`!...`) やディレクトリ規則でずれる。
 */
function isGitIgnored(path) {
  try {
    execFileSync('git', ['-C', repoRoot, 'check-ignore', '-q', '--', path], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};
const scriptNames = new Set(Object.keys(scripts));

const problems = [];
let checked = 0;

for (const [name, command] of Object.entries(scripts)) {
  for (const tokens of tokenize(command)) {
    for (const ref of referencedScripts(tokens)) {
      checked += 1;
      if (!scriptNames.has(ref)) {
        problems.push(`scripts.${name}: 参照している script が無い: "${ref}"`);
      }
    }

    for (const { path, why } of requiredPaths(tokens)) {
      if (isExternal(path) || GLOB.test(path)) continue;
      // ビルド生成物はリポジトリに無いのが正常
      if (isGitIgnored(path)) continue;

      checked += 1;
      const abs = resolve(repoRoot, path);
      if (relative(repoRoot, abs).startsWith('..')) {
        problems.push(`scripts.${name}: リポジトリ外を参照している (${why}): ${path}`);
        continue;
      }
      if (!existsSync(abs)) {
        problems.push(`scripts.${name}: 参照先が存在しない (${why}): ${path}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Broken package.json script references (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nPRIVATE から同期するときに参照先ファイルが漏れた可能性がある。' +
      '参照先を同期するか、エントリ自体を消すこと。',
  );
  process.exit(1);
}

console.log(`OK: ${checked} package.json script reference(s) resolve.`);
