// MCP クライアント種別の推定 (PRJ-3-1438 / ST-1)。
//
// ## なぜ要るか
//
// ST-1 は「MCP client 種別 (Claude / Cursor / VS Code 等) を識別し、どの
// distribution channel が実際に paid workspace を生むか判定可能にする」ことを
// 求めているが、**現行はどのイベントにも client 種別が載っていない**。
// 唯一の材料は initialize ハンドシェイクでクライアントが名乗る `Implementation`
// (`{ name, version }`) で、SDK v2 では `Server.getClientVersion()` から読める。
//
// ## 設計の要点
//
// 1. **クライアントの自己申告であって検証された事実ではない。** 誰でも任意の名前を
//    名乗れる。課金や権限の判断には使わず、集計の内訳にだけ使う。
// 2. **既知パターンの一覧は「当てられたら当てる」程度のもの。** ここに無い
//    クライアントが来るのは異常ではなく通常。だから未知は捨てずに
//    `other` + 正規化した実名 (`clientName`) を出し、**後から一覧を育てられる**
//    ようにする。一覧の網羅性に依存する設計にしない。
// 3. **実名は記録しない。** 名前は外部入力（クライアントの自己申告）で、
//    文字種や長さのフィルタでは安全にできない。実測: `Alice Smith` /
//    `alice.smith` / SSN 形の `123-45-6789` はいずれも許可文字だけで構成され、
//    桁数の閾値も通り抜けて識別可能なまま保存されていた（PR #125 の Codex P1。
//    2 度の指摘で「文字種フィルタは sanitization ではない」と言われている）。
//    しかも HTTP 経路では未検証 Bearer でも telemetry が出るので、任意の PII を
//    collector へ送り込む経路になる。**種別だけを記録し、実名は捨てる。**
//    「未知のクライアントが居る」ことは件数（`clientNameOmitted`）で分かる。

/** 集計に使う正準の種別。ここに無いものは 'other'。 */
export type McpClientKind =
  | 'claude'
  | 'chatgpt'
  | 'cursor'
  | 'vscode'
  | 'windsurf'
  | 'cline'
  | 'zed'
  | 'continue'
  | 'other';

/**
 * 実名で使われる区切り。`cline-vscode` / `cline_vscode` / `cline vscode` /
 * `cline.vscode` のどれも同じ意味で来る。
 */
const SEP = '[-_. ]';

/**
 * 短い語を「独立した語として」照合する。
 *
 * **`\b` は使えない。** JavaScript の `\b` は `_` を単語構成文字として扱うので、
 * `cline_vscode` の `cline` の直後に境界が無く `\bcline\b` がマッチしない。
 * その結果、後段の `vscode` パターンに落ちて **フォーク勢が全部 VS Code に
 * 潰れる** — 順序を先に置いた意味が消える（実測: `cline_vscode` /
 * `continue_vscode` / `zed_vscode` がいずれも `vscode` に分類された。
 * PR #125 の Codex 指摘。指摘は cline / continue の 2 件だが、`\b` を使っている
 * パターンは zed を含めて 3 件あり、同じ欠陥だったので 3 件とも直す）。
 */
const word = (body: string): RegExp =>
  new RegExp(`(?:^|${SEP})(?:${body})(?:$|${SEP})`);

/**
 * 実名 (小文字化済み) から種別を決める照合規則。**上から順に最初に当たったものを採る。**
 *
 * 順序が意味を持つ組み合わせがある: 例えば Cursor は VS Code フォークなので
 * 実名に `vscode` を含みうる (`cursor-vscode`)。`cursor` を先に置かないと
 * VS Code として数えてしまう。同じ理由で Windsurf / Cline / Continue も
 * `vscode` より前に置く。
 */
const PATTERNS: ReadonlyArray<readonly [McpClientKind, RegExp]> = [
  ['cursor', /cursor/],
  ['windsurf', /windsurf|codeium/],
  ['cline', word('roo[-_. ]?cline|cline')],
  ['continue', word('continue')],
  ['zed', word('zed')],
  ['claude', /claude|anthropic/],
  ['chatgpt', /chatgpt|openai/],
  // VS Code はフォーク勢を全部拾ってしまうので必ず最後。
  ['vscode', /vs[-_ ]?code|visual studio code/],
];

/**
 * `Implementation.name` を種別へ。判定できなければ 'other'。
 *
 * **入力は信頼しない**: 文字列でない・空・異常に長い値でも落とさず 'other' を返す
 * (telemetry の解決でツール応答を壊さない、という interceptor の方針と揃える)。
 */
export const classifyMcpClient = (name: unknown): McpClientKind => {
  if (typeof name !== 'string') return 'other';
  const normalized = name.trim().toLowerCase();
  if (normalized === '') return 'other';
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(normalized)) return kind;
  }
  return 'other';
};

/**
 * 名前を名乗ってきたか（`clientNameOmitted` の判定に使う）。
 *
 * 値そのものは**どこにも記録しない**。記録するのは
 * 「種別を判定できないクライアントが居た」という事実だけで、
 * それは `client === 'other'` とこの真偽値の組み合わせで表す。
 *
 * ハッシュ等の擬似識別子も採らなかった: 短い人名の無塩ハッシュは辞書で戻せるし、
 * 鍵付きにすると鍵管理が要るか、プロセスをまたいだ計数が壊れる。得られるのは
 * 「異なる未知クライアントの数」だけで、PATTERNS を育てるには結局人に聞く必要が
 * あるため、件数で足りると判断した。
 */
export const hasMcpClientName = (name: unknown): boolean =>
  typeof name === 'string' && name.trim() !== '';
