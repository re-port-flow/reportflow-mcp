// ワークスペース実効ロールの解決 (PRJ-3-1584 / ST-3)。
//
// ## 権限の正 (source of truth)
// reposts-api `GET /workspace/list` の `results[].memberAuth.authTypeCode`。
// MCP 側に独自のロールを持たない —— 持てば必ず本体とずれ、除籍・降格が
// 反映されない期間が生まれる。
//
// この口を選ぶ理由:
// - 既存の `profile` scope で呼べる (workspace.controller.ts の
//   `@RequireScopes('profile')`)。ロールのためだけに scope を増やさずに済む。
// - 第三者トークンにはバインド先ワークスペース 1 件だけを返す
//   (`_visibleWorkspaces`)。他ワークスペースの存在が漏れない。
// - `approve: true` のメンバーシップだけを返す
//   (`workspace.repository.service.ts getList` の where)。未承認の招待は
//   そもそも一覧に出ないので、ここで別途 approve を見る必要が無い。
//
// ## fail-closed
// 401 / 403 / 5xx / timeout / 契約外レスポンスは**どれもワークスペース権限なし**
// (`PUBLIC_CAPABILITIES`) に落とす。ただし `status` で区別して返すので、呼び出し側は
// 「再認証すれば直る」「権限が足りない」「上流が落ちている」を別の文言・別のログに
// できる。全部同じエラーに潰すと、障害のときにユーザーが権限設定を疑い続ける。
//
// ## このファイルの守備範囲
// I/O とキャッシュだけ。ロール → capability の表は `workspace-permission.ts`
// (純関数) にあり、そちらはネットワーク無しでテーブル駆動テストできる。

import { createHash } from 'node:crypto';
import { AuthRequiredError, getAuthHeaders } from './auth.js';
import { getHttpAuthContext } from './auth-context.js';
import { getAppKey, getMainApiBaseUrl } from './gallery-client.js';
import { fetchJson, HttpError } from './http.js';
import { decodeJwtPayload } from './jwt.js';
import {
  capabilitiesForRole,
  PUBLIC_CAPABILITIES,
  roleFromAuthTypeCode,
  type WorkspaceCapability,
  type WorkspaceRole,
} from './workspace-permission.js';

/**
 * ロール解決のデッドライン。
 *
 * `tools/list` と `tools/call` の**手前**に入る同期的な寄り道なので、上流が
 * 詰まっているときに MCP 応答をそれ以上待たせない。既定 (30s) のままだと
 * クライアント側のタイムアウトに先に当たる。
 */
export const WORKSPACE_ROLE_TIMEOUT_MS = 5_000;

/** 解決結果のキャッシュ TTL (ST-1 判断4: 60 秒 / token 単位 / 単一フライト)。 */
export const WORKSPACE_ROLE_CACHE_TTL_MS = 60_000;

/**
 * キャッシュ上限。HTTP モードはリクエスト毎に解決するため、放置するとトークンの
 * 数だけ際限なく増える (長寿命プロセス)。超えたら最も古い項目から捨てる。
 */
const MAX_CACHE_ENTRIES = 500;

/**
 * ロール解決の結果。
 *
 * - `resolved`        : 上流がトークンを受理し、バインド先ワークスペースの
 *                       ロールが確定した。`role` は `UNKNOWN` になり得る
 *                       (契約外のコード) が、その場合も capability は public のみ。
 * - `unauthenticated` : トークンが無い / 上流が 401。再認証で直る。
 * - `forbidden`       : 上流が 403、またはバインド先ワークスペースが一覧に無い
 *                       (非所属 / 未承認 / 削除済み)。権限の問題。
 * - `unavailable`     : 5xx / 429 / timeout / 契約外レスポンス。**権限の問題ではない**。
 */
export type RoleResolution =
  | { status: 'resolved'; role: WorkspaceRole; workspaceId: string }
  | { status: 'unauthenticated'; reason: string }
  | { status: 'forbidden'; reason: string }
  | { status: 'unavailable'; reason: string };

/** 解決結果と、そこから決まる capability 集合。 */
export type WorkspaceAuthorization = {
  capabilities: ReadonlySet<WorkspaceCapability>;
  resolution: RoleResolution;
};

type CacheEntry = { expiresAt: number; resolution: RoleResolution };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<RoleResolution>>();

/**
 * キャッシュキー。**アクセストークンそのものは持たない** ——
 * SHA-256 にしてから使う。Map のキーは例外のスタックやヒープダンプに出るので、
 * 生のトークンを置く理由が無い。ワークスペース ID も混ぜて、同じトークンで
 * バインド先が変わった場合 (再認可) に古い結果を引かないようにする。
 */
const cacheKeyFor = (authorization: string, workspaceId: string): string =>
  `${createHash('sha256').update(authorization).digest('hex')}:${workspaceId}`;

/** 期限切れを掃除し、上限を超えていれば古い順に捨てる。 */
const pruneCache = (now: number): void => {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  // Map は挿入順を保つので、先頭が最も古い。
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
};

/** テストと `authenticate force=true` (ワークスペース切り替え) 用。 */
export const clearWorkspaceRoleCache = (): void => {
  cache.clear();
  inflight.clear();
};

const bearerTokenOf = (headers: Record<string, string>): string | undefined => {
  const authorization = headers['Authorization'] ?? headers['authorization'];
  if (typeof authorization !== 'string') return undefined;
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) return undefined;
  const token = authorization.slice(prefix.length).trim();
  return token.length > 0 ? token : undefined;
};

type WorkspaceListItem = {
  workspaceId?: unknown;
  memberAuth?: { authTypeCode?: unknown } | null;
};

/**
 * `GET /workspace/list` のレスポンスを実行時検証してロールを取り出す。
 *
 * `fetchJson` は型を信じるだけで検証しないので、契約外の応答 (HTML への
 * フォールバック / 形の変更 / 欠損) はここまで素通りで届く。**「読めなかった」と
 * 「権限が無い」を分ける**のがこの関数の役目で、読めなかったものを権限不足に
 * 潰すと、上流の障害がユーザーには「権限を剥奪された」ように見える。
 */
export const parseWorkspaceRole = (
  body: unknown,
  workspaceId: string,
): RoleResolution => {
  if (body === null || typeof body !== 'object') {
    return { status: 'unavailable', reason: 'contract:body-not-object' };
  }
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return { status: 'unavailable', reason: 'contract:results-not-array' };
  }

  // トークンの workspace_id と一覧の workspace ID の一致検証 (親タスク Must)。
  // 一致する行だけを見るので、万一フィルタが効かず全件返ってきても他ワークスペースの
  // ロールを拾わない。
  const matched = (results as WorkspaceListItem[]).filter(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      item.workspaceId === workspaceId,
  );

  if (matched.length === 0) {
    // 非所属 / 未承認 / 削除済みワークスペース。いずれも「権限が無い」で正しく、
    // どれであるかは呼び出し側へ伝えない (403 から存在有無を推測させない)。
    return { status: 'forbidden', reason: 'workspace-not-in-list' };
  }
  if (matched.length > 1) {
    // 1 ワークスペースにつき 1 行が契約。重複はデータ側の異常で、どちらを採るかを
    // ここで選ぶ根拠が無い。
    return { status: 'unavailable', reason: 'contract:duplicate-workspace' };
  }

  const memberAuth = matched[0].memberAuth;
  if (memberAuth === null || typeof memberAuth !== 'object') {
    return { status: 'unavailable', reason: 'contract:memberAuth-missing' };
  }
  const raw = memberAuth.authTypeCode;
  if (typeof raw !== 'string') {
    return {
      status: 'unavailable',
      reason: 'contract:authTypeCode-not-string',
    };
  }

  // 契約外のコード (未知ロール) はここでは `resolved` として返す。上流は正しく
  // 応答しており、読めた値がこちらの知らないロールだった、という別の事実だから。
  // capability 側で `UNKNOWN` → public のみに落とす。
  return {
    status: 'resolved',
    role: roleFromAuthTypeCode(raw),
    workspaceId,
  };
};

/** HTTP の失敗をロール解決の分類へ写す。 */
const classifyError = (err: unknown): RoleResolution => {
  if (err instanceof AuthRequiredError) {
    return { status: 'unauthenticated', reason: 'auth-required' };
  }
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return { status: 'unauthenticated', reason: 'upstream-401' };
    }
    if (err.status === 403) {
      return { status: 'forbidden', reason: 'upstream-403' };
    }
    // 429 / 5xx / それ以外の 4xx (404 = 経路の不整合、412 = app-key 欠落) は
    // すべて「解決できなかった」。権限不足と同じ箱に入れない。
    return { status: 'unavailable', reason: `upstream-${err.status}` };
  }
  // タイムアウト / 通信断 / JSON パース失敗 (HTML フォールバック等)。
  return { status: 'unavailable', reason: 'upstream-unreachable' };
};

const fetchWorkspaceRole = async (
  token: string,
  workspaceId: string,
): Promise<RoleResolution> => {
  const url = `${getMainApiBaseUrl()}/workspace/list`;
  try {
    const body = await fetchJson<unknown>(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // reposts-api の @DefaultController は VerifyVersion ガードを付けており、
        // app-key が無いと 412 でハンドラに到達しない (gallery-client.ts と同じ)。
        'app-key': getAppKey(),
        Accept: 'application/json',
      },
      timeoutMs: WORKSPACE_ROLE_TIMEOUT_MS,
    });
    return parseWorkspaceRole(body, workspaceId);
  } catch (err) {
    return classifyError(err);
  }
};

/**
 * 現在の認証コンテキスト (HTTP は per-request の Bearer、stdio は保存トークン) の
 * ワークスペース実効ロールを解決する。**例外を投げない**。
 *
 * キャッシュするのは `resolved` だけ (ST-1 判断4: 失敗は負キャッシュしない)。
 * 失敗を覚えると、上流が復旧しても最大 TTL のあいだ権限が戻らない。
 *
 * 同じキーの同時呼び出しは 1 本の fetch に束ねる (単一フライト)。`tools/list` と
 * `tools/call` が並ぶ 1 リクエスト内で 2 回引かないため。
 */
export const resolveWorkspaceRole = async (
  mode: 'stdio' | 'http',
): Promise<RoleResolution> => {
  // **HTTP モードで stdio のトークンストアへ落ちない。**
  //
  // `getAuthHeaders()` は HTTP の per-request コンテキストが無いと、OS keychain /
  // ファイルに保存された **stdio 用の資格情報** を読みにいく。`tools/list` は
  // Bearer 必須ではない (PROTECTED_METHODS に無い) ので、この分岐が無いと
  // **未認証のリモート要求が、コンテナに置かれたトークンのロールを引き継げる**。
  // 実行環境に stdio のトークンが無ければ実害は出ないが、「無いことに依存した
  // 安全」は環境が変わった日に黙って壊れる。経路そのものを塞ぐ。
  if (mode === 'http' && getHttpAuthContext() === undefined) {
    return { status: 'unauthenticated', reason: 'no-bearer' };
  }

  let headers: Record<string, string>;
  try {
    headers = await getAuthHeaders();
  } catch (err) {
    return classifyError(err);
  }

  const token = bearerTokenOf(headers);
  if (token === undefined) {
    return { status: 'unauthenticated', reason: 'no-token' };
  }

  // ここで読むのは**上流へ送るのと同じトークン**の claim なので、値をすり替える
  // 余地は無い (署名検証はしないが、検証するのは上流 API 側)。claim が無い /
  // 壊れているトークンは、そもそもワークスペースにバインドされていない。
  const workspaceId = decodeJwtPayload(token)?.workspace_id;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    return { status: 'unauthenticated', reason: 'no-workspace-claim' };
  }

  const key = cacheKeyFor(headers['Authorization'] ?? '', workspaceId);
  const now = Date.now();
  pruneCache(now);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.resolution;

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = fetchWorkspaceRole(token, workspaceId)
    .then((resolution) => {
      if (resolution.status === 'resolved') {
        cache.set(key, {
          expiresAt: Date.now() + WORKSPACE_ROLE_CACHE_TTL_MS,
          resolution,
        });
      }
      return resolution;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
};

/** 解決結果から capability 集合を決める (解決できなければ public のみ)。 */
export const capabilitiesFor = (
  resolution: RoleResolution,
): ReadonlySet<WorkspaceCapability> =>
  resolution.status === 'resolved'
    ? capabilitiesForRole(resolution.role)
    : PUBLIC_CAPABILITIES;

/**
 * ツール一覧のフィルタと call ガードが使う唯一の入口。
 * 解決結果も一緒に返すので、拒否の文言とログを status で出し分けられる。
 */
export const resolveWorkspaceAuthorization = async (
  mode: 'stdio' | 'http',
): Promise<WorkspaceAuthorization> => {
  const resolution = await resolveWorkspaceRole(mode);
  return { capabilities: capabilitiesFor(resolution), resolution };
};
