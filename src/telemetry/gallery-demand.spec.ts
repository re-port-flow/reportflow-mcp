import type { TelemetryClient, TelemetryEvent } from './client';
import type { GalleryCopyObservation } from './gallery-demand';
import {
  buildGalleryCopiedProperties,
  buildGallerySearchedProperties,
  CODE_MAX_LENGTH,
  GALLERY_COPIED_EVENT,
  GALLERY_SEARCHED_EVENT,
  normalizeForTelemetry,
  QUERY_MAX_LENGTH,
  trackGalleryCopied,
  trackGallerySearched,
} from './gallery-demand';

class RecordingClient implements TelemetryClient {
  events: TelemetryEvent[] = [];
  track(event: TelemetryEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
}

describe('イベント名', () => {
  // ae-query.sh の validate_event_name と event-telemetry-schema.md §2 の両方が
  // アンダースコアを弾く。名前を変えるとどちらも静かに壊れるので固定する。
  const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

  it('ae-query.sh の validate_event_name と同じ文字集合に収まる', () => {
    expect(GALLERY_SEARCHED_EVENT).toMatch(EVENT_NAME_PATTERN);
    expect(GALLERY_COPIED_EVENT).toMatch(EVENT_NAME_PATTERN);
  });

  it('既存の integration.mcp.invoked とは別名である', () => {
    expect(GALLERY_SEARCHED_EVENT).not.toBe('integration.mcp.invoked');
    expect(GALLERY_COPIED_EVENT).not.toBe('integration.mcp.invoked');
  });
});

describe('normalizeForTelemetry', () => {
  it('trim / lowercase / 空白の畳み込みを行う', () => {
    expect(normalizeForTelemetry('  Invoice  ', QUERY_MAX_LENGTH).value).toBe(
      'invoice',
    );
    expect(
      normalizeForTelemetry('請求書   テンプレート', QUERY_MAX_LENGTH).value,
    ).toBe('請求書 テンプレート');
  });

  it('全角英数字を NFKC で畳んで同じキーワードに寄せる', () => {
    expect(normalizeForTelemetry('請求書１', QUERY_MAX_LENGTH).value).toBe(
      '請求書1',
    );
    expect(
      normalizeForTelemetry('ＩＮＶＯＩＣＥ', QUERY_MAX_LENGTH).value,
    ).toBe('invoice');
  });

  it('全角スペース区切りも半角スペース 1 個に畳む', () => {
    expect(
      normalizeForTelemetry('請求書　テンプレート', QUERY_MAX_LENGTH).value,
    ).toBe('請求書 テンプレート');
  });

  it('マスクが当たらなければ masked=false', () => {
    const result = normalizeForTelemetry('請求書', QUERY_MAX_LENGTH);
    expect(result.masked).toBe(false);
    expect(result.truncated).toBe(false);
  });

  describe('PII 形状マスク', () => {
    it('メールアドレスをマスクし、前後の帳票名は残す', () => {
      const result = normalizeForTelemetry(
        '請求書 taro.yamada@example.co.jp 送付用',
        QUERY_MAX_LENGTH,
      );
      expect(result.value).toBe('請求書 <email> 送付用');
      expect(result.masked).toBe(true);
    });

    // 【仕様変更 / PR #117】期待値を `請求書<email>見積書` から `<email>` に変更した。
    // 旧仕様は「ASCII 限定パターンで住所だけを精密に抜き、前後の帳票名を残す」
    // だったが、その構造自体が漏洩経路だった: `山田abc@example.com` に ASCII
    // パターンを先に当てると `abc@example.com` だけが置換され `山田<email>` と
    // なり、**ローカル部の一部が残る**（Codex 指摘）。精密パターンを先に当てる
    // 限りこの部分一致は防げないため、`@` を含むトークンは丸ごと落とす仕様に変えた。
    // 空白で区切られていれば前後は残る（下の「メールアドレスをマスクし…」参照）。
    it('空白の無いトークンに @ があればトークンごとマスクする', () => {
      expect(
        normalizeForTelemetry('請求書a@b.co見積書', QUERY_MAX_LENGTH).value,
      ).toBe('<email>');
    });

    it('Unicode ローカル部に ASCII が続くアドレスも丸ごとマスクする', () => {
      // 旧仕様ではここが `山田<email>` になりローカル部が漏れていた（Codex 指摘）
      expect(
        normalizeForTelemetry('山田abc@example.com', QUERY_MAX_LENGTH).value,
      ).toBe('<email>');
    });

    it('URL をマスクし、後続の日本語は残す', () => {
      const result = normalizeForTelemetry(
        'https://example.com/a?b=1 請求書',
        QUERY_MAX_LENGTH,
      );
      expect(result.value).toBe('<url> 請求書');
    });

    it('ハイフン区切りの電話番号をマスクする', () => {
      expect(
        normalizeForTelemetry('見積書 090-1234-5678', QUERY_MAX_LENGTH).value,
      ).toBe('見積書 <num>');
      expect(
        normalizeForTelemetry('03-1234-5678 請求書', QUERY_MAX_LENGTH).value,
      ).toBe('<num> 請求書');
    });

    it('全角数字の電話番号も NFKC 後にマスクされる', () => {
      expect(
        normalizeForTelemetry('０９０－１２３４－５６７８', QUERY_MAX_LENGTH)
          .value,
      ).toBe('<num>');
    });

    it('6 桁以上の連続数字をマスクする', () => {
      expect(
        normalizeForTelemetry('請求書 1234567', QUERY_MAX_LENGTH).value,
      ).toBe('請求書 <num>');
    });

    it('空白区切りのカード番号をマスクする', () => {
      // 連続数字は最大 4 桁なので、6 桁連続にもハイフン区切り電話にも当たらない
      const result = normalizeForTelemetry(
        '請求書 4111 1111 1111 1111',
        QUERY_MAX_LENGTH,
      );
      expect(result.value).toBe('請求書 <num>');
      expect(result.masked).toBe(true);
    });

    it('括弧つきの電話番号をマスクする', () => {
      expect(
        normalizeForTelemetry('(090) 1234 5678 見積書', QUERY_MAX_LENGTH).value,
      ).toBe('<num> 見積書');
    });

    it('西暦を 2 つ並べた程度（8 桁）は残す', () => {
      const result = normalizeForTelemetry(
        '請求書 2026 2027',
        QUERY_MAX_LENGTH,
      );
      expect(result.value).toBe('請求書 2026 2027');
      expect(result.masked).toBe(false);
    });

    // 以下は PR #117 の Codex 指摘。いずれも「マスク済みと記録しながら PII の
    // 一部が残る」型で、パターンの順序と網羅範囲の問題。

    it('ドメインが www. で始まるメールでもローカル部を漏らさない', () => {
      // URL を先に当てると www.example.com が先に食われ `taro@<url>` になる
      expect(
        normalizeForTelemetry('taro@www.example.com', QUERY_MAX_LENGTH).value,
      ).toBe('<email>');
    });

    it('国番号つきの電話番号を丸ごとマスクする', () => {
      // ハイフン電話を先に当てると 81-90-1234 だけ食われ `+<num>-5678` が残る
      expect(
        normalizeForTelemetry('+81-90-1234-5678', QUERY_MAX_LENGTH).value,
      ).toBe('<num>');
    });

    it('非 ASCII のパスを持つ URL を丸ごとマスクする', () => {
      // ASCII だけを続きとして取ると `<url>山田` になりパスが漏れる
      expect(
        normalizeForTelemetry(
          'https://example.com/customers/山田',
          QUERY_MAX_LENGTH,
        ).value,
      ).toBe('<url>');
    });

    it('スキーム無しの URL もマスクする', () => {
      expect(
        normalizeForTelemetry('example.com/customers/taro', QUERY_MAX_LENGTH)
          .value,
      ).toBe('<url>');
    });

    it('ドット入りでもパスが無ければマスクしない', () => {
      // `請求書.pdf` や `v1.2.3` を URL と誤認しない
      const result = normalizeForTelemetry(
        '請求書.pdf v1.2.3',
        QUERY_MAX_LENGTH,
      );
      expect(result.value).toBe('請求書.pdf v1.2.3');
      expect(result.masked).toBe(false);
    });

    it('IP リテラル・punycode TLD の URL もマスクする', () => {
      // TLD を ASCII 英字だけに限っていたため素通りしていた（PR #117 の Codex 指摘）
      expect(
        normalizeForTelemetry('192.168.1.1/customers/taro', QUERY_MAX_LENGTH)
          .value,
      ).toBe('<url>');
      expect(
        normalizeForTelemetry(
          'example.xn--p1ai/customers/taro',
          QUERY_MAX_LENGTH,
        ).value,
      ).toBe('<url>');
    });

    it('括弧つき市外局番の短い電話番号をマスクする', () => {
      // (03)123-4567 は 9 桁なので区切り数字の閾値に届かず、
      // ハイフン電話パターンも括弧をまたげず素通りしていた
      expect(
        normalizeForTelemetry('(03)123-4567 請求書', QUERY_MAX_LENGTH).value,
      ).toBe('<num> 請求書');
    });

    it('句読点で区切られた PII が上限で切れて残らない', () => {
      // 空白だけを境界にしていたため `<num>,victim@example` が残っていた
      const raw = `${'1'.repeat(985)},victim@example.com`;
      const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(result.value).not.toContain('victim');
      expect(result.value).not.toContain('@');
    });

    it.each(['|', '/', '・', '—', '＄', ' '])(
      '区切りが %s でも上限で切れた PII が残らない',
      (separator) => {
        // 区切り側を列挙していたため、列挙外の記号で `<num>|victim@example` が
        // 残っていた（PR #117 の Codex 指摘）。トークン文字側の列挙に反転し、
        // 列挙漏れが「より多く捨てる」方向に倒れるようにした
        const raw = `${'1'.repeat(985)}${separator}victim@example.com`;
        const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
        expect(result.value).not.toContain('victim');
        expect(result.value).not.toContain('@');
      },
    );

    it.each([
      ['エスケープされた引用符', '送付 "John \\"Q\\" Doe"@example.com 請求書'],
      ['引用符内の @', '送付 "a@b"@example.com 請求書'],
      [
        '括弧のコメント（空白入り）',
        '送付 john(comment here)@example.com 請求書',
      ],
      ['ドメイン側のコメント', '送付 john@(comment here)example.com 請求書'],
      [
        '入れ子の括弧コメント',
        '送付 john(comment (nested) here)@example.com 請求書',
      ],
      ['3 重の入れ子', '送付 john(a(b(c)d)e)@example.com 請求書'],
      ['@ の前に離れたコメント', '送付 john (billing) @example.com 請求書'],
      ['@ の前に空白のみ', '送付 john @example.com 請求書'],
      ['@ の後に離れたコメント', '送付 john@ (c) example.com 請求書'],
      ['コメントが 2 つ', '送付 john (a) (b) @example.com 請求書'],
      // `@` がトークンの端に無く、CFWS だけを挟んで本体が隣のトークンにある形。
      // 端で判定していた頃は「`@` で始まらない」ため後方へ広がらず、
      // `送付 john <email> 請求書` とローカル部が残っていた（PR #117 の Codex 指摘）。
      [
        'コメントが @ に付いた（前）',
        '送付 john (billing)@ example.com 請求書',
      ],
      // その鏡像。こちらは指摘に無かったが同じ経路で**ドメイン**が残っていた
      // （総当たり 49,159 件中 10,179 件が漏洩。セルフレビューで検出）
      [
        'コメントが @ に付いた（後）',
        '送付 john @(billing) example.com 請求書',
      ],
      ['@ の両側がコメント', '送付 john (a)@(b) example.com 請求書'],
      ['CFWS が両側に離れている', '送付 john (a) @ (b) example.com 請求書'],
      // ローカル部・ドメインは dot-atom で、原子の間には CFWS を挟める。
      // 本体の有無だけで見ていた頃は `doe` が本体として在るので後方へ広がらず、
      // `送付 john (billing) . <email> 請求書` とローカル部が残っていた
      // （PR #117 の Codex 指摘）
      ['ドット区切りのローカル部', '送付 john . doe@example.com 請求書'],
      [
        'ドット区切り＋コメント',
        '送付 john (billing) . doe@example.com 請求書',
      ],
      ['ドットがトークン頭', '送付 john .doe@example.com 請求書'],
      ['ドットがトークン末', '送付 john. doe@example.com 請求書'],
      // 鏡像（ドメイン側）。指摘には無かったが同じ経路（セルフレビュー）
      ['ドット区切りのドメイン', '送付 john@example . com 請求書'],
      ['ドメイン側もコメント入り', '送付 john@example (c) . (c) com 請求書'],
      // `(c).(c)` は「( で始まり ) で終わる」ためコメント 1 個に見えるが、
      // 間のドットは dot-atom の繋ぎ目。形で判定していた頃はドットごと読み飛ばし
      // `<email> (c).(c) com` とドメインが残っていた（セルフレビューの総当たり）
      ['コメントに挟まれたドット', '送付 john@example (c).(c) com 請求書'],
    ])('%s を含むアドレスも丸ごとマスクする', (_name, raw) => {
      // `[^"]*` だとエスケープされた引用符を閉じ引用符と誤認し、`"john ` が残る
      //（PR #117 の Codex 指摘）
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe(
        '送付 <email> 請求書',
      );
    });

    it('囲みの中の空白は語の区切りにしない（括弧の中身は残す）', () => {
      // 深さを数える走査にしたので、`@` を含まない囲みは触らない
      const result = normalizeForTelemetry(
        '請求書(インボイス 対応) テンプレート',
        QUERY_MAX_LENGTH,
      );
      expect(result.value).toBe('請求書(インボイス 対応) テンプレート');
      expect(result.masked).toBe(false);
    });

    it('引用符つきローカル部（空白入り）も丸ごとマスクする', () => {
      // 空白区切りのトークン規則では `Doe"@example.com` だけが置換され
      // `送付 "john <email> 請求書` と前半が残る（PR #117 の Codex 指摘）
      expect(
        normalizeForTelemetry(
          '送付 "John Doe"@example.com 請求書',
          QUERY_MAX_LENGTH,
        ).value,
      ).toBe('送付 <email> 請求書');
    });

    it('上限が記号を含まない語を割っても断片を残さない', () => {
      // 区切りがあるなら末尾トークンは無条件で捨てる。記号の有無で判断すると
      // `<url> victim` のようにローカル部の前半が残る（PR #117 の Codex 指摘）
      const raw = `https://${'a'.repeat(985)} victim@example.com`;
      const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(result.value).toBe('<url>');
      expect(result.truncated).toBe(true);
    });

    // 【仕様変更 / PR #117】期待値を「和文を残す」から「空白が無ければ全部捨てる」
    // に変更した。旧仕様は記号で境界を決めており、列挙しても反転しても破れた
    // （`…,victim@exampl` が残る / トークン内側の `$` で切れて `secret$` が残る）。
    // 境界を空白だけにすれば割れない。分かち書きの無い和文は丸ごと捨てることに
    // なるが、1000 文字超の検索語は需要シグナルとして意味を持たないので、断片を
    // 残す危険と引き換えにしない。空白があれば手前は残る（下のテスト）。
    it('空白が無いまま上限で切れたら全部捨てる', () => {
      const raw = `${'あ'.repeat(995)}2026-4567`;
      const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(result.value).toBe('');
      expect(result.truncated).toBe(true);
    });

    it('空白があれば切れた末尾トークンだけを捨てる', () => {
      const result = normalizeForTelemetry(
        `請求書 ${'あ'.repeat(2000)}`,
        QUERY_MAX_LENGTH,
      );
      expect(result.value).toBe('請求書');
      expect(result.truncated).toBe(true);
    });

    it('末尾がマスクの置換結果ならそのまま残す', () => {
      // `<url>` はマスクが最後まで飲み込んだ印。長い URL 1 本の入力が丸ごと消えない
      const raw = `https://example.com/${'a'.repeat(1200)}`;
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe('<url>');
    });

    it.each([
      ['引用符', '"', '"'],
      ['括弧コメント', '(', ')'],
    ])('上限が%sの内側に落ちても前半を残さない', (_n, open, close) => {
      // 空白を境界にする規則の唯一の例外が囲みの内側の空白。閉じていない囲みは
      // 「途中で切れた」ことの直接の証拠なので、そこから捨てる
      //（PR #117 の Codex 指摘。囲みと上限の相互作用）
      const raw = `https://${'a'.repeat(980)} ${open}John Doe Victim${close}@example.com`;
      const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(result.value).toBe('<url>');
    });

    it.each([
      ['空白区切りのカード番号', '4111 1111 1111 1111'],
      ['空白区切りの電話番号', '090 1234 5678'],
      ['空白入りの郵便番号', '123 - 4567'],
    ])('上限が%sの途中に落ちても数字を残さない', (_n, num) => {
      // 空白は数字の連なりの区切りではないので、末尾の 1 語を捨てるだけでは
      // `<url> 4111` が残る（PR #117 の Codex 指摘）
      const raw = `https://${'a'.repeat(982)} ${num}`;
      const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(result.value).not.toMatch(/\d/u);
    });

    it.each([
      ['閉じた括弧コメント', 'john(comment here)@example.com'],
      ['入れ子の括弧コメント', 'john(a (b) c)@example.com'],
      ['引用符つきローカル部', '"John Doe Victim"@example.com'],
    ])('上限が%sを含むアドレスの途中に落ちても前半を残さない', (_n, addr) => {
      // マスク側（走査）と境界側（正規表現）でトークンの定義が別々だったため、
      // 境界側が囲みの内側の空白で割れて `<url> john` が残っていた
      //（PR #117 の Codex 指摘。同じ相互作用で 3 回）。定義を scanTokens に一本化した
      // 切れ位置をずらして総当たりする。上限内に収まった回はマスク済みの
      // `<email>` になるのが正しく、収まらない回に断片が残らないことを見る
      for (let pad = 960; pad <= 1000; pad += 1) {
        const value = normalizeForTelemetry(
          `https://${'a'.repeat(pad)} ${addr}`,
          QUERY_MAX_LENGTH,
        ).value;
        expect(value).not.toMatch(/john|doe|victim|comment|[@(]/iu);
      }
    });

    it('トークン内側の記号があってもローカル部の前半を残さない', () => {
      // 反転列挙では `$` が区切り扱いになり `<url> secret$` が残っていた
      //（PR #117 の Codex 指摘）
      const raw = `https://${'a'.repeat(980)} secret$victim@example.com`;
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe('<url>');
    });

    it('ポート番号つきのスキーム無し URL をマスクする', () => {
      // `/` を TLD 直後に要求していたため素通りしていた（PR #117 の Codex 指摘）
      expect(
        normalizeForTelemetry(
          'example.com:8443/customers/taro',
          QUERY_MAX_LENGTH,
        ).value,
      ).toBe('<url>');
    });

    it('RFC で許される記号を含むローカル部を丸ごとマスクする', () => {
      // 文字クラスから漏れていた記号の前で切れ、`o'<email>` のように
      // ローカル部の一部が残っていた（PR #117 の Codex 指摘）
      expect(
        normalizeForTelemetry("o'connor@example.com", QUERY_MAX_LENGTH).value,
      ).toBe('<email>');
      expect(
        normalizeForTelemetry(
          'customer/support=tag@example.com',
          QUERY_MAX_LENGTH,
        ).value,
      ).toBe('<email>');
    });

    it('国際化メールアドレス（Unicode ローカル部）をマスクする', () => {
      // ASCII 限定パターンだけだと丸ごと素通りしていた（PR #117 の Codex 指摘）
      expect(
        normalizeForTelemetry('送付 山田@example.com 請求書', QUERY_MAX_LENGTH)
          .value,
      ).toBe('送付 <email> 請求書');
    });

    it('国際化ドメインのアドレスもマスクする', () => {
      expect(
        normalizeForTelemetry('連絡先 taro@例え.jp まで', QUERY_MAX_LENGTH)
          .value,
      ).toBe('連絡先 <email> まで');
    });

    it('空白で区切られていれば前後の帳票名は残る', () => {
      // トークン単位で落とす仕様なので、区切りがあれば需要ランキングは壊れない
      expect(
        normalizeForTelemetry('請求書 a@b.co 見積書', QUERY_MAX_LENGTH).value,
      ).toBe('請求書 <email> 見積書');
    });

    it('短いハイフン区切り電話（9 桁）も引き続きマスクする', () => {
      // 空白を挟まない連なりの閾値 7 桁で拾う
      expect(normalizeForTelemetry('03-123-4567', QUERY_MAX_LENGTH).value).toBe(
        '<num>',
      );
    });

    it.each([
      ['半角空白入り', '123 - 4567'],
      ['全角空白入り', '123　-　4567'],
      ['全角長音+空白', '123 ー 4567'],
      ['空白入りの電話番号', '090 - 1234 - 5678'],
    ])('区切りの前後に空白がある番号（%s）もマスクする', (_name, raw) => {
      // 「空白を含むか」で閾値を分けていたため、空白側の閾値 10 に落ちて
      // 7 桁の郵便番号が素通りしていた（PR #117 の Codex 指摘）。
      // 見るべきは空白の有無ではなく「繋いでいるものが空白だけか」
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toContain(
        '<num>',
      );
    });

    it('数字どうしが空白だけで並ぶ場合は従来どおり残す', () => {
      expect(
        normalizeForTelemetry('2026 年 2027', QUERY_MAX_LENGTH).masked,
      ).toBe(false);
      expect(
        normalizeForTelemetry('請求書 2026 2027', QUERY_MAX_LENGTH).masked,
      ).toBe(false);
    });

    it.each([
      ['U+200B ZWSP', '\u200B'],
      ['U+200C ZWNJ', '\u200C'],
      ['U+FEFF BOM', '\uFEFF'],
      ['U+00AD soft hyphen', '\u00AD'],
      ['U+2060 word joiner', '\u2060'],
      ['U+180E mongolian vowel separator', '\u180E'],
      // ここから下は `\p{Cf}` に入らない不可視文字。種別で取るだけでは落ちず、
      // 同じ手口が通っていた（PR #117 の Codex 指摘。ZWSP に続いて 2 回目）
      ['U+034F combining grapheme joiner', '\u034F'],
      ['U+FE0F variation selector-16', '\uFE0F'],
      ['U+FE00 variation selector-1', '\uFE00'],
      ['U+3164 hangul filler', '\u3164'],
    ])('%s を挟んだ番号もマスクする', (_n, invisible) => {
      // NFKC は不可視の書式文字を残すため、挟むだけで連なりが 3 つに割れて
      // どれも閾値に届かず素通りしていた（PR #117 の Codex 指摘）
      const raw = `090${invisible}1234${invisible}5678`;
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe('<num>');
    });

    it.each([
      ['コロン', '090:1234:5678'],
      ['セミコロン', '090;1234;5678'],
      ['スラッシュ', '090/1234/5678'],
      ['縦棒', '090|1234|5678'],
      ['アスタリスク', '090*1234*5678'],
      ['等号', '090=1234=5678'],
      ['波ダッシュ', '090〜1234〜5678'],
    ])('%s 区切りの電話番号もマスクする', (_n, raw) => {
      // 区切りを列挙していたため、列挙外の記号を挟むと 3 つの短い連なりに割れて
      // どれも閾値に届かず素通りしていた（PR #117 の Codex 指摘。列挙漏れ 3 回目）。
      // 「文字でも数字でもないものは繋ぎ目」に反転したので、記号側は列挙不要
      expect(
        normalizeForTelemetry(`連絡先 ${raw} まで`, QUERY_MAX_LENGTH).value,
      ).toBe('連絡先 <num> まで');
    });

    it('語の並びは 1 つの番号に潰さない（反転の歯止め）', () => {
      // 繋ぎ目を広げすぎると普通の検索語が消える。文字 (`\p{L}`) は繋ぎ目に
      // しないことでここを守る
      for (const raw of ['a4 横 2 段', '第 3 版', 'v1.2.3 テンプレート']) {
        expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe(raw);
      }
    });

    it('先に当たったマスクが連なりを切って残した断片も畳む', () => {
      // NFKC が U+2A74 を `::=` へ畳むため IPv6 側が `090::` だけ食べ、
      // `<url>=<url>=5678` と末尾 4 桁が残っていた（総当たり 4,626 文字で検出）。
      // 原因のパターンではなく「断片」という結果の側で塞ぐ
      expect(
        normalizeForTelemetry(
          '連絡先 090\u2A741234\u2A745678 まで',
          QUERY_MAX_LENGTH,
        ).value,
      ).toBe('連絡先 <url> まで');
    });

    it('空白を挟んだ数字はマスクに巻き込まない', () => {
      // 断片の判定は「空白が無い＝同じトークン」。空白があれば別の語なので残す
      expect(
        normalizeForTelemetry('https://example.com/a 2026年', QUERY_MAX_LENGTH)
          .value,
      ).toBe('<url> 2026年');
    });

    it('ハイフン区切りの郵便番号をマスクする', () => {
      // 7 桁は「6 桁連続」にも「区切り数字 10 桁」にも当たらず素通りしていた
      //（PR #117 の Codex 指摘）
      expect(
        normalizeForTelemetry('123-4567 請求書', QUERY_MAX_LENGTH).value,
      ).toBe('<num> 請求書');
    });

    it('Unicode TLD のメールアドレスをマスクする', () => {
      // TLD を [A-Za-z]{2,} に固定していたため素通りしていた（PR #117 の Codex 指摘）
      expect(
        normalizeForTelemetry('山田@example.みんな', QUERY_MAX_LENGTH).value,
      ).toBe('<email>');
      expect(
        normalizeForTelemetry('山田@例え.テスト', QUERY_MAX_LENGTH).value,
      ).toBe('<email>');
    });

    // 【仕様変更 / PR #117】読点は空白ではないので同一トークン。上と同じ理由で
    // トークンごと落とす（旧期待値 `<email>、請求書`）。
    it('読点で続く語も同一トークンならまとめてマスクする', () => {
      expect(
        normalizeForTelemetry('山田@例え.テスト、請求書', QUERY_MAX_LENGTH)
          .value,
      ).toBe('<email>');
    });

    it('区切りの無い Unicode TLD アドレスもフォールバックで落とす', () => {
      // 精密なパターンが当たらない形は、トークンごと落とす側へ倒す
      const result = normalizeForTelemetry(
        '請求書山田@例え.テスト見積書',
        QUERY_MAX_LENGTH,
      );
      expect(result.value).toBe('<email>');
      expect(result.masked).toBe(true);
    });

    it.each([
      ['請求書/見積書', '和文の並記'],
      ['a4/横', '用紙の並記'],
      ['第1章/総則', '章番号の並記'],
    ])('%s（%s）は URL と誤認しない', (raw) => {
      // `/` があるだけではマスクしない。ドットかコロンを併せ持つときだけ
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).masked).toBe(false);
    });

    it.each([
      ['パスもクエリも無い www ホスト', 'www.customer-name.example'],
      ['大文字の WWW', 'WWW.EXAMPLE.COM'],
    ])('%s もマスクする', (_n, raw) => {
      // 区切り（/?#）を要求していたため素通りしていた（PR #117 の Codex 指摘）。
      // `www.` はホスト名であることの曖昧さの無い印なので区切り不要
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe('<url>');
    });

    it.each([
      ['ドット入りホスト + ポート', 'tenant.customer.example:8443'],
      ['Unicode ホスト + ポート', '例え.テスト:8443'],
      ['大文字ホスト + ポート', 'TENANT.EXAMPLE:443'],
    ])('%s もマスクする', (_n, raw) => {
      // パスもクエリも無いと区切り要件に当たらず、www. でも IP でもないので
      // 素通りしていた（PR #117 の Codex 指摘）
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe('<url>');
    });

    it.each([
      ['時刻', '10:30 会議資料'],
      ['時刻（秒つき）', '10:30:45 ログ'],
    ])('%s はホスト + ポートと誤認しない', (_n, raw) => {
      // コロンの前にドットが無いので当たらない
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).masked).toBe(false);
    });

    it('Unicode TLD のスキーム無し URL をマスクする', () => {
      expect(
        normalizeForTelemetry('例え.テスト/顧客/太郎', QUERY_MAX_LENGTH).value,
      ).toBe('<url>');
    });

    it.each([
      ['U+2010 HYPHEN', '090‐1234‐5678'],
      ['U+2013 EN DASH', '090–1234–5678'],
      ['U+2014 EM DASH', '090—1234—5678'],
      ['U+2212 MINUS SIGN', '090−1234−5678'],
      ['U+30FC 長音記号', '０９０ー１２３４ー５６７８'],
    ])('%s を区切りにした電話番号もマスクする', (_name, raw) => {
      // ASCII の `-` だけを見ていたため 3 つの短い連なりに割れ、
      // どれも閾値に届かず素通りしていた（PR #117 の Codex 指摘）
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe('<num>');
    });

    // ここから下はレビュー指摘ではなく**セルフレビューで見つけた穴**。
    // 「指摘された形を直す」だけでは同じ型の穴が残り続けるため、不変条件
    //（記録される文字列にメール / URL / 番号の原形・断片が残らない）を破りうる
    // 経路を自分で列挙して総当たりした結果を固定する。
    it.each([
      ['ドット無しドメイン', 'victim@localhost'],
      ['Unicode ドット無しドメイン', '山田@例え'],
      ['@ が 2 つ', 'a@b@c.example.com'],
    ])('%s のメールもマスクする', (_name, raw) => {
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe(
        '<email>',
      );
    });

    it.each([
      ['http/https 以外のスキーム', 'ftp://example.com/customers/taro'],
      ['独自スキーム', 's3://bucket/customers/taro'],
      ['パス無し・クエリのみ', 'example.com?token=山田'],
      ['パス無し・フラグメントのみ', 'example.com#山田'],
      ['角括弧 IPv6 単体', '[2001:db8::1]'],
      ['角括弧無しの IPv6', '2001:db8::1'],
    ])('%s の URL もマスクする', (_name, raw) => {
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe('<url>');
    });

    it.each([
      ['カンマ区切り', '4111,1111,1111,1111'],
      ['アンダースコア区切り', '090_1234_5678'],
      ['読点区切り', '090、1234、5678'],
      ['スラッシュ区切り', '4111/1111/1111/1111'],
    ])('%s の番号もマスクする', (_name, raw) => {
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe('<num>');
    });

    // 上のマスク強化で普通の検索語まで消えると需要ランキングが死ぬので、
    // 「残るべきもの」も同じ強さで固定する
    it.each([
      ['通常クエリ', '請求書テンプレート'],
      ['年入り', '見積書 2026年版'],
      ['中黒', '納品書・受領書'],
      ['括弧', '請求書(インボイス対応)'],
      ['時刻', '10:30 会議資料'],
      ['時刻（秒つき。IPv6 と誤認しない）', '10:30:45 ログ'],
      ['章番号', '第1章 総則'],
      ['バージョン', 'ver.1.2'],
      ['3 桁区切りの小さい金額', '売上 1,000 円'],
    ])('%s は残す', (_name, raw) => {
      const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(result.masked).toBe(false);
    });

    it.each([
      ['単体の IPv4', '10.0.0.1'],
      ['IPv4 + ポート', '10.0.0.1:8080'],
      ['IPv4 埋め込みの IPv6', '::ffff:192.0.2.128'],
      ['zone id つきの裸 IPv6', 'fe80::1%25eth0'],
      [
        'zone id つきの protocol-relative URL',
        '//[fe80::1%25eth0]/customers/taro',
      ],
      ['角括弧 IPv6 + ポート', '[2001:db8::1]:8443'],
      ['角括弧の IPv4 埋め込み', '[::ffff:10.0.0.1]/x'],
    ])('%s をマスクする', (_name, raw) => {
      // 単体 IPv4 は 7 桁未満で数字側の閾値にも届かず素通り、IPv4 埋め込みは
      // `<url>.0.2.128` と残り、zone id はパスを残していた（PR #117 の Codex 指摘）。
      // IPv6 → IPv4 の順で当てないと 1 つのアドレスが `<url><url>` に割れる
      //（セルフレビュー）
      expect(normalizeForTelemetry(raw, QUERY_MAX_LENGTH).value).toBe('<url>');
    });

    it('前に語が付く 4 連の数字はバージョン表記として残す', () => {
      const result = normalizeForTelemetry('ver.1.2.3.4', QUERY_MAX_LENGTH);
      expect(result.masked).toBe(false);
    });

    it('角括弧の IPv6 URL もマスクする', () => {
      // ホストは DNS 名 / IPv4 / 角括弧 IPv6 の 3 種で、最後が抜けていた
      //（PR #117 の Codex 指摘）
      expect(
        normalizeForTelemetry('[2001:db8::1]/customers/taro', QUERY_MAX_LENGTH)
          .value,
      ).toBe('<url>');
      expect(
        normalizeForTelemetry(
          '//[2001:db8::1]/customers/taro',
          QUERY_MAX_LENGTH,
        ).value,
      ).toBe('<url>');
    });

    it('ASCII 以外の数字で書かれた番号もマスクする', () => {
      // NFKC は全角は畳むが Arabic-Indic / Devanagari の数字は残すため、
      // `\d`（ASCII 限定）では 1 文字も当たらず素通りしていた（PR #117 の Codex 指摘）
      expect(
        normalizeForTelemetry('٤١١١ ١١١١ ١١١١ ١١١١', QUERY_MAX_LENGTH).value,
      ).toBe('<num>');
      expect(
        normalizeForTelemetry('१२३-४५६७ 請求書', QUERY_MAX_LENGTH).value,
      ).toBe('<num> 請求書');
    });

    it('userinfo つきのスキーム無し URL はパスごとマスクする', () => {
      // アドレスだけ落とすと `<email>/customers/山田` とパスが残る
      expect(
        normalizeForTelemetry(
          'taro@example.com/customers/山田',
          QUERY_MAX_LENGTH,
        ).value,
      ).toBe('<email>');
    });
  });

  describe('入力長の上限（DoS 対策）', () => {
    // query は zod で長さ制限しておらず HTTP 経路は 4MB のボディを受ける。
    // 非アンカーのメール正規表現は `@` を含まない ASCII 列に対して二次で効き、
    // 実測で 80,000 文字が 6.9 秒イベントループを止めていた（PR #117 の Codex 指摘）。
    // トークン単位の規則（メール / 引用符 / URL / 角括弧）は、アンカーが無いと
    // 走査開始位置がトークン内の全文字になり二次で効く。`[` を 1000 個並べた
    // 入力で実測 475ms かかった（セルフレビューで検出。元の DoS 指摘の再発）
    it.each([
      'a',
      '1',
      '@',
      ':',
      '[',
      '"',
      '/',
      '1.',
      'a:',
      'a@',
      '"a"@',
      '?',
      '#',
    ])('%s の繰り返し 80,000 文字でも即座に返る', (unit) => {
      const raw = unit.repeat(Math.ceil(80_000 / unit.length));
      const started = Date.now();
      normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(Date.now() - started).toBeLessThan(200);
    });

    it('巨大な入力でも即座に返る', () => {
      const started = Date.now();
      normalizeForTelemetry('a'.repeat(80_000), QUERY_MAX_LENGTH);
      // 修正前は約 6900ms。桁違いの余裕を持たせた上限で回帰を検知する
      expect(Date.now() - started).toBeLessThan(500);
    });

    // 【仕様変更 / PR #117】空白の無い入力は末尾トークン = 全体なので捨てる。
    // 「空白が無いまま上限で切れたら全部捨てる」と同じ理由。
    it('上限で切ったとき、空白があれば手前の語は残る', () => {
      const result = normalizeForTelemetry(
        `請求書 ${'あ'.repeat(50_000)}`,
        QUERY_MAX_LENGTH,
      );
      expect(result.value).toBe('請求書');
      expect(result.truncated).toBe(true);
    });

    it('入力上限がトークンを割って断片を残さない', () => {
      // 990 文字の URL の直後にアドレスが続くと、URL が <url> に縮んだ結果
      // 「切れたアドレスの断片」だけが残っていた（PR #117 の Codex 指摘）
      const raw = `https://example.com/${'a'.repeat(960)} victim@example.com`;
      const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(result.value).not.toContain('victim');
      expect(result.value).not.toContain('@');
    });

    it('入力を上限で切ったら truncated を立てる（出力が短くても）', () => {
      // 長い URL が <url> に縮むと出力は短いが、捨てた入力がある
      const raw = `https://example.com/${'a'.repeat(1200)}`;
      const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(result.truncated).toBe(true);
    });

    it('出力上限付近の PII は完全な形で見てからマスクする', () => {
      // 正規表現前の切り詰めが出力上限ぎりぎりだと、境界をまたぐメールが
      // 途中で切れてマスクを免れる。上限に十分な余裕を取っていることの確認
      const raw = `${'あ'.repeat(95)} taro.yamada@example.co.jp`;
      const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(result.value).not.toContain('taro');
      expect(result.masked).toBe(true);
    });

    it('西暦 4 桁は帳票名の一部として残す', () => {
      const result = normalizeForTelemetry('請求書2026', QUERY_MAX_LENGTH);
      expect(result.value).toBe('請求書2026');
      expect(result.masked).toBe(false);
    });
  });

  describe('切り詰め', () => {
    it('最大長ちょうどは切り詰めない', () => {
      const result = normalizeForTelemetry('あ'.repeat(100), QUERY_MAX_LENGTH);
      expect(result.truncated).toBe(false);
      expect(Array.from(result.value)).toHaveLength(100);
    });

    it('101 文字以上は 100 文字 + truncated=true', () => {
      const result = normalizeForTelemetry('あ'.repeat(101), QUERY_MAX_LENGTH);
      expect(result.truncated).toBe(true);
      expect(Array.from(result.value)).toHaveLength(100);
    });

    it('サロゲートペアを途中で割らない', () => {
      // 「𠮷」は 2 コードユニット。コードポイント単位で切らないと孤立サロゲートが残る
      const result = normalizeForTelemetry('𠮷'.repeat(101), QUERY_MAX_LENGTH);
      expect(Array.from(result.value)).toHaveLength(100);
      expect(result.value).toBe('𠮷'.repeat(100));
    });

    it('切り詰めはマスクの後に行う（切れたメールの前半が残らない）', () => {
      // マスク前は 100 文字を超え、マスク後は 100 文字未満になる入力
      const raw = `${'あ'.repeat(90)} taro.yamada@example.co.jp`;
      const result = normalizeForTelemetry(raw, QUERY_MAX_LENGTH);
      expect(result.value).toBe(`${'あ'.repeat(90)} <email>`);
      expect(result.truncated).toBe(false);
      expect(result.value).not.toContain('taro');
    });
  });
});

describe('buildGallerySearchedProperties', () => {
  it('正常系: 正規化済みクエリと件数を載せる', () => {
    const props = buildGallerySearchedProperties({
      success: true,
      query: ' Invoice ',
      matchedCount: 3,
      scannedCount: 120,
      totalPublished: 250,
    });

    expect(props).toEqual({
      query: 'invoice',
      success: true,
      matchedCount: 3,
      scannedCount: 120,
      totalPublished: 250,
    });
  });

  it('category 未指定ならキー自体を送らない', () => {
    const props = buildGallerySearchedProperties({
      success: true,
      query: 'invoice',
      matchedCount: 1,
      scannedCount: 1,
      totalPublished: 1,
    });
    expect('category' in props).toBe(false);
  });

  it('category 指定時は正規化して載せる', () => {
    const props = buildGallerySearchedProperties({
      success: true,
      query: 'invoice',
      category: ' Invoice ',
      matchedCount: 1,
      scannedCount: 1,
      totalPublished: 1,
    });
    expect(props.category).toBe('invoice');
    expect('categoryMasked' in props).toBe(false);
    expect('categoryTruncated' in props).toBe(false);
  });

  it('category もマスク・切り詰めをフラグで明示する', () => {
    // フラグが無いと、マスク済みの値と字面どおりの category 値を区別できない
    const masked = buildGallerySearchedProperties({
      success: true,
      query: 'invoice',
      category: 'a@b.co',
      matchedCount: 0,
      scannedCount: 0,
      totalPublished: 0,
    });
    expect(masked.category).toBe('<email>');
    expect(masked.categoryMasked).toBe(true);

    const long = buildGallerySearchedProperties({
      success: true,
      query: 'invoice',
      category: 'あ'.repeat(CODE_MAX_LENGTH + 1),
      matchedCount: 0,
      scannedCount: 0,
      totalPublished: 0,
    });
    expect(long.categoryTruncated).toBe(true);
    expect(Array.from(long.category as string)).toHaveLength(CODE_MAX_LENGTH);
  });

  it('0 件ヒットでも matchedCount=0 を載せて送出できる（未充足需要の捕捉）', () => {
    const props = buildGallerySearchedProperties({
      success: true,
      query: '建設業 請求書',
      matchedCount: 0,
      scannedCount: 250,
      totalPublished: 250,
    });
    expect(props.matchedCount).toBe(0);
    expect(props.success).toBe(true);
  });

  it('切り詰め時のみ queryTruncated=true を載せる', () => {
    const short = buildGallerySearchedProperties({
      success: true,
      query: 'invoice',
      matchedCount: 0,
      scannedCount: 0,
      totalPublished: 0,
    });
    expect('queryTruncated' in short).toBe(false);

    const long = buildGallerySearchedProperties({
      success: true,
      query: 'あ'.repeat(101),
      matchedCount: 0,
      scannedCount: 0,
      totalPublished: 0,
    });
    expect(long.queryTruncated).toBe(true);
    expect(Array.from(long.query as string)).toHaveLength(QUERY_MAX_LENGTH);
  });

  it('マスク時のみ queryMasked=true を載せる', () => {
    const masked = buildGallerySearchedProperties({
      success: true,
      query: 'a@b.co',
      matchedCount: 0,
      scannedCount: 0,
      totalPublished: 0,
    });
    expect(masked.queryMasked).toBe(true);
    expect(masked.query).toBe('<email>');
  });

  it('異常系: 件数を一切載せず errorClass を載せる', () => {
    const props = buildGallerySearchedProperties({
      success: false,
      query: 'invoice',
      errorClass: 'HttpError',
    });

    expect(props).toEqual({
      query: 'invoice',
      success: false,
      errorClass: 'HttpError',
    });
    // 失敗時に 0 を送ると「本当に 0 件だった検索」と区別できなくなる
    expect('matchedCount' in props).toBe(false);
    expect('scannedCount' in props).toBe(false);
    expect('totalPublished' in props).toBe(false);
  });
});

describe('buildGalleryCopiedProperties', () => {
  it('slug の大小文字を畳まない（実在のテンプレート ID と一致させるため）', () => {
    // slug は shortId() が作る大小文字混在の不透明な識別子。畳むとギャラリーの
    // データへ厳密に突き合わせられず、大小文字だけ違う slug も同一視される
    // 前後空白も落とさない（API が受理した文字列をそのまま残す）
    expect(
      buildGalleryCopiedProperties({
        slug: ' 0eLHZZ8PxpU4Z5r7 ',
        success: true,
      }),
    ).toEqual({ slug: ' 0eLHZZ8PxpU4Z5r7 ', success: true });
  });

  it('大小文字だけが違う slug を別物として扱える', () => {
    const upper = buildGalleryCopiedProperties({ slug: 'AbC', success: true });
    const lower = buildGalleryCopiedProperties({ slug: 'abc', success: true });
    expect(upper.slug).not.toBe(lower.slug);
  });

  it('成功した複製の slug は数字が続いてもマスクしない（復元不能を防ぐ）', () => {
    // 成功 = ギャラリー API が実在を認めた slug。ここで <num> に書き換わると、
    // その複製イベントはギャラリーへ突き合わせられなくなる
    const props = buildGalleryCopiedProperties({
      slug: '0e1234567xpU4Z5r',
      success: true,
    });
    expect(props.slug).toBe('0e1234567xpU4Z5r');
    expect('slugMasked' in props).toBe(false);
  });

  it('26 文字の ULID 形 slug も契約として受ける（公開ギャラリーに実在）', () => {
    // developer-docs examples/nda.md が公開ギャラリーの URL としてリンクしている実在値。
    // 1 系統だけを契約にすると、この形の slug が 6 桁以上の連続数字を含んだときに
    // <num> へ書き換わり、ギャラリーへの突き合わせが壊れる
    const props = buildGalleryCopiedProperties({
      slug: '01KD4H4ERAJVC2EJD66JRN55W2',
      success: true,
    });
    expect(props.slug).toBe('01KD4H4ERAJVC2EJD66JRN55W2');
    expect('slugMasked' in props).toBe(false);
  });

  it('17 文字の slug も契約として受ける（padStart(16) は下限しか定めない）', () => {
    // 実際に 17 文字になるのは 7337 年以降だが、上限を決め打ちする理由が無い
    const props = buildGalleryCopiedProperties({
      slug: '0e1234567xpU4Z5rQ',
      success: true,
    });
    expect(props.slug).toBe('0e1234567xpU4Z5rQ');
    expect('slugMasked' in props).toBe(false);
  });

  it('slug と slugOmitted は必ずどちらか一方が出る', () => {
    // 両方欠けた行は集計側でスキーマ違反になる（schema §3.4）。
    // 成功・失敗・省略・切り詰めの全経路で不変であることを固定する
    const cases: GalleryCopyObservation[] = [
      { slug: 'invoice-basic', success: true },
      { slug: 'a'.repeat(513), success: true },
      { slug: 'invoice-basic', success: false },
      { slug: 'a'.repeat(70), success: false },
    ];
    for (const observation of cases) {
      const props = buildGalleryCopiedProperties(observation);
      expect('slug' in props).toBe(!('slugOmitted' in props));
    }
  });

  it('失敗した複製に slugOmitted は付かない（省くのは実在確認済みの経路だけ）', () => {
    const props = buildGalleryCopiedProperties({
      slug: 'a'.repeat(1000),
      success: false,
    });
    expect('slugOmitted' in props).toBe(false);
    expect(props.slugTruncated).toBe(true);
  });

  it('上限を超えた検証済み slug は切り詰めず省く', () => {
    // 切り詰めると接頭辞が同じ別テンプレートの複製と静かに併合される
    const props = buildGalleryCopiedProperties({
      slug: 'a'.repeat(513),
      success: true,
    });
    expect('slug' in props).toBe(false);
    expect(props.slugOmitted).toBe(true);
    expect(props.success).toBe(true);
  });

  it('上限ちょうどの検証済み slug はそのまま残す', () => {
    const slug = 'a'.repeat(512);
    expect(buildGalleryCopiedProperties({ slug, success: true }).slug).toBe(
      slug,
    );
  });

  it('検証済み slug は正規化せずそのまま記録する', () => {
    // NFKC / 空白畳み込み / trim を掛けると API が受理した識別子と違う値になり、
    // 完全一致が壊れる（developer-docs PR #175 の Codex 指摘）
    const slug = ' Ｉnvoice  ｖ1 ';
    const props = buildGalleryCopiedProperties({ slug, success: true });
    expect(props.slug).toBe(slug);
    expect('slugMasked' in props).toBe(false);
    expect('slugTruncated' in props).toBe(false);
  });

  it('検証済み slug は 64 文字を超えても切り詰めない（別テンプレートとの併合を防ぐ）', () => {
    // API 契約 (openapi/coze-plugin-gallery.yaml) は slug に maxLength を置いて
    // いない。64 文字で切ると、先頭が同じ別テンプレートの複製が同じキーへ
    // 併合される（developer-docs PR #175 の Codex 指摘）
    const slug = `${'a'.repeat(70)}-alpha`;
    const props = buildGalleryCopiedProperties({ slug, success: true });
    expect(props.slug).toBe(slug);
    expect('slugTruncated' in props).toBe(false);
  });

  it('先頭が同じ長い検証済み slug を別物として保つ', () => {
    const a = buildGalleryCopiedProperties({
      slug: `${'a'.repeat(70)}-alpha`,
      success: true,
    });
    const b = buildGalleryCopiedProperties({
      slug: `${'a'.repeat(70)}-beta`,
      success: true,
    });
    expect(a.slug).not.toBe(b.slug);
  });

  it('未検証の slug は従来どおり 64 文字で切り詰める', () => {
    const props = buildGalleryCopiedProperties({
      slug: 'a'.repeat(70),
      success: false,
    });
    expect(Array.from(String(props.slug))).toHaveLength(CODE_MAX_LENGTH);
    expect(props.slugTruncated).toBe(true);
  });

  it('ハイフン区切りの人間可読 slug もマスクしない（API 契約は形を縛らない）', () => {
    // 公開ギャラリー API の契約 (openapi/coze-plugin-gallery.yaml) では slug は
    // pattern 無しの string で、例は `simple-invoice`。観測できた 2 系統だけを
    // 形の契約に固めると、この形の実在 slug が 6 桁以上の数字を含んだときに
    // <num> へ書き換わり、API が実在を認めた値なのに突き合わせられなくなる
    // (developer-docs PR #175 の Codex 指摘)
    const props = buildGalleryCopiedProperties({
      slug: 'invoice-2026-001234',
      success: true,
    });
    expect(props.slug).toBe('invoice-2026-001234');
    expect('slugMasked' in props).toBe(false);
  });

  it('失敗した複製は形が契約に合っていてもマスクする', () => {
    // 失敗呼び出しの slug は AI が渡した任意の値でありうる。形だけで免除すると
    // `ABCDEF1234567890` のような値の数字列がマスクを免れる
    const props = buildGalleryCopiedProperties({
      slug: 'ABCDEF1234567890',
      success: false,
    });
    expect(props.slug).toBe('ABCDEF<num>');
    expect(props.slugMasked).toBe(true);
  });

  it('実在確認を通った失敗（不明）の slug はマスクしない', () => {
    // 複製 POST がタイムアウト / 5xx で失敗しても、slug の実在は確認済み。
    // ここを加工すると、どのテンプレートの転換が取りこぼされたのか追えなくなる
    // （developer-docs PR #175 の Codex 指摘）
    const props = buildGalleryCopiedProperties({
      slug: 'invoice-2026-001234',
      success: false,
      outcomeUnknown: true,
      slugVerified: true,
    });
    expect(props.slug).toBe('invoice-2026-001234');
    expect('slugMasked' in props).toBe(false);
  });

  it('実在確認を通っていない失敗の slug はマスクする', () => {
    const props = buildGalleryCopiedProperties({
      slug: 'invoice-2026-001234',
      success: false,
    });
    expect(props.slugMasked).toBe(true);
  });

  it('失敗呼び出しの PII 形状にはマスクを当てる', () => {
    // 免除の根拠は「ギャラリー API が実在を認めた」ことなので、成功していない
    // 呼び出しの値は AI が渡した任意の文字列として扱う
    expect(
      buildGalleryCopiedProperties({ slug: '090-1234-5678', success: false })
        .slug,
    ).toBe('<num>');
    expect(
      buildGalleryCopiedProperties({ slug: '4111111111111111', success: false })
        .slug,
    ).toBe('<num>');
  });

  it('大小文字を畳まなくても URL はマスクされる', () => {
    const props = buildGalleryCopiedProperties({
      slug: 'HTTPS://Example.com/x',
      success: false,
    });
    expect(props.slug).toBe('<url>');
    expect(props.slugMasked).toBe(true);
  });

  it('PII 形状の slug はマスクして slugMasked=true', () => {
    // slug はサーバー生成 ID だが、AI が任意の値を渡せるので同じ経路で守る
    const props = buildGalleryCopiedProperties({
      slug: 'taro.yamada@example.co.jp',
      success: false,
    });
    expect(props.slug).toBe('<email>');
    expect(props.slugMasked).toBe(true);
  });

  it('通常の slug では slugMasked を送らない', () => {
    const props = buildGalleryCopiedProperties({
      slug: 'invoice-basic',
      success: true,
    });
    expect('slugMasked' in props).toBe(false);
    expect('slugTruncated' in props).toBe(false);
  });

  it('query / category は従来どおり大小文字を畳む', () => {
    // slug の扱いを変えたことで、自由記述側の表記ゆれ吸収が壊れていないこと
    const props = buildGallerySearchedProperties({
      success: true,
      query: 'INVOICE',
      category: 'Invoice',
      matchedCount: 1,
      scannedCount: 1,
      totalPublished: 1,
    });
    expect(props.query).toBe('invoice');
    expect(props.category).toBe('invoice');
  });

  it('長い slug は切り詰めて slugTruncated=true', () => {
    const props = buildGalleryCopiedProperties({
      slug: 'a'.repeat(CODE_MAX_LENGTH + 1),
      success: false,
    });
    expect(props.slugTruncated).toBe(true);
    expect(Array.from(props.slug as string)).toHaveLength(CODE_MAX_LENGTH);
    expect(props.success).toBe(false);
  });
});

describe('track ヘルパー', () => {
  it('検索イベントを timestamp つきで送る', () => {
    const client = new RecordingClient();
    trackGallerySearched(client, {
      success: true,
      query: 'invoice',
      matchedCount: 2,
      scannedCount: 10,
      totalPublished: 10,
    });

    expect(client.events).toHaveLength(1);
    expect(client.events[0].event).toBe(GALLERY_SEARCHED_EVENT);
    expect(typeof client.events[0].timestamp).toBe('number');
    expect(client.events[0].properties?.query).toBe('invoice');
  });

  it('検索には workspaceId を載せない（未認証ツールなので帰属を偽装できるため）', () => {
    const client = new RecordingClient();
    trackGallerySearched(client, {
      success: true,
      query: 'invoice',
      matchedCount: 0,
      scannedCount: 0,
      totalPublished: 0,
    });

    expect(client.events[0].workspaceId).toBeUndefined();
    expect(client.events[0].userId).toBeUndefined();
  });

  it('成功した複製には workspaceId を載せる（上流 API が Bearer を受理した証拠）', () => {
    const client = new RecordingClient();
    trackGalleryCopied(client, {
      slug: 'invoice-basic',
      success: true,
      workspaceId: '0eLHZZ8PxpU4Z5r7',
    });

    expect(client.events[0].workspaceId).toBe('0eLHZZ8PxpU4Z5r7');
    expect(client.events[0].userId).toBeUndefined();
  });

  it('失敗した複製には workspaceId を載せない', () => {
    // 書き込みが起きていない呼び出しを任意のワークスペース宛に注入させない。
    // ユニオンなので型としても書けない（下の @ts-expect-error がそれを固定する）が、
    // 型を迂回した呼び出し（JS からの利用・as 変換）でも実行時に落とすことを見る。
    const client = new RecordingClient();
    // @ts-expect-error 失敗した複製に workspaceId は付けられない（型で封じている）。
    // ユニオンの不一致は代入先（宣言行）で報告されるのでディレクティブもここに置く。
    const observation: GalleryCopyObservation = {
      slug: 'invoice-basic',
      success: false,
      workspaceId: '0eLHZZ8PxpU4Z5r7',
    };
    trackGalleryCopied(client, observation);

    expect(client.events[0].workspaceId).toBeUndefined();
  });

  it('判定不能な失敗には outcomeUnknown を載せる', () => {
    const client = new RecordingClient();
    trackGalleryCopied(client, {
      slug: 'invoice-basic',
      success: false,
      outcomeUnknown: true,
    });

    expect(client.events[0].properties?.success).toBe(false);
    expect(client.events[0].properties?.outcomeUnknown).toBe(true);
    // 帰属は不明でも付けない（書き込みを確認できていないため）
    expect(client.events[0].workspaceId).toBeUndefined();
  });

  it('失敗が確定している複製には outcomeUnknown を載せない（既定はキー無し）', () => {
    const client = new RecordingClient();
    trackGalleryCopied(client, { slug: 'invoice-basic', success: false });

    expect(client.events[0].properties).not.toHaveProperty('outcomeUnknown');
  });

  it('成功した複製には outcomeUnknown を載せない', () => {
    const client = new RecordingClient();
    trackGalleryCopied(client, { slug: 'invoice-basic', success: true });

    expect(client.events[0].properties).not.toHaveProperty('outcomeUnknown');
  });

  it('outcomeUnknown: false は送らない（4096 byte の properties 上限を食わない）', () => {
    const client = new RecordingClient();
    trackGalleryCopied(client, {
      slug: 'invoice-basic',
      success: false,
      outcomeUnknown: false,
    });

    expect(client.events[0].properties).not.toHaveProperty('outcomeUnknown');
  });

  it('workspaceId 未指定の複製でも送出できる', () => {
    const client = new RecordingClient();
    trackGalleryCopied(client, { slug: 'abc', success: true });

    expect(client.events).toHaveLength(1);
    expect(client.events[0].workspaceId).toBeUndefined();
  });

  it('複製イベントを送る', () => {
    const client = new RecordingClient();
    trackGalleryCopied(client, { slug: 'abc123', success: true });

    expect(client.events).toHaveLength(1);
    expect(client.events[0].event).toBe(GALLERY_COPIED_EVENT);
    expect(client.events[0].properties?.slug).toBe('abc123');
  });

  it('client.track が throw しても呼び出し元へ伝播させない', () => {
    const throwingClient: TelemetryClient = {
      track: () => {
        throw new Error('boom');
      },
      flush: async () => {},
    };

    expect(() =>
      trackGallerySearched(throwingClient, {
        success: true,
        query: 'invoice',
        matchedCount: 0,
        scannedCount: 0,
        totalPublished: 0,
      }),
    ).not.toThrow();
    expect(() =>
      trackGalleryCopied(throwingClient, { slug: 'abc', success: true }),
    ).not.toThrow();
  });
});
