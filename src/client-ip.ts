/** Worker が Container へ渡す接続元。CF-* は転送時に落ちることがある。 */
export const REPORTFLOW_CONNECTING_IP_HEADER = 'x-reportflow-connecting-ip';

/**
 * Container が接続元ヘッダを信用する印。Worker の envVars だけが `1` を渡す。
 * 未設定の直接起動は `req.ip` だけを使い、クライアントのヘッダでは枠を分けない。
 */
export const TRUST_CONNECTING_IP_HEADERS = 'TRUST_CONNECTING_IP_HEADERS';

/**
 * エッジが見た `CF-Connecting-IP` を専用ヘッダへ写す。
 * クライアントが同じヘッダを付けていても上書きし、エッジの値がないときは消す。
 */
export const stampConnectingIp = (headers: Headers): void => {
  const fromEdge = headers.get('cf-connecting-ip')?.trim() ?? '';
  if (fromEdge.length > 0) {
    headers.set(REPORTFLOW_CONNECTING_IP_HEADER, fromEdge);
    return;
  }
  headers.delete(REPORTFLOW_CONNECTING_IP_HEADER);
};
