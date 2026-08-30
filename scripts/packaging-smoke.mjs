#!/usr/bin/env node
/**
 * Layer C: packaging smoke test
 *
 * 1. yarn build
 * 2. npm pack → tarball 生成
 * 3. tmpdir で npm install <tarball>
 * 4. shebang / exec bit / bin symlink を検証
 * 5. bin 経由で spawn → MCP initialize + tools/list を交換
 * 6. tool 数 / 必須 tool 名を検証
 * 7. teardown
 *
 * なぜ要るか: npm publish するのはこのリポジトリで、公開されるのは `dist/` を固めた
 * tarball であって `src/` ではない。ユニットテストも e2e も in-process で回るので、
 * 「ビルド・梱包の経路でだけ壊れる」種類の事故は素通りする。実際に shebang が欠けた
 * まま npm へ出た事故が 2 回起きている (PR #4 / PR #9)。この検査はそこを塞ぐ。
 */

import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT_DIR = resolve(import.meta.dirname, '..');
// stdio モードの期待ツール数 (search / fetch は ChatGPT Apps 規約ツールとして両モードに登録)
// +2 = ギャラリー参照ツール (search_gallery_templates / get_gallery_template, PRJ-3-1237)。
// +1 = ギャラリー複製ツール (copy_gallery_template, PRJ-3-1238)。
const EXPECTED_TOOL_COUNT = 15;
// 件数だけの検証では、ツールが入れ替わった / 改名された配布物を検出できない。
// 実 stdio プロセスで「この名前で公開されていること」まで確認する
// (npm 公開版にギャラリーツールが含まれない配布事故を検出するため)。
const REQUIRED_TOOL_NAMES = [
  'search_gallery_templates',
  'get_gallery_template',
  'copy_gallery_template',
];

// initialize.instructions (PRJ-3-1373) を必須にするかは、リポジトリに実装があるかで決める。
//
// この 1 ファイルは PRIVATE (monepla/report-mcp) と PUBLIC (re-port-flow/reportflow-mcp)
// の両方で動く必要がある。PUBLIC は PRIVATE のリリース断面が同期されたもので、
// instructions は PUBLIC v1.4.0 の時点ではまだ入っていない。ここを無条件 assert に
// すると PUBLIC で必ず落ち、逆に無条件 skip にすると PRIVATE で「梱包経路で
// instructions が落ちても素通り」という、この検査が塞ぎたかった穴がそのまま開く。
//
// src/instructions.ts の実在を判定に使えば、PUBLIC へ src/ が同期された時点で
// 検査が自動的に有効化される。人が思い出して復活させる運用にしない。
// skip したときは「検証済み」ではなく「未検証」とログに出す (観測できなかったことを
// 異常なしと混同しない)。
const INSTRUCTIONS_SOURCE = join(ROOT_DIR, 'src', 'instructions.ts');
const INSTRUCTIONS_REQUIRED = existsSync(INSTRUCTIONS_SOURCE);

// ─── helpers ──────────────────────────────────────────────────────────────────

const run = (cmd, args, opts = {}) => {
  console.log(`[smoke] $ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
};

const runCapture = (cmd, args, opts = {}) => {
  const out = execFileSync(cmd, args, { encoding: 'utf8', ...opts });
  return out.trim();
};

const fail = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
};

const ok = (msg) => {
  console.log(`[smoke] OK: ${msg}`);
};

const skip = (msg) => {
  console.log(`[smoke] SKIP (未検証): ${msg}`);
};

// ─── 1. build ─────────────────────────────────────────────────────────────────

console.log('\n[smoke] === Step 1: yarn build ===');
run('yarn', ['build'], { cwd: ROOT_DIR });
ok('build completed');

// ─── 2. npm pack ──────────────────────────────────────────────────────────────

console.log('\n[smoke] === Step 2: npm pack ===');
const packOutput = runCapture('npm', ['pack', '--json'], { cwd: ROOT_DIR });
const packJson = JSON.parse(packOutput);
const tarballName = packJson[0]?.filename ?? packJson[0]?.name;
if (!tarballName) fail('npm pack did not return a filename');
const tarballPath = join(ROOT_DIR, tarballName);
if (!existsSync(tarballPath)) fail(`tarball not found: ${tarballPath}`);
ok(`tarball: ${tarballName}`);

// ─── 3. tmpdir + npm install ──────────────────────────────────────────────────

console.log('\n[smoke] === Step 3: npm install in tmpdir ===');
const tmpDir = mkdtempSync(join(tmpdir(), 'reportflow-mcp-smoke-'));
console.log(`[smoke] tmpdir: ${tmpDir}`);

try {
  run('npm', ['init', '-y'], { cwd: tmpDir });
  run(
    'npm',
    ['install', tarballPath, '--ignore-scripts', '--no-fund', '--no-audit'],
    { cwd: tmpDir },
  );
  ok('npm install completed');

  // ─── 4. 静的検証 ──────────────────────────────────────────────────────────

  console.log('\n[smoke] === Step 4: static checks ===');

  const distIndex = join(tmpDir, 'node_modules', 'reportflow-mcp', 'dist', 'index.js');
  if (!existsSync(distIndex)) fail(`dist/index.js not found: ${distIndex}`);

  // shebang check
  const firstLine = readFileSync(distIndex, 'utf8').split('\n')[0];
  if (firstLine !== '#!/usr/bin/env node') {
    fail(`shebang missing or wrong. First line: ${JSON.stringify(firstLine)}`);
  }
  ok('shebang: #!/usr/bin/env node');

  // exec bit check
  const stat = statSync(distIndex);
  const hasExecBit = (stat.mode & 0o111) !== 0;
  if (!hasExecBit) {
    fail(`exec bit not set on dist/index.js (mode: ${stat.mode.toString(8)})`);
  }
  ok(`exec bit set (mode: ${stat.mode.toString(8)})`);

  // bin symlink check
  const binPath = join(tmpDir, 'node_modules', '.bin', 'reportflow-mcp');
  if (!existsSync(binPath)) fail(`bin symlink not found: ${binPath}`);
  ok('bin symlink: node_modules/.bin/reportflow-mcp exists');

  // ─── 5-8. bin 経由 spawn + MCP プロトコル交換 ─────────────────────────────

  console.log('\n[smoke] === Step 5-8: spawn via bin + MCP protocol ===');

  await new Promise((resolve, reject) => {
    const child = spawn(binPath, [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        // テスト用ダミー env — ネットワーク接続しないので何でも OK
        REPORTFLOW_API_BASE_URL: 'http://localhost:3002',
        REPORTFLOW_AUTH_URL: 'http://localhost:3000/api/v1',
        REPORTFLOW_CLIENT_ID: 'smoke-test',
        REPORTFLOW_TOKEN_STORE: 'file',
      },
    });

    // Fix 4: readline で行単位処理に切り替え。チャンク分割によるフラキーを排除。
    // setTimeout を保持して resolve/reject 後に clearTimeout する。
    let initialized = false;
    let toolsListDone = false;

    const rl = createInterface({ input: child.stdout });

    const cleanup = () => {
      clearTimeout(timeoutId);
      rl.close();
      child.kill();
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('timeout: MCP protocol exchange took > 10s'));
    }, 10_000);

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 非 JSON 行 (stderr 等) は無視
        return;
      }

      if (msg.id === 1 && msg.result && !initialized) {
        // initialize response
        initialized = true;
        ok(`initialize: serverInfo.name = ${msg.result.serverInfo?.name}`);
        if (msg.result.serverInfo?.name !== 'reportflow-mcp') {
          cleanup();
          reject(new Error(`serverInfo.name mismatch: ${msg.result.serverInfo?.name}`));
          return;
        }
        // instructions (PRJ-3-1373): 接続直後の初回導線をクライアント AI に渡す。
        // in-process の e2e とは別に、パッケージ済み dist を実 stdio で起動した
        // ときの initialize 応答にも載っていることをここで見る (ビルド/梱包の
        // 経路で落ちても e2e は素通りするため)。
        const instructions = msg.result.instructions;
        const hasInstructions =
          typeof instructions === 'string' && instructions.includes('search_gallery_templates');
        if (INSTRUCTIONS_REQUIRED) {
          if (!hasInstructions) {
            cleanup();
            reject(
              new Error(
                'initialize.instructions missing or does not reference the first-run flow ' +
                  '(src/instructions.ts があるので必須。梱包経路で落ちた可能性がある)',
              ),
            );
            return;
          }
          ok(`initialize: instructions ${instructions.length} chars`);
        } else if (hasInstructions) {
          // 実装が別経路で入った場合。skip したままにすると検査が死ぬので拾う。
          ok(`initialize: instructions ${instructions.length} chars (src/instructions.ts は無いが載っていた)`);
        } else {
          skip('initialize.instructions — src/instructions.ts が無いので検査対象外');
        }
        // send initialized notification
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n',
        );
        // request tools/list
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
        );
      } else if (msg.id === 2 && msg.result && !toolsListDone) {
        toolsListDone = true;
        const tools = msg.result.tools ?? [];
        const toolCount = tools.length;
        ok(`tools/list: ${toolCount} tools returned`);
        if (toolCount !== EXPECTED_TOOL_COUNT) {
          cleanup();
          reject(
            new Error(
              `Expected ${EXPECTED_TOOL_COUNT} tools, got ${toolCount}: ${tools.map((t) => t.name).join(', ')}`,
            ),
          );
          return;
        }
        const names = tools.map((t) => t.name);
        const missing = REQUIRED_TOOL_NAMES.filter((n) => !names.includes(n));
        if (missing.length > 0) {
          cleanup();
          reject(new Error(`Missing expected tools: ${missing.join(', ')} (got: ${names.join(', ')})`));
          return;
        }
        ok(`required tools present: ${REQUIRED_TOOL_NAMES.join(', ')}`);
        cleanup();
        resolve(undefined);
      }
    });

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (!toolsListDone) {
        cleanup();
        reject(new Error(`child exited before tools/list completed: code=${code} signal=${signal}`));
      }
    });

    // initialize request (must come first)
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { sampling: {} },
          clientInfo: { name: 'smoke-test', version: '0.0.0' },
        },
      }) + '\n',
    );
  });

  ok(`tool count == ${EXPECTED_TOOL_COUNT}`);

  // ─── 9. teardown ──────────────────────────────────────────────────────────

  console.log('\n[smoke] === Step 9: teardown ===');

} finally {
  rmSync(tmpDir, { recursive: true, force: true });
  // tarball も削除
  try {
    rmSync(tarballPath, { force: true });
  } catch {
    // ignore
  }
  ok('tmpdir cleaned up');
}

console.log('\n[smoke] ✓ All packaging smoke checks passed');
