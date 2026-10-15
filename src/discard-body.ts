/**
 * 読まずに捨てる応答のストリームを解放する。
 *
 * ── なぜ 1 箇所に置くのか (PRJ-3-1582) ───────────────────────────────────────
 * `fetch` の応答は、本文を読むか cancel するまでコネクションを掴んだままになる
 * (解放は GC 任せ)。「status だけ見て本文は使わない」経路はどのモジュールにも
 * 現れるので、同じ 4 行をその都度書くと**片方だけ直った状態**が生まれる
 * (PRJ-3-1573 の走査ではまさにそれが 3 クラス見つかった)。呼ぶ側の理由は
 * 違っても、やること — 「掴んだまま抜けない」「cancel の失敗を上へ伝えない」 —
 * は同じなので、実装はここ 1 つにする。
 *
 * ── cancel の失敗で確定済みの結論を塗り替えない ─────────────────────────────
 * ここで例外を投げると、呼び出し側が**既に確定させた**判断が catch で別物に
 * 化ける:
 * - `oauth-upstream.ts`: `redirect` / `body_too_large` が `network_error` に
 * - `telemetry/client.ts`: 送信済みの成功が「send failed」の warn に
 * - `http.ts`: 3xx の `HttpError` が cancel 由来の例外に
 *
 * 解放できないのは掴む相手が既に居ないとき (ストリームが error 状態・既に
 * 読み切っている) なので、いずれの判定にも影響しない。握り潰してよい。
 *
 * 引数は `Response` ではなく「cancel できるもの」にしてある。必要なのは
 * `cancel()` だけだと型で示せるうえ、`ReadableStream` の型引数
 * (`Uint8Array<ArrayBuffer>` か `Uint8Array<ArrayBufferLike>` か) が
 * @types/node の版で揺れるのに巻き込まれない。**`Response` も
 * `ReadableStreamDefaultReader` もそのまま渡せる**。
 */
export type Cancellable = { cancel(): Promise<void> };

export type DiscardableResponse = {
  readonly body?: Cancellable | null;
};

/**
 * `cancel()` を呼び、その失敗を握り潰す。
 *
 * **`discardBody` と分けてあるのは、解放するものが `res.body` とは限らないから**
 * (PRJ-3-1581 の CodeRabbit 指摘)。`oauth-upstream.ts` の `readBodyWithLimit` は
 * 上限超過を検出した時点で **reader** を cancel する。そこで素の
 * `reader.cancel()` を await していたため、cancel が reject すると
 * 確定済みの `body_too_large` が呼び出し側の catch で `network_error` に化けた。
 * 「解放の失敗を上の結論より上へ伝播させない」という規則は、`body` を持つ
 * オブジェクトにも reader にも等しく要る。
 */
export const cancelQuietly = async (
  target: Cancellable | null | undefined,
): Promise<void> => {
  try {
    await target?.cancel();
  } catch {
    // 意図的に無視 (上記)。
  }
};

/** 応答本文を読まずに解放する。`cancelQuietly` の `res.body` 向けの入口。 */
export const discardBody = async (res: DiscardableResponse): Promise<void> =>
  cancelQuietly(res.body);
