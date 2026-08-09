import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';

/**
 * 新旧を混ぜた `_meta` エンベロープを legacy 経路へ逃がすための正規化。
 *
 * ## なぜ必要か
 *
 * `@modelcontextprotocol/server` の分類 (classifyRequestBody) は
 * 「`params._meta` に `io.modelcontextprotocol/protocolVersion` があれば
 * 新世代リクエスト」と判定し、新世代で受けるのは 2026-07-28 のみ。そのため
 * 「新世代のエンベロープを付けながら中で 2025 系を名乗る」クライアントは
 * 400 (-32022) になり、**ツールを 1 つも呼べない**。本番ログでは
 * -32022 と envelope-invalid (-32602) がペアで延々繰り返されており、
 * 該当クライアントが両方の形で再試行して両方弾かれていた
 * (2026-07-30 / 08-06 / 08-08 に計 2390 件)。
 *
 * コミュニティへ公開しているサーバーで接続元クライアントを修正できないため、
 * 「新世代として成立していないエンベロープ」は剥がして legacy 経路へ流す。
 * legacy 経路 (createMcpHandler の既定 `legacy: 'stateless'`) は現に正常動作
 * しており、同じツール群をそのまま提供できる。
 *
 * ## 剥がす条件 (保守的に、既知の壊れ方だけ)
 *
 * - エンベロープが **2025 era の revision** を名乗る → 新世代としては矛盾
 * - エンベロープが必須キー `io.modelcontextprotocol/clientCapabilities` を欠く
 *   → 新世代として成立しない
 *
 * 未知の将来 revision (例 2027-xx) を名乗り、かつ必須キーが揃っているものは
 * **触らない**。SDK 側の判断 (対応 or 400) をそのまま通す。ここで先回りして
 * 落とすと、SDK が将来対応したときに黙って legacy へ落とし続けてしまう。
 */

/**
 * 2025 era (旧世代 = per-request envelope を持たない) の protocol revision。
 * README「Supported protocol revisions」および SDK の
 * LATEST_PROTOCOL_VERSION (2025-11-25) / DEFAULT_NEGOTIATED_PROTOCOL_VERSION
 * (2025-03-26) と対応する。
 */
const LEGACY_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  '2024-10-07',
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]);

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * エンベロープを剥がすべきなら理由 (ログ用) を返す。剥がす必要が無ければ undefined。
 * `_meta` にエンベロープ主張が無い純粋な旧クライアントも undefined。
 */
const downgradeReason = (meta: JsonRecord): string | undefined => {
  if (!(PROTOCOL_VERSION_META_KEY in meta)) return undefined;

  const claimed = meta[PROTOCOL_VERSION_META_KEY];
  if (typeof claimed !== 'string') {
    return 'envelope protocolVersion is not a string';
  }
  if (LEGACY_PROTOCOL_VERSIONS.has(claimed)) {
    return `envelope claims 2025-era revision ${claimed}`;
  }
  if (!(CLIENT_CAPABILITIES_META_KEY in meta)) {
    return `envelope claims ${claimed} without ${CLIENT_CAPABILITIES_META_KEY}`;
  }
  return undefined;
};

/**
 * `params._meta` から protocolVersion キーだけを取り除いた message を返す。
 *
 * 取り除くのは 1 キーのみ。SDK の hasEnvelopeClaim はこのキーの有無だけで
 * 世代を判定するため、これだけで legacy 分類になる。progressToken など旧仕様の
 * `_meta` は温存する (消すと進捗通知が壊れる)。キーが空になった `_meta` は削る。
 */
const stripEnvelopeClaim = (
  message: JsonRecord,
  params: JsonRecord,
  meta: JsonRecord,
): JsonRecord => {
  const nextMeta: JsonRecord = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key === PROTOCOL_VERSION_META_KEY) continue;
    nextMeta[key] = value;
  }

  const nextParams: JsonRecord = { ...params };
  if (Object.keys(nextMeta).length > 0) nextParams['_meta'] = nextMeta;
  else delete nextParams['_meta'];

  return { ...message, params: nextParams };
};

const normalizeMessage = (
  message: unknown,
): { message: unknown; reason?: string } => {
  if (!isRecord(message)) return { message };
  const params = message['params'];
  if (!isRecord(params)) return { message };
  const meta = params['_meta'];
  if (!isRecord(meta)) return { message };

  const reason = downgradeReason(meta);
  if (reason === undefined) return { message };
  return { message: stripEnvelopeClaim(message, params, meta), reason };
};

export type NormalizedBody = {
  /** 正規化後の body。変更が無ければ入力と同一参照。 */
  body: unknown;
  /** 剥がした理由 (ログ用)。空配列なら何もしていない。 */
  reasons: string[];
};

/**
 * JSON-RPC body (単体 / バッチ) を正規化する。
 * 変更が不要なときは入力をそのまま返す (コピーしない)。
 */
export const normalizeInboundBody = (body: unknown): NormalizedBody => {
  if (Array.isArray(body)) {
    const reasons: string[] = [];
    let changed = false;
    const next = body.map((entry) => {
      const result = normalizeMessage(entry);
      if (result.reason !== undefined) {
        reasons.push(result.reason);
        changed = true;
      }
      return result.message;
    });
    return changed ? { body: next, reasons } : { body, reasons: [] };
  }

  const result = normalizeMessage(body);
  return result.reason === undefined
    ? { body, reasons: [] }
    : { body: result.message, reasons: [result.reason] };
};

/**
 * body を legacy へ落としたとき、`MCP-Protocol-Version` ヘッダーも一緒に外すか。
 *
 * 外さないと SDK の分類が「ヘッダーは新世代を名乗るのに body にエンベロープが
 * 無い」(modern-header-without-claim) として再び 400 にしてしまう。2025 era の
 * 値ならそのままで legacy 分類に矛盾しないので温存する。
 */
export const shouldDropProtocolVersionHeader = (
  header: string | string[] | undefined,
): boolean => {
  if (header === undefined) return false;
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === '') return false;
  return !LEGACY_PROTOCOL_VERSIONS.has(value);
};
