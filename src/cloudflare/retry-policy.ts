/**
 * Worker → Container 振り分けのリトライ判定（純粋関数）。
 * cloudflare:workers に依存しない（PRJ-3-1664）。
 */

// Explicit allowlist only. Do not use prefix matches for notifications/* —
// cancellation/progress notifications are not safe to duplicate.
const RETRYABLE_METHODS = new Set([
  'initialize',
  'ping',
  'server/discover',
  'tools/list',
  'prompts/list',
  'prompts/get',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'notifications/initialized',
]);

const DISCONNECT_MARKERS = [
  'Container port connection closed unexpectedly',
  'Container suddenly disconnected',
  'Error proxying request to container',
] as const;

export const parseJsonRpcMethod = (body: string): string | undefined => {
  if (body === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const method = (parsed as { method?: unknown }).method;
    return typeof method === 'string' ? method : undefined;
  } catch {
    return undefined;
  }
};

export const isRetryableMethod = (method: string | undefined): boolean => {
  if (method === undefined) return false;
  return RETRYABLE_METHODS.has(method);
};

export const isContainerDisconnectBody = (text: string): boolean =>
  DISCONNECT_MARKERS.some((marker) => text.includes(marker));

export const pickOtherInstanceName = (used: string): string =>
  used === 'instance-0' ? 'instance-1' : 'instance-0';

export type InstanceCount = 1 | 2;

/**
 * vars.MCP_CONTAINER_INSTANCES を読む。wrangler.jsonc の max_instances と同じ値で
 * なければならない（scripts/verify-cloudflare-config.mjs が突き合わせる）。
 * '1' 以外は従来どおり 2 台として扱う。
 */
export const parseInstanceCount = (raw: string | undefined): InstanceCount =>
  raw?.trim() === '1' ? 1 : 2;

/**
 * 1 台構成（staging）は instance-0 だけに送る。max_instances を超える名前へ
 * 送ると起動できずに失敗するため、2 台目の名前は使わない。
 */
export const pickFirstInstanceName = (
  count: InstanceCount,
  random: () => number = Math.random,
): string => {
  if (count === 1) return 'instance-0';
  return random() < 0.5 ? 'instance-0' : 'instance-1';
};
