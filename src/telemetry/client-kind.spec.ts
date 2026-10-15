import { classifyMcpClient, hasMcpClientName } from './client-kind.js';

describe('classifyMcpClient', () => {
  it.each([
    ['claude-ai', 'claude'],
    ['Claude Desktop', 'claude'],
    ['chatgpt', 'chatgpt'],
    ['Zed', 'zed'],
    ['continue', 'continue'],
    ['windsurf', 'windsurf'],
    ['cline', 'cline'],
    ['Visual Studio Code', 'vscode'],
    ['vscode', 'vscode'],
  ])('classifies %s as %s', (name, expected) => {
    expect(classifyMcpClient(name)).toBe(expected);
  });

  // Cursor / Windsurf / Cline は VS Code フォークなので実名に vscode を含みうる。
  // 照合順が崩れると全部 vscode に潰れる（一覧を足すときに最も壊しやすい箇所）。
  it.each([
    ['cursor-vscode', 'cursor'],
    ['Cursor (VS Code)', 'cursor'],
    ['windsurf-vscode', 'windsurf'],
    ['cline-vscode', 'cline'],
  ])(
    '%s は vscode ではなく %s に分類する（照合順の回帰）',
    (name, expected) => {
      expect(classifyMcpClient(name)).toBe(expected);
    },
  );

  // **`\b` は `_` を単語構成文字として扱う**ので、以前は `cline_vscode` が
  // 境界照合に失敗し、後段の vscode パターンに落ちて全部 `vscode` になっていた
  // （実測で cline / continue / zed の 3 つとも該当）。ハイフン形しか見ていなかった
  // 上の回帰テストをすり抜けたので、区切りを変えた形を明示的に固定する。
  it.each([
    ['cline_vscode', 'cline'],
    ['continue_vscode', 'continue'],
    ['zed_vscode', 'zed'],
    ['cline.vscode', 'cline'],
    ['zed vscode', 'zed'],
    ['roo_cline', 'cline'],
  ])('%s は区切りが _ / . / 空白でも %s に分類する', (name, expected) => {
    expect(classifyMcpClient(name)).toBe(expected);
  });

  // 語の一部に含まれるだけの語を拾わない（境界照合を緩めすぎていないこと）
  it.each([['zedis'], ['discontinued'], ['clines']])(
    '%s は独立した語でないので other',
    (name) => {
      expect(classifyMcpClient(name)).toBe('other');
    },
  );

  it('未知の名前は other にする（一覧の網羅性に依存しない）', () => {
    expect(classifyMcpClient('some-new-agent')).toBe('other');
  });

  it.each([[undefined], [null], [123], [{}], [''], ['   ']])(
    '文字列でない・空の入力 (%p) でも落とさず other を返す',
    (input) => {
      expect(classifyMcpClient(input)).toBe('other');
    },
  );
});

describe('hasMcpClientName', () => {
  // **実名そのものは記録しない**（文字種フィルタでは外部入力を安全にできない。
  // 実測で `Alice Smith` / `alice.smith` / SSN 形の `123-45-6789` がいずれも
  // 素通りした）。記録するのは「名前を名乗ってきた」という事実だけ。
  it.each([
    ['claude-ai'],
    ['Alice Smith'],
    ['alice@example.com'],
    ['123-45-6789'],
    ['***'],
  ])('名前を名乗っていれば true (%p)', (input) => {
    expect(hasMcpClientName(input)).toBe(true);
  });

  it.each([[undefined], [null], [''], ['   '], [42], [{}]])(
    '名前が無い・文字列でない (%p) は false',
    (input) => {
      expect(hasMcpClientName(input)).toBe(false);
    },
  );
});
