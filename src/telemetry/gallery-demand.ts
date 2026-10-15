// 公開テンプレートギャラリーの「需要」テレメトリ (PRJ-3-1350 / 親 PRJ-3-1348)。
//
// 既存の `integration.mcp.invoked` は { tool, durationMs, success, errorClass? }
// しか載せていない。つまり「search_gallery_templates が何回呼ばれたか」は分かるが
// 「どの帳票が探されたか」は分からない。公開一覧 API にテキスト検索パラメータが
// 無く、絞り込みは MCP 側のクライアントフィルタで行っている
// (`tools/search-gallery-templates.ts` 冒頭参照) ため、**サーバー側のアクセス
// ログにも検索語は残らない**。需要を数えるにはここで計測するしかない。
//
// このモジュールは「送る値を作る」ところまでを持ち、送信そのものは呼び出し側
// (server.ts) が `TelemetryClient.track()` で行う。ツール本体 (`tools/`) は
// 観測値をコールバックへ渡すだけで、`TelemetryClient` には触らない
// (観測値の型だけ `import type` で共有する。実行時の依存は無い)。
//
// ## workspaceId の扱い (2 イベントで異なる)
//
// `withTelemetry` は成功した呼び出しにだけ workspace を付ける。その根拠は
// 「成功 = 上流 API がその Bearer を受理した」であって、**署名検証していない
// Bearer JWT の claim をそのまま信じてよい根拠ではない** (interceptor.ts の
// PRJ-3-1117 コメント参照)。
//
// - `gallery.searched`: **載せない**。`search_gallery_templates` は認証不要の
//   公開 API しか叩かないので、成功しても Bearer は一度も検証されていない。
//   同じ規則を字面どおり当てはめると「未認証の第三者が任意のワークスペース宛に
//   イベントを注入できる」という、PRJ-3-1117 が塞いだ穴を作り直すことになる。
//   需要ランキング (ST3) はキーワードで GROUP BY するだけで workspace を使わない。
// - `gallery.copied`: **成功時のみ載せる**。複製は認証つきの書き込みで、成功は
//   「上流 API が Bearer を受理して実際に書き込んだ」ことを意味するため、
//   PRJ-3-1117 の根拠がそのまま当てはまる。値は複製 API の応答が返した
//   workspaceId (未検証の JWT claim ではなくサーバーが確定させた値)。
//   失敗時は書き込みが起きていないので載せない。
//
// ST2 の指示は「workspaceId 付与ルールは interceptor と同一」だったが、その
// **括弧書きの理由** (未認証・失敗時の注入による指標汚染を防ぐ) に従うと検索側は
// 載せないのが正しい。複製側の帰属はユーザー承認済み。
//
// スキーマ規約: Notion「Event Telemetry Schema」(https://app.notion.com/p/3bc2873e44e4816d96e8d35fe6b472ea)

import type { TelemetryClient, TelemetryProperties } from './client.js';

/**
 * 検索需要イベント。
 *
 * `integration.mcp.gallery_searched` にしていない理由: report-flow の
 * `tools/telemetry/ae-query.sh` はイベント名を SQL の文字列リテラルへ埋め込む前に
 * `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$` で検証しており、**アンダースコアを弾く**
 * (AE SQL は文字列リテラル内の backslash / single-quote を受け付けずエスケープ
 * できないので、注入を文字集合で断つ設計)。Notion「Event Telemetry Schema」 §2 も
 * `user_signup` をアンダースコア禁止の invalid 例に挙げている。namespace を
 * `integration.mcp.gallery` まで伸ばして verb を `searched` にすれば、両方の
 * 規約を満たしたままギャラリー系イベントをまとめられる。
 */
export const GALLERY_SEARCHED_EVENT = 'integration.mcp.gallery.searched';

/** 複製イベント (検索 → 複製の転換を見るため)。命名理由は上と同じ。 */
export const GALLERY_COPIED_EVENT = 'integration.mcp.gallery.copied';

/** 正規化後クエリの最大長 (コードポイント数)。超過時は `queryTruncated` で明示する。 */
export const QUERY_MAX_LENGTH = 100;

/** category / 未検証の slug は識別子なのでクエリより短くてよい。 */
export const CODE_MAX_LENGTH = 64;

/**
 * ギャラリー API が実在を認めた slug の上限。
 *
 * 検証済み slug を 64 文字で切ると、**別テンプレートの複製が同じキーへ併合される**
 * （切り詰めた値は「正確な識別子に見えるのに実物と違う」ので、突き合わせが壊れる
 * だけでなく静かに合算される）。API 契約 (`openapi/coze-plugin-gallery.yaml`) は
 * `slug` に `maxLength` を置いていないので、64 文字は producer 側が勝手に決めた
 * 制限でしかない (developer-docs PR #175 の Codex 指摘)。
 *
 * とはいえ properties は 4096 byte 上限があるので無制限にはできない。512 文字なら
 * 実在しうる slug をすべて収めつつ、上限に対して十分な余裕が残る。ここすら超えた
 * 値は `slugTruncated: true` が付くので、下流は「完全一致に使えない」と判別できる。
 */
export const VERIFIED_SLUG_MAX_LENGTH = 512;

export const MASK_URL = '<url>';
export const MASK_EMAIL = '<email>';
export const MASK_NUMBER = '<num>';

// --------------------------------------------------------------------------
// PII 形状マスク
// --------------------------------------------------------------------------
// Notion「Event Telemetry Schema」 §7.3 は「ユーザーが入力したテキストを properties に
// 入れない」と定めている。検索クエリはまさに自由記述なので、収録は §7.3 の
// **明示的な例外**であり、ユーザー承認を得たうえで「形として PII と分かるもの」を
// 落としてから記録する (承認: PRJ-3-1351 / ST1)。
//
// collector 側の PII 拒否は**キー名**の deny-list だけで、値の中身は見ない
// (`analytics-collector/src/lib/validation.ts` の scanForPii)。つまり値の
// マスクはこちらでやらないと誰もやらない。
//
// マスクは網羅ではなく「形で判別できるものだけ」。社名・人名・固有名詞のような
// 形の無い情報は残る。これは需要ランキングを成立させるための意図的な残余で、
// 完全な匿名化ではないことを schema 文書にも明記する。

/**
 * 正規表現を掛ける前に切り落とす上限。**DoS 対策として必須**。
 *
 * `query` は zod で長さ制限しておらず、HTTP 経路は 4MB のボディを受ける。
 * かつての非アンカーなメール正規表現は、`@` を含まない
 * ASCII 文字列に対して位置ごとに再走査するため二次で効く —— 実測で
 * **`a` 80,000 文字が 6.9 秒**、この間 Node のイベントループが止まる。
 * ギャラリー検索は認証不要なので、誰でもサーバーを停滞させられた
 * (PR #117 の Codex 指摘)。
 *
 * 出力は最大 `QUERY_MAX_LENGTH` 文字なので、その 10 倍を残せば
 * 「マスク → 切り詰め」の順序で守りたい境界 (100 文字付近にある PII トークンを
 * 完全な形で見る) には十分。1000 文字なら最悪でも 10^6 ステップで収まる。
 */
const REGEX_INPUT_MAX_LENGTH = 1000;

/**
 * URL。**`/` `?` `#` を含む空白区切りトークンのうち、ドットかコロンを持つもの**を
 * 丸ごとマスクする (判定は `shouldMaskUrlToken`)。
 *
 * 先頭の `(?<![^\s])` は「トークンの先頭でだけ試す」ためのアンカー。無いと
 * 走査開始位置がトークン内の全文字になり、`[` を 1000 個並べた入力で
 * 実測 475ms かかった（セルフレビューで検出。これは元の DoS 指摘そのもの）。
 * 同じ理由でメール系・角括弧系のトークン規則にも付けてある。
 *
 * ここも元は形の列挙だった (scheme 付き / `www.` / スキーム無し / ポート付き /
 * IPv4 / punycode / 国際化ドメイン / 角括弧 IPv6 / zone id / protocol-relative /
 * クエリのみ…)。PR #117 では**そのすべてが「その形は入っていない」型の指摘**として
 * 順に出てきた。メール (`maskEmailTokens`) と数字 (`DIGIT_RUN_PATTERN`) で
 * 列挙をやめたのと同じ理由で、URL も構造で判定する。
 *
 * - `/` `?` `#` のいずれか: authority の後ろに来る区切り。これが無ければ
 *   `請求書.pdf` や `v1.2.3` のような「ただのドット入り語」なので触らない。
 * - ドットかコロン: ホスト名・IP・スキームのいずれかが必ず持つ。これが無ければ
 *   `請求書/見積書` や `A4/横` のような和文の並記なので触らない。
 *
 * 代償は `10:30/11:00` のような時刻の範囲も落ちること。収録自体が §7.3 の
 * 例外なので、迷ったらマスクする側に倒す。
 */
const URL_TOKEN_PATTERN = /(?<![^\s])\S*[?#\x2F]\S*/gu;

/**
 * `www.` を含むトークン。パスもクエリもフラグメントも無い
 * `www.customer-name.example` は上の規則の区切り要件に当たらず素通りしていた
 * (PR #117 の Codex 指摘)。`www.` はホスト名であることの**曖昧さの無い印**なので、
 * 区切りを要求せずに落とせる（`請求書.pdf` のようなドット入り語とは区別できる）。
 */
const WWW_TOKEN_PATTERN = /(?<![^\s])\S*www\.\S*/giu;

/**
 * ドット入りホスト名 + ポート (`tenant.customer.example:8443`)。パスもクエリも
 * 無いと上の規則の区切り要件に当たらず、`www.` でも IP でもないので素通りして
 * いた (PR #117 の Codex 指摘)。
 *
 * `:` + 1〜5 桁の数字は authority の後ろにしか現れない**曖昧さの無い印**なので、
 * 区切りを要求せずに落とせる。時刻 (`10:30`) はコロンの前にドットが無いので
 * 当たらない。
 */
const HOST_PORT_PATTERN =
  /(?<![\p{L}\p{N}.@:-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+:\d{1,5}(?![\p{L}\p{N}:.-])/gu;

const shouldMaskUrlToken = (matched: string): boolean => /[.:]/.test(matched);

/**
 * 角括弧の IP リテラル (`[2001:db8::1]` / `[::ffff:10.0.0.1]:8443`)。
 * パスが無いと上の規則に当たらないので単体で落とす。角括弧は authority の
 * 明示的な区切りなので、**中身を列挙せず**トークンごと飲み込む
 * (`[fe80::1%25eth0]` のような zone id を途中で切らないため)。
 */
const BRACKETED_AUTHORITY_PATTERN = /(?<![^\s])\S*\[[^\]\s]*\]\S*/gu;

/**
 * 角括弧の無い IPv6 リテラル (`2001:db8::1`)。URL の一部でなくても記録され
 * うるので単体で落とす (セルフレビューで検出)。
 *
 * 時刻 (`10:30:45`) を巻き込まないよう、**`::` を含むか、コロンが 4 つ以上**の
 * ものだけをマスクする (判定は `shouldMaskColonGroup`)。IPv6 の完全形はコロン 7 個、
 * 省略形は必ず `::` を持つので、この 2 条件で実在の形は覆える。
 *
 * 末尾の IPv4 埋め込み (`::ffff:192.0.2.128`) と zone id (`fe80::1%25eth0`) も
 * 同じ 1 マッチで飲み込む。コロン部分だけ取ると `<url>.0.2.128` のように
 * **残りが漏れる** (PR #117 の Codex 指摘)。
 */
const COLON_GROUP_PATTERN =
  /(?<![\p{L}\p{N}:.-])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:\.\d{1,3}){0,3}(?:%[\p{L}\p{N}._-]+)?(?![\p{L}\p{N}:])/gu;

/**
 * 角括弧の無い IPv4 リテラル (`10.0.0.1`)。桁数が 7 未満だと数字の連なり側の
 * 閾値にも届かず素通りしていた (PR #117 の Codex 指摘)。IPv6 を単体で落として
 * いるのに IPv4 だけ URL の一部でないと落ちないのは非対称でもある。
 *
 * 直前・直後がラベル文字なら当てない (`v1.2.3.4` のようなバージョン表記を
 * 巻き込まないため)。ポートは任意で取り込む (`10.0.0.1:8080` で `:8080` だけ
 * 残さない)。
 */
const BARE_IPV4_PATTERN =
  /(?<![\p{L}\p{N}.@-])\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?![\p{L}\p{N}.-])/gu;

const IPV6_MIN_COLON_COUNT = 4;

const shouldMaskColonGroup = (matched: string): boolean =>
  matched.includes('::') ||
  (matched.match(/:/g)?.length ?? 0) >= IPV6_MIN_COLON_COUNT;

type TokenSpan = { start: number; end: number };

/**
 * 文字列をトークンへ切る。切れ目は「囲みの外側にある空白」で、囲みは
 * 引用符 (`"…"`) と括弧コメント (`(…)`)。括弧は深さを数えるので**入れ子も扱える**。
 * 囲みが閉じないまま終わったら、そこから末尾までが 1 トークン（安全側）。
 *
 * **この関数だけがトークンの定義を持つ。** マスク側と上限の境界側で別々に
 * 定義していた頃は、境界側（正規表現の「最後の空白」）が囲みの内側の空白で
 * 割れて `<url> john`（`john(comment here)@…` の前半）が残った
 * (PR #117 の Codex 指摘。同じ相互作用で 3 回)。
 */
const scanTokens = (text: string): TokenSpan[] => {
  const spans: TokenSpan[] = [];
  let tokenStart = -1;
  let parenDepth = 0;
  let inQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (inQuote || parenDepth > 0) {
      // 囲みの内側ではバックスラッシュが次の 1 文字を無効化する
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (inQuote) {
        if (char === '"') inQuote = false;
      } else if (char === '"') {
        inQuote = true;
      } else if (char === '(') {
        parenDepth += 1;
      } else if (char === ')') {
        parenDepth -= 1;
      }
      continue;
    }
    if (/\s/u.test(char)) {
      if (tokenStart >= 0) {
        spans.push({ start: tokenStart, end: index });
        tokenStart = -1;
      }
      continue;
    }
    if (tokenStart < 0) tokenStart = index;
    if (char === '"') inQuote = true;
    else if (char === '(') parenDepth += 1;
  }
  if (tokenStart >= 0) spans.push({ start: tokenStart, end: text.length });
  return spans;
};

/**
 * メールアドレス。**`@` を含むトークンを丸ごと `<email>` にする。**
 * トークンの定義は `scanTokens` が持つ。
 *
 * ここは元々 3 本の正規表現 (ASCII 限定 / 国際化 / フォールバック) で、PR #117 の
 * メール関連の指摘はすべて同じ型だった: www. ドメイン / RFC 記号入りローカル部 /
 * Unicode ローカル部 / Unicode TLD / ドット無しドメイン / `@` が 2 つ /
 * 精密パターンの部分一致 / 引用符内の空白 / 括弧コメント内の空白 / 括弧の入れ子。
 * 対応の取れた括弧は正規表現では数えられないので、走査へ移した。
 *
 * 代償は `@` を含むトークンに隣接した語まで消えること (`請求書a@b.co見積書` は
 * 丸ごと `<email>`。空白で区切られていれば前後は残る)。
 *
 * **URL より先に当てること。** 後に回すと `taro@www.example.com` で URL 側が
 * `www.example.com` を先に食い、`taro@<url>` となってローカル部が漏れる。
 */
/**
 * CFWS（括弧コメントと空白）を取り除いた残り。括弧は `scanTokens` と同じく
 * 深さを数え、バックスラッシュが次の 1 文字を無効化する。閉じないまま終わったら
 * 残り全部をコメント扱いにする。
 *
 * 判定を誤る方向は**常に「空と見なす」側**へ倒してある。空と見なせば隣を 1 つ
 * 余計に消すだけ（過剰マスク）だが、非空と見なすとローカル部やドメインがその場に
 * 残る（漏洩）。
 */
const stripCfws = (text: string): string => {
  let out = '';
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (depth > 0) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (/\s/u.test(char)) continue;
    out += char;
  }
  return out;
};

/**
 * そのトークンが**丸ごと CFWS か**。形（`(` で始まり `)` で終わる）で見ていた頃は
 * `(c).(c)` がコメント 1 個に見え、間のドット（dot-atom の繋ぎ目）ごと読み飛ばして
 * `example (c).(c) com` のドメインが残っていた（セルフレビューの総当たりで検出）。
 * 中身が空かどうかで判定すれば、形の見た目に依存しない。
 */
const isCommentToken = (token: string): boolean => stripCfws(token) === '';

/**
 * `@` を含むトークンから、**アドレスの一部として隣接するトークン**まで範囲を
 * 広げる。RFC 5322 は `@` の前後に CFWS（空白とコメント）を許すため、
 * `john (billing) @example.com` は空白で 3 つに割れ、`@` を含む最後の 1 つしか
 * 置換されず `john <email>` とローカル部が残っていた (PR #117 の Codex 指摘)。
 *
 * 判定は「トークンの端に `@` があるか」ではなく、**アドレスの構造**で行う。
 * ローカル部もドメインも dot-atom（ドットで繋いだ原子の並び）で、原子の間には
 * CFWS を挟める。つまり空白は区切りとは限らず、次の 2 つが「まだアドレスが
 * 続いている」印になる:
 *
 * 1. その側の本体が空（`john @example.com` の `@example.com`）
 * 2. 境界がドット（`john . doe@example.com` の `john` と `. doe`）
 *
 * 端の形で見ていた頃は `john (billing)@ example.com` が広がらず、本体の有無だけで
 * 見ていた頃は `john (billing) . doe@example.com` が広がらなかった
 * (PR #117 の Codex 指摘。この経路で 3 回)。どちらも「アドレスがどこまでか」を
 * 表面の形で近似していたのが原因なので、dot-atom の定義そのものを辿る。
 *
 * 代償は、直前の語がピリオドで終わるときに巻き込むこと（`Contact me. a@b.co`）。
 * RFC 上その形は実際に 1 つのローカル部になりうるので、**巻き込む側（過剰
 * マスク）へ倒す**。逆に倒すと本物のローカル部が残る。
 */
const isDotJoined = (left: string, right: string): boolean =>
  left.endsWith('.') || right.startsWith('.');

const expandAddressSpan = (
  tokens: string[],
  index: number,
): { from: number; to: number } => {
  const token = tokens[index] ?? '';
  let from = index;
  let to = index;
  const firstAt = token.indexOf('@');
  if (firstAt < 0) return { from, to };

  // 後方（ローカル部）。コメントトークンは CFWS なので読み飛ばす。
  let leftEdge = stripCfws(token.slice(0, firstAt));
  let cursor = index - 1;
  for (;;) {
    while (cursor >= 0 && isCommentToken(tokens[cursor] ?? '')) cursor -= 1;
    if (cursor < 0) break;
    const previous = stripCfws(tokens[cursor] ?? '');
    if (leftEdge !== '' && !isDotJoined(previous, leftEdge)) break;
    from = cursor;
    leftEdge = previous;
    cursor -= 1;
  }

  // 前方（ドメイン）。ドメインも dot-atom なので同じ規則が要る
  // （`john@example . com`）。指摘はローカル部だけだったが、鏡像を残すと
  // 同じ指摘がもう一度来る（実際 CFWS では鏡像が先に漏れていた）。
  let rightEdge = stripCfws(token.slice(token.lastIndexOf('@') + 1));
  cursor = index + 1;
  for (;;) {
    while (cursor < tokens.length && isCommentToken(tokens[cursor] ?? ''))
      cursor += 1;
    if (cursor >= tokens.length) break;
    const next = stripCfws(tokens[cursor] ?? '');
    if (rightEdge !== '' && !isDotJoined(rightEdge, next)) break;
    to = cursor;
    rightEdge = next;
    cursor += 1;
  }
  return { from, to };
};

/**
 * メールアドレス。**`@` を含むトークンを丸ごと `<email>` にする。**
 * トークンの定義は `scanTokens`、範囲の拡張は `expandAddressSpan` が持つ。
 *
 * ここは元々 3 本の正規表現 (ASCII 限定 / 国際化 / フォールバック) で、PR #117 の
 * メール関連の指摘はすべて同じ型だった: www. ドメイン / RFC 記号入りローカル部 /
 * Unicode ローカル部 / Unicode TLD / ドット無しドメイン / `@` が 2 つ /
 * 精密パターンの部分一致 / 引用符内の空白 / 括弧コメント内の空白 / 括弧の入れ子 /
 * `@` の前後に離れた CFWS。形を足すのをやめ、走査で扱えるようにしてある。
 *
 * 代償は `@` を含むトークンに隣接した語まで消えること (`請求書a@b.co見積書` は
 * 丸ごと `<email>`)。空白で区切られていれば前後は残る。
 *
 * **URL より先に当てること。** 後に回すと `taro@www.example.com` で URL 側が
 * `www.example.com` を先に食い、`taro@<url>` となってローカル部が漏れる。
 */
const maskEmailTokens = (text: string): string => {
  const spans = scanTokens(text);
  const tokens = spans.map(({ start, end }) => text.slice(start, end));

  // **範囲を先に全部確定させてから 1 回で出力する。** トークンを 1 つずつ出し
  // ながら広げると、`@` の付いたトークンへ着く頃には前のトークンが既に出力
  // 済みで、`送付 john (billing)<email>` のように前半が残る（セルフレビュー）。
  const ranges: { from: number; to: number }[] = [];
  tokens.forEach((token, index) => {
    if (!token.includes('@')) return;
    const range = expandAddressSpan(tokens, index);
    const previous = ranges[ranges.length - 1];
    if (previous !== undefined && range.from <= previous.to) {
      // `from` 側も畳む。後方への拡張は既存範囲の手前まで届きうるので
      // （`john (a@b) @example.com` のようにコメント自体が `@` を含む形）、
      // `to` だけ広げると先頭のトークンが取り残される（セルフレビュー）。
      previous.from = Math.min(previous.from, range.from);
      previous.to = Math.max(previous.to, range.to);
      return;
    }
    ranges.push(range);
  });

  let out = '';
  let cursor = 0;
  for (const { from, to } of ranges) {
    const startSpan = spans[from];
    const endSpan = spans[to];
    if (startSpan === undefined || endSpan === undefined) continue;
    if (startSpan.start < cursor) continue;
    out += text.slice(cursor, startSpan.start) + MASK_EMAIL;
    cursor = endSpan.end;
  }
  return out + text.slice(cursor);
};

/**
 * 数字と区切り記号からなる極大の連なり。**形ではなく桁数で判定する**。
 *
 * 以前は「6 桁以上の連続数字」「区切り数字 10 桁以上」「ハイフン電話」の 3 本を
 * 並べていたが、`+81-90-1234-5678` (パターン間で食い合う) → `4111 1111 1111 1111`
 * (どれにも当たらない) → `(03)123-4567` (括弧をまたげない) → `123-4567` (郵便番号)
 * と、**形を 1 つ足すたびに次の形が見つかる**指摘が続いた (PR #117 / #175 の
 * Codex 指摘)。連なりを 1 本で取り、桁数だけで判定すればこの往復は終わる。
 * パターンが 1 本なので、食い合いによる断片 (`+<num>-5678`) も原理的に起きない。
 */
// 先頭の `(` / `+` も取り込む (`(090) …` / `+81 …`)。取り込まないと数字だけ
// マスクされて記号が孤立して残る。
//
// **連なりの内側は「区切りに使われる記号」を列挙せず、文字でも数字でもないもの
// なら何でも繋ぎ目**と見なす。列挙していた頃は、列挙外を挟むだけで連なりが割れて
// どの断片も閾値に届かず素通りしていた —— `090‐1234‐5678`（U+2010 / ASCII の `-`
// しか見ていなかった）→ `０９０ー…`（U+30FC は `\p{Lm}`）→ `090:1234:5678`
// （コロン）と、**区切りを 1 つ足すたびに次の区切りが見つかる**指摘が 3 回続いた
// (PR #117 の Codex 指摘)。反転してあるので、未知の記号は「より多く繋げて
// マスクする」側へ倒れる。
//
// 文字 (`\p{L}`) と文字扱いの数 (`\p{N}`) は繋ぎ目にしない。跨いで繋ぐと
// `A4 横 2 段` のような語の並びが 1 つの番号になる。**例外は U+30FC 長音記号**
// （`０９０ー１２３４ー５６７８` と書く人がいる）。これは `\p{Lm}` すなわち文字に
// 分類されるが実際には区切りとして使われる。Unicode 側に手掛かりは無く
// （`\p{Dash}` にも `\p{Pd}` にも入らない。node 22 で実測）、名指しするしかない。
// 半角 U+FF70 は NFKC がここへ畳むので個別指定は要らない（同じく実測）。
//
// 例外がこの 1 文字で済むのは、列挙の向きを反転したから。漏れうるのは
// 「文字に分類されるのに区切りとして使われる文字」だけで、これは人間の言語に
// 由来する閉じた小集合。反転前は任意の記号（数千通り）が漏れ口だった。
//
// **連なりの定義はこの 1 つ。** 上限で切った末尾を落とす側
// (`TRAILING_DIGIT_RUN_PATTERN`) も同じ文字列から組み立てるので、片方だけ直して
// 食い違う余地が無い。
const DIGIT_RUN_INNER = String.raw`(?:[^\p{L}\p{N}]|\p{Nd}|\u30FC)`;

const DIGIT_RUN_PATTERN = new RegExp(
  String.raw`[(+]?\p{Nd}${DIGIT_RUN_INNER}*\p{Nd}`,
  'gu',
);

/** 6 桁以上の連続数字は無条件でマスクする (請求番号・顧客番号・口座番号)。 */
const CONSECUTIVE_DIGIT_PATTERN = /\p{Nd}{6,}/u;

/**
 * 空白を挟まない連なりの閾値。日本の郵便番号 `123-4567` (7 桁) が下限で、
 * 電話番号 (10〜11 桁)・カード番号 (13〜19 桁) はすべてこれを超える。
 * 副作用として `2026-08-14` のような日付 (8 桁) もマスクされるが、収録自体が
 * §7.3 の例外なので迷ったらマスクする側に倒す。西暦単体 (`請求書2026`) は残る。
 */
const DIGIT_MIN_COUNT_JOINED = 7;

/**
 * **空白だけ**で繋がれた連なりの閾値。空白は多くの表記で語の区切りなので、同じ
 * 桁数でも「1 つの数字列」である確度が下がる。閾値を分けることで
 * `4111 1111 1111 1111` (16 桁) は捕まえつつ `請求書 2026 2027` (8 桁) は残せる。
 */
const DIGIT_MIN_COUNT_SPACED = 10;

/**
 * 区切りが**空白だけ**か。閾値の分岐はここで決まる。
 *
 * 「空白を含むか」で分けていた頃は `123 - 4567`（区切りの前後に空白がある
 * 郵便番号）が空白側の閾値 10 に落ちて素通りしていた (PR #117 の Codex 指摘)。
 * 見るべきは空白の有無ではなく「数字どうしを繋いでいるものが空白だけか」で、
 * 記号が 1 つでも挟まっていればそれは 1 つの数字列。
 */
const isSpaceOnlySeparated = (matched: string): boolean =>
  !/[^\p{Nd}\s]/u.test(matched);

const shouldMaskDigitRun = (matched: string): boolean => {
  if (CONSECUTIVE_DIGIT_PATTERN.test(matched)) return true;
  const digitCount = matched.replace(/\P{Nd}/gu, '').length;
  return (
    digitCount >=
    (isSpaceOnlySeparated(matched)
      ? DIGIT_MIN_COUNT_SPACED
      : DIGIT_MIN_COUNT_JOINED)
  );
};

/**
 * マスクの直前・直後に**空白を挟まず**数字が残っていたら、それは前段のパターンが
 * 連なりの途中まで食べた断片。空白が無い＝同じトークンなので、丸ごとマスクへ
 * 畳む。
 *
 * 断片が出るのは「先に当たったパターンが連なりを途中で切る」ときで、原因になる
 * 入力は 1 つずつ潰しても次が出てくる（`+<num>-5678` は個別に直したが、
 * NFKC が `⩴` を `::=` へ畳むと IPv6 側が `090::` だけ食べて `=5678` が残る、
 * のように新しい経路が現れる。総当たり 4,626 文字中このパターンだけが残った）。
 * **どのパターンが切ったかに関係なく、断片という結果の側で塞ぐ。**
 *
 * 数字を含まない隣接文字は畳まない（`<num>です` の `です` は残す）。
 */
const MASK_ALTERNATION = `(?:${MASK_URL}|${MASK_EMAIL}|${MASK_NUMBER})`;
const ADJACENT_FRAGMENT_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`(${MASK_ALTERNATION})\S*\p{Nd}\S*`, 'gu'),
  new RegExp(String.raw`\S*\p{Nd}\S*?(${MASK_ALTERNATION})`, 'gu'),
];

const absorbAdjacentFragments = (text: string): string =>
  ADJACENT_FRAGMENT_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, '$1'),
    text,
  );

/** マスクで置き換えた結果。これらは「マスクが最後まで飲み込んだ」印。 */
const MASK_PLACEHOLDERS: ReadonlySet<string> = new Set([
  MASK_URL,
  MASK_EMAIL,
  MASK_NUMBER,
]);

/**
 * 入力を上限で切ったときに、**途中で切れた末尾トークンを捨てる**。
 *
 * 単位は「空白区切りのトークン」で、メール・URL の規則と同じ。区切りを記号で
 * 定義しようとした版は、列挙しても反転しても破れた:
 * 記号を区切りにすると `…,victim@exampl` の断片が残り、トークン文字側を列挙して
 * 反転すると今度は**トークンの内側の記号**（`secret$victim@exampl` の `$`）で
 * 切れて `secret$` が残る (PR #117 の Codex 指摘 4 回)。記号がどちら側に属するかを
 * 判定しようとする限り、境界は必ずどこかで割れる。
 *
 * 空白なら割れない。空白はトークンの内側に現れない（引用符つきローカル部だけが
 * 例外で、それは `maskEmailTokens` が先に潰している）。
 *
 * 例外は末尾がマスクの置換結果そのものだったとき。`<url>` はマスクが最後まで
 * 飲み込んだ印なので、そのまま残す（長い URL 1 本の入力が丸ごと消えない）。
 *
 * 空白が 1 つも無い入力は全部捨てる。1000 文字を超える分かち書きの無い和文が
 * 消えるが、その長さの検索語は需要シグナルとして意味を持たないので、**断片を
 * 残す危険と引き換えにしない**。捨てたことは `truncated` が示す。
 */
/**
 * 末尾に残った数字の連なりを捨てる。**空白は数字の連なりの区切りではない**ため、
 * 空白トークン単位で捨てるだけでは足りない。
 *
 * `'https://' + 'a'.repeat(982) + ' 4111 1111 1111 1111'` は上限で
 * `<url> 4111 111` になり、7 桁では空白区切りの閾値 10 に届かずマスクされない。
 * 末尾の 1 語だけ捨てても `<url> 4111` が残る (PR #117 の Codex 指摘)。
 * 連なりは `DIGIT_RUN_PATTERN` と同じ区切り集合で末尾まで一続きに捨てる。
 */
const TRAILING_DIGIT_RUN_PATTERN = new RegExp(
  String.raw`[(+]?\p{Nd}${DIGIT_RUN_INNER}*$`,
  'u',
);

const dropIncompleteTrailingToken = (text: string): string => {
  // 数字の連なりは空白をまたぐので、トークンとは別に先に落とす
  const withoutDigits = text.replace(TRAILING_DIGIT_RUN_PATTERN, '').trimEnd();
  const spans = scanTokens(withoutDigits);
  const last = spans[spans.length - 1];
  if (last === undefined) return withoutDigits;
  const tail = withoutDigits.slice(last.start, last.end);
  // 末尾がマスクの置換結果なら「マスクが最後まで飲み込んだ」印なので残す
  if (MASK_PLACEHOLDERS.has(tail)) return withoutDigits;
  return withoutDigits.slice(0, last.start).trimEnd();
};

export type NormalizedText = {
  value: string;
  /** `maxLength` を超えて切り詰めたか。 */
  truncated: boolean;
  /** PII 形状マスクが 1 箇所でも当たったか。 */
  masked: boolean;
};

export type NormalizeOptions = {
  /**
   * PII 形状マスクを当てるか (既定 true)。
   *
   * **サーバー生成 slug には false を渡す。** 実在の slug がたまたま 6 桁以上の
   * 連続数字を含むと `<num>` に書き換わり、**その slug は復元できなくなる**
   * (ギャラリーのデータへ突き合わせられず、別の slug と衝突もしうる)。
   * 16 文字の Base62 は構造上メールアドレスにも URL にもなり得ないので、
   * 契約に合致した値だけマスクを外すのは安全 (developer-docs PR #175 の
   * Codex 指摘)。契約から外れた値 (AI が渡した任意の文字列) には当てる。
   */
  mask?: boolean;
  /**
   * 大小文字を畳むか (既定 true)。
   *
   * **slug には false を渡す。** slug は `shortId()` が作る大小文字混在の不透明な
   * 識別子 (例: `0eLHZZ8PxpU4Z5r7`) で、畳むと実在のテンプレート ID と違う値が
   * 記録され、ギャラリーのデータへ厳密に突き合わせられなくなる。大小文字だけが
   * 違う 2 つの slug が同一視される問題も起きる (developer-docs PR #175 の
   * Codex 指摘)。自由記述の query / category は、表記ゆれを畳んで同じキーワードを
   * まとめたいので true のまま。
   */
  lowercase?: boolean;
};

/**
 * テレメトリへ載せる文字列を正規化する。**検索の挙動には一切使わない**
 * (検索側の `trim().toLowerCase()` は据え置き。ST2 の Won't「検索アルゴリズムの
 * 変更」に触れないため)。
 *
 * 手順は マスク → 切り詰め の順。逆にすると、切れたメールアドレスの前半だけが
 * マスクを免れて残る。
 */
export const normalizeForTelemetry = (
  raw: string,
  maxLength: number,
  { lowercase = true, mask = true }: NormalizeOptions = {},
): NormalizedText => {
  // 正規表現を掛ける前に必ず切る (REGEX_INPUT_MAX_LENGTH のコメント参照)。
  // ここで切らないと、認証不要の検索ツール経由でイベントループを数秒止められる。
  // 出力上限の 10 倍を残すので、最終的に残る範囲の PII トークンは完全な形で見える。
  const overLimit = raw.length > REGEX_INPUT_MAX_LENGTH;
  const bounded = raw.slice(0, REGEX_INPUT_MAX_LENGTH);

  // NFKC で全角英数字・半角カナを畳む。「請求書１」と「請求書1」が別キーワードとして
  // ランキングに並ぶのを防ぎ、同時に全角で書かれた数字をマスク対象に乗せる。
  // NFKC の後に**不可視の書式文字を落とす**。U+200B (ZWSP) / U+FEFF (BOM) /
  // U+00AD (soft hyphen) / U+2060 (word joiner) / bidi 制御は NFKC が残すため、
  // `090<ZWSP>1234<ZWSP>5678` のように挟むだけで数字の連なりが 3 つに割れ、
  // どれも閾値に届かず素通りする (PR #117 の Codex 指摘)。
  // 個別に列挙せず Unicode の**性質**ごと落とす —— 見た目に現れない文字は
  // 検索語としての意味も持たないので、落として困らない。
  //
  // 種別 (`\p{Cf}`) だけでは足りない。U+034F (COMBINING GRAPHEME JOINER) や
  // U+FE0F (VARIATION SELECTOR-16) は Mn なので `\p{Cf}` に入らず、
  // `090<CGJ>1234<CGJ>5678` が 3/4/4 桁に割れて閾値に届かない
  // (PR #117 の Codex 指摘。ZWSP に続いて 2 回目)。「不可視かどうか」を直接表す
  // Default_Ignorable_Code_Point で取る。
  //
  // 両方要る。この 2 つは包含関係にない —— U+0600 (ARABIC NUMBER SIGN) は
  // Cf だが default-ignorable ではなく、逆に上記 2 文字は default-ignorable だが
  // Cf ではない（node 22 で実測）。
  const normalized = bounded
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
  const collapsed = (lowercase ? normalized.toLowerCase() : normalized)
    .replace(/\s+/g, ' ')
    .trim();

  // 順序が仕様。メール → URL → IPv6 → 数字。メールを先に置かないと
  // `taro@www.example.com` の `www.example.com` を URL 側が先に食い、
  // ローカル部が `taro@<url>` として残る (各パターンのコメント参照)。
  const maskedText = mask
    ? collapsed
        .replace(/^[\s\S]*$/u, maskEmailTokens)
        .replace(BRACKETED_AUTHORITY_PATTERN, MASK_URL)
        .replace(WWW_TOKEN_PATTERN, MASK_URL)
        .replace(URL_TOKEN_PATTERN, (matched) =>
          shouldMaskUrlToken(matched) ? MASK_URL : matched,
        )
        // ホスト + ポートは**トークン単位ではなく部分一致**なので、パス付きの
        // URL より後に当てる。先に当てると `example.com:8443/customers/taro` の
        // ホスト部だけ食って `<url>/customers/taro` とパスが残る（セルフレビュー）
        .replace(HOST_PORT_PATTERN, MASK_URL)
        // IPv6 を先に。逆にすると `::ffff:192.0.2.128` の IPv4 部分を先に
        // 食われ、1 つのアドレスが `<url><url>` に割れる（セルフレビュー）。
        .replace(COLON_GROUP_PATTERN, (matched) =>
          shouldMaskColonGroup(matched) ? MASK_URL : matched,
        )
        .replace(BARE_IPV4_PATTERN, MASK_URL)
        .replace(DIGIT_RUN_PATTERN, (matched) =>
          shouldMaskDigitRun(matched) ? MASK_NUMBER : matched,
        )
        // 最後に、前段が連なりを切って残した断片を畳む（上のコメント参照）
        .replace(/^[\s\S]*$/u, absorbAdjacentFragments)
    : collapsed;

  // 上限で切った入力は末尾トークンが途中で切れている可能性がある。マスク**後**に
  // 落とすのは、`<url>` のように置換で短くなった結果を壊さないため
  // (マスク前に切ると、1000 文字の URL 1 本の入力が丸ごと消える)。
  const bodyText = overLimit
    ? dropIncompleteTrailingToken(maskedText)
    : maskedText;

  // 絵文字・異体字を途中で割ると孤立サロゲートが残るのでコードポイント単位で切る。
  const chars = Array.from(bodyText);
  // 入力が上限で切られていたら、出力が短くても「切り詰めた」と申告する。
  // ここを出力長だけで決めると、長い URL が `<url>` に縮んだときに
  // 「捨てた入力があるのに truncated: false」になる (PR #117 の Codex 指摘)。
  const truncated = chars.length > maxLength || overLimit;

  return {
    value:
      chars.length > maxLength ? chars.slice(0, maxLength).join('') : bodyText,
    truncated,
    // 末尾トークンの破棄はマスクではないので、判定はマスク直後の値で行う。
    masked: maskedText !== collapsed,
  };
};

// --------------------------------------------------------------------------
// イベント payload
// --------------------------------------------------------------------------

/**
 * 検索 1 回分の観測値。
 *
 * 成功時にしか件数を持てない形にしてあるのは意図的。失敗時に
 * `matchedCount: 0` を送ると、**本当に 0 件だった検索 (= 未充足需要。この計測の
 * 主目的)** と **ギャラリー API に到達できなかった検索** が集計上まったく
 * 区別できなくなる。型で混同を防ぐ。
 */
export type GallerySearchObservation =
  | {
      success: true;
      query: string;
      category?: string;
      matchedCount: number;
      scannedCount: number;
      totalPublished: number;
      /**
       * 走査を最後まで進められなかったか。**`matchedCount: 0` を「未充足需要」と
       * 読んでよいのは、これが無い行だけ。** 打ち切った走査の 0 件は「無かった」
       * ではなく「見ていない」で、集計上まったく別物になる。
       *
       * 打ち切りの理由は複数ある (走査上限 / カーソルが契約外 / ページの切り詰め /
       * サーバーが終了を宣言したのに未走査が残る) が、**下流に要るのは理由では
       * なく「この行の 0 件を需要として数えてよいか」**なので 1 つの旗にまとめる。
       * 理由ごとにキーを増やすと、増えるたびに集計側の除外条件が増える。
       */
      scanIncomplete?: true;
      errorClass?: never;
    }
  | {
      success: false;
      query: string;
      category?: string;
      /** JS のエラークラス名。`HttpError` (API がエラー応答) と未到達を分ける。 */
      errorClass: string;
      // `?: never` が要るのは、ユニオンの余剰プロパティ検査が「どれか 1 つの構成要素に
      // 存在するキー」を通してしまうため。これが無いと
      // `{ success: false, matchedCount: 0 }` がコンパイルを通り、型で防いだつもりの
      // 混同がそのまま起きる (report-flow-core PR #176 の Codex 指摘)。
      matchedCount?: never;
      scannedCount?: never;
      totalPublished?: never;
      /** 失敗行には件数が無いので、走査の完全性も意味を持たない。 */
      scanIncomplete?: never;
    };

/**
 * 複製 1 回分の観測値。slug はサーバー生成 ID だが、AI が任意の値を渡せるため正規化する。
 *
 * 成功・失敗でユニオンにしてあるのは検索側と同じ理由で、**型として書けない状態を
 * 作る**ため。失敗に `workspaceId` は付かず、成功に `outcomeUnknown` は付かない。
 */
export type GalleryCopyObservation =
  | {
      slug: string;
      success: true;
      /**
       * 複製先ワークスペース。**成功時のみ**渡す。
       *
       * 検索と違い、複製の成功は「上流 API が Bearer を受理して実際に書き込んだ」
       * ことを意味するので、`withTelemetry` が成功時だけ workspace を付ける根拠
       * (PRJ-3-1117) がそのまま当てはまる。値は複製 API の応答が返した workspaceId を
       * 使う — 未検証の JWT claim ではなくサーバーが確定させた値。
       */
      workspaceId?: string;
      /** 成功時は実在確認を必ず通っているので、指定しなくても免除される。 */
      slugVerified?: true;
      // ユニオンの余剰プロパティ検査は「どれか 1 つの構成要素に存在するキー」を
      // 通すので、`?: never` が無いと成功側に outcomeUnknown を書けてしまう
      // (検索側と同じ理由。report-flow-core PR #176 の Codex 指摘)。
      outcomeUnknown?: never;
    }
  | {
      slug: string;
      success: false;
      workspaceId?: never;
      /**
       * `getGalleryTemplateBySlug()` が成功した後の失敗か。
       *
       * 複製 POST が失敗しても slug の実在は証明済みなので、マスク・正規化・
       * 切り詰めを免除する。免除の根拠は「API が実在を認めたか」であって
       * 「複製が成立したか」ではない (developer-docs PR #175 の Codex 指摘)。
       */
      slugVerified?: boolean;
      /**
       * 複製が完了したか**判定できない**失敗か (タイムアウト / 応答が JSON でない /
       * 接続自体の失敗)。サーバー側では書き込みが完了している可能性がある。
       *
       * これを持たずに失敗として記録すると、実際には完了した複製が
       * 「検索 → 複製の転換」の分子から消え、失敗件数だけが増える
       * (PR #117 の Codex 指摘)。集計側 (report-flow `gallery-demand.mjs`) は
       * この行をランキングにも失敗件数にも入れず、独立した件数として出す。
       */
      outcomeUnknown?: boolean;
    };

/**
 * その検索を需要として記録してよいか。**判定は生の入力ではなく、実際に記録される
 * 値で行う。**
 *
 * キーワードの無い呼び出しを除くために `query.trim() !== ''` を見ていたが、
 * 正規化が消す文字だけで出来た query（U+200B のみ等）は trim では残るので通り抜け、
 * `query: ''` の 0 件ヒット行が未充足需要として積まれていた (PR #117 の Codex 指摘)。
 * 上限で切った末尾トークンを落とした結果が空になる場合も同じ。
 *
 * `buildGallerySearchedProperties` と**同じ呼び出し**で値を作るので、正規化の
 * 仕様が変わっても判定と記録がずれない。生の入力を別の式で近似すると、その差が
 * そのまま抜け道になる。
 */
export const isQueryRecordable = (raw: string): boolean =>
  normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value !== '';

export const buildGallerySearchedProperties = (
  observation: GallerySearchObservation,
): TelemetryProperties => {
  const query = normalizeForTelemetry(observation.query, QUERY_MAX_LENGTH);
  const category =
    observation.category === undefined
      ? undefined
      : normalizeForTelemetry(observation.category, CODE_MAX_LENGTH);

  return {
    query: query.value,
    // false は送らない。既定 (キー無し) が「切り詰めていない / マスクしていない」で、
    // 全行に false を載せると 4096 byte の properties 上限を無駄に食う。
    ...(query.truncated ? { queryTruncated: true } : {}),
    ...(query.masked ? { queryMasked: true } : {}),
    // category も自由記述 (z.string()) なので query と同じ扱い。フラグを出さないと、
    // マスク済みの値と字面どおりの category 値が区別できず、同じ接頭辞の長い
    // category が切り詰めで併合されたことも見えない (PR #175 の Codex 指摘)。
    ...(category === undefined ? {} : { category: category.value }),
    ...(category?.truncated ? { categoryTruncated: true } : {}),
    ...(category?.masked ? { categoryMasked: true } : {}),
    success: observation.success,
    ...(observation.success
      ? {
          matchedCount: observation.matchedCount,
          scannedCount: observation.scannedCount,
          totalPublished: observation.totalPublished,
          // 他のフラグと同じく true のときだけ載せる (既定 = キー無し = 完走)
          ...(observation.scanIncomplete ? { scanIncomplete: true } : {}),
        }
      : { errorClass: observation.errorClass }),
  };
};

/**
 * 実在確認済み slug を**そのまま**返す。加工しない理由は呼び出し側のコメント参照。
 *
 * 上限を超えたときは**切り詰めずに省く**（`null` を返す）。切り詰めた値は
 * 「正確な識別子に見えるのに実物と違う」ため、接頭辞が同じ別テンプレートの
 * 複製と**静かに併合される**。省けば下流からは「この行に slug が無い」と見え、
 * 誤った完全一致を作らない (developer-docs PR #175 の Codex 指摘)。
 */
const boundVerifiedSlug = (raw: string): NormalizedText | null =>
  Array.from(raw).length > VERIFIED_SLUG_MAX_LENGTH
    ? null
    : { value: raw, truncated: false, masked: false };

export const buildGalleryCopiedProperties = (
  observation: GalleryCopyObservation,
): TelemetryProperties => {
  // マスクを外すのは「ギャラリー API が実在すると認めた slug」だけにする。
  //
  // 判定は **`success === true` だけ**。`handleCopyGalleryTemplate` は複製前に
  // `getGalleryTemplateBySlug()` で slug の実在を確認し、無ければそこで
  // `GalleryTemplateNotFoundError` を返して複製に進まない。つまり成功した
  // 呼び出しの slug は必ずギャラリーに存在した公開識別子で、PII ではない。
  //
  // **形の検査を併用しない。** 以前は「二重の歯止め」として英数字 16〜17 文字 /
  // 26 文字を要求していたが、これは観測できた 2 系統を契約に固めただけだった。
  // 公開ギャラリー API の契約 (developer-docs `openapi/coze-plugin-gallery.yaml`)
  // では `slug` は pattern 無しの `type: string` で、例に挙がっているのは
  // `simple-invoice` というハイフン区切りの人間可読形。この形の実在 slug が
  // 6 桁以上の連続数字を含むと `<num>` へ書き換わり、**API が実在を認めた値なのに
  // ギャラリーへ突き合わせられなくなる**（別の slug と併合もしうる）
  // (developer-docs PR #175 の Codex 指摘)。形を足しても守れるものは無く、
  // 実在の slug を落とす副作用しかない。
  //
  // 判定は「**API が実在を認めたか**」であって「複製が成立したか」ではない。
  // 複製 POST がタイムアウト / 5xx で失敗しても、step 2 の
  // `getGalleryTemplateBySlug()` を通っていれば slug は公開識別子と証明済みで、
  // そこを加工すると**どのテンプレートの転換が取りこぼされたのか追えなくなる**
  // (developer-docs PR #175 の Codex 指摘)。
  // 実在確認を通っていない失敗（slug が存在しない・認証エラー等）の値は AI が
  // 渡した任意の文字列でありうるので、従来どおりマスクする。
  const isVerifiedServerSlug =
    observation.success || observation.slugVerified === true;

  // slug は大小文字を畳まない (NormalizeOptions.lowercase のコメント参照)。
  // 検証済み slug は**一切加工しない**。NFKC 正規化・空白の畳み込み・trim・
  // lowercase・マスクのどれを掛けても、API が受理した識別子とは違う値が記録され、
  // ギャラリーへの完全一致が壊れる（別 slug との併合も起こりうる）。
  // API 契約は `slug` の中身を縛っていないので、互換 Unicode や前後空白を含む
  // slug が実在しない保証は無い (developer-docs PR #175 の Codex 指摘)。
  // 唯一の加工は properties の 4096 byte 上限を守るための長さの上限。
  const slug = isVerifiedServerSlug
    ? boundVerifiedSlug(observation.slug)
    : normalizeForTelemetry(observation.slug, CODE_MAX_LENGTH, {
        lowercase: false,
        mask: true,
      });
  return {
    // 省いたときは slug キーごと出さず、省いた事実をフラグで残す。
    ...(slug === null
      ? { slugOmitted: true }
      : {
          slug: slug.value,
          ...(slug.truncated ? { slugTruncated: true } : {}),
          ...(slug.masked ? { slugMasked: true } : {}),
        }),
    success: observation.success,
    // false は送らない (既定 = 失敗が確定している)。他のフラグと同じ扱い。
    ...(observation.success === false && observation.outcomeUnknown === true
      ? { outcomeUnknown: true }
      : {}),
  };
};

// --------------------------------------------------------------------------
// 送信
// --------------------------------------------------------------------------

/**
 * `track` は fire-and-forget (client.ts) だが、payload 組み立てで throw する
 * 余地を残さないためここでも握る。計測の失敗でツール応答を壊さない。
 */
const trackSafely = (
  client: TelemetryClient,
  event: string,
  buildProperties: () => TelemetryProperties,
  workspaceId?: string,
): void => {
  try {
    client.track({
      event,
      timestamp: Date.now(),
      // 空文字は渡さない (collector は未設定と同じ空文字を blob3 に書くので、
      // 意味は同じだが「付けた」と誤読される)。
      ...(workspaceId ? { workspaceId } : {}),
      properties: buildProperties(),
    });
  } catch {
    // 意図的に無視する (計測は応答に影響させない)
  }
};

export const trackGallerySearched = (
  client: TelemetryClient,
  observation: GallerySearchObservation,
): void =>
  trackSafely(client, GALLERY_SEARCHED_EVENT, () =>
    buildGallerySearchedProperties(observation),
  );

export const trackGalleryCopied = (
  client: TelemetryClient,
  observation: GalleryCopyObservation,
): void =>
  trackSafely(
    client,
    GALLERY_COPIED_EVENT,
    () => buildGalleryCopiedProperties(observation),
    // 成功した複製にだけ帰属を付ける。失敗時に付けると、書き込みが起きていない
    // 呼び出しを任意のワークスペース宛に注入できてしまう (interceptor と同じ判断)。
    observation.success ? observation.workspaceId : undefined,
  );
