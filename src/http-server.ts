import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { isIP } from 'net';
import { createHash, randomUUID } from 'crypto';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  localhostAllowedHostnames,
  PROTOCOL_VERSION_META_KEY,
  validateHostHeader,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { runWithHttpAuth } from './auth-context.js';
import { A2A_ENDPOINT_PATH, buildAgentCard } from './a2a/agent-card.js';
import { handleA2aJsonRpc, type ToolCallOutcome } from './a2a/jsonrpc.js';
import { interpretMcpToolResponse } from './a2a/mcp-response.js';
import {
  REPORTFLOW_CONNECTING_IP_HEADER,
  TRUST_CONNECTING_IP_HEADERS,
} from './client-ip.js';
import {
  buildProtectedResourceMetadata,
  MCP_RESOURCE_URL,
  REPORTFLOW_OAUTH_ISSUER_URL,
  SUPPORTED_SCOPES,
} from './config.js';
import {
  normalizeInboundBody,
  shouldDropProtocolVersionHeader,
} from './protocol-envelope.js';
import {
  callOAuthUpstream,
  errorNameOf,
  resolveAccessServiceAuth,
} from './oauth-upstream.js';
import { createMcpServer } from './server.js';
import {
  resolveWorkspaceAuthorization,
  type WorkspaceAuthorization,
} from './workspace-role.js';
import {
  FAVICON_ICO,
  FAVICON_ICO_CONTENT_TYPE,
  FAVICON_SVG,
  FAVICON_SVG_CONTENT_TYPE,
} from './favicon.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { name: string; version: string };

const DEFAULT_PORT = 3000;

/**
 * A2A の skill を MCP ハンドラへ流すときに名乗るプロトコル版。
 * per-request `_meta` 封筒 (2026-07-28) で送り、initialize を省く。
 */
const A2A_INTERNAL_MCP_PROTOCOL_VERSION = '2026-07-28';

/** Node 既定の requestTimeout を明示する（5 分）。短縮は別タスクで判断する。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
/** keepAliveTimeout < headersTimeout を守る（Node 推奨関係）。 */
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 65_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 70_000;

/** TCP ポートの有効レンジ (1-65535)。 */
const MAX_PORT = 65535;

/**
 * PORT 環境変数値をパースする純関数。
 * - 未設定 / 空文字: `undefined` を返す (startHttpServer が DEFAULT_PORT を使う)。
 * - 整数でない (例: "80abc" / "80.5") / レンジ外 (1-65535): Error を投げる
 *   (呼び出し側で process.exit(1) する)。
 *
 * `parseInt` は "80abc" を 80 として受理してしまうため、`Number()` +
 * `Number.isInteger` で厳格に判定する。index-http.ts のエントリはこの関数への
 * 薄い委譲に留め、バリデーション分岐をここ (テスト可能なユニット) に集約する。
 */
export const parsePort = (portStr: string | undefined): number | undefined => {
  if (!portStr) return undefined;
  const port = Number(portStr.trim());
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(
      `PORT must be an integer in the range 1-${MAX_PORT} (got ${portStr})`,
    );
  }
  return port;
};

// ─── Host / Origin 検証 (MCP spec §Security / PRJ-3-1114) ────────────────────
// MCP Streamable HTTP spec の Security 節 (2025-03-26 以降の全版に同文):
//   "Servers MUST validate the Origin header on all incoming connections to
//    prevent DNS rebinding attacks. If the Origin header is present and
//    invalid, servers MUST respond with HTTP 403 Forbidden"
// 本サーバーの方針 (根拠と脅威モデルの詳細は docs/security.md):
// - Origin は allowlist 化しない。ブラウザ系 MCP クライアント (MCP Inspector =
//   localhost:任意ポート / 各 Web プレイグラウンド = 各自オリジン) は事前列挙
//   不能で、allowlist は正当クライアントを壊す。credentials: false + Bearer-only
//   (Cookie 不使用) のため Origin 反射に実害も無い。「present and invalid → 403」
//   は URL として構造的にパース不能な Origin の拒否として字義どおり充足する。
// - DNS rebinding の実効対策は Host ヘッダー検証で行う (defense-in-depth)。

/**
 * MCP エンドポイントで許可する Host のホスト名一覧。
 * - `MCP_RESOURCE_URL` のホスト (prod: mcp.re-port-flow.com / stg: mcp.stg.re-port-flow.com)
 * - localhost 系 (`localhost` / `127.0.0.1` / `[::1]`): ローカル開発・supertest・
 *   MCP Inspector のローカル起動用。SDK の `localhostAllowedHostnames()` を採用
 *   (自前列挙だと IPv6 ブラケット表記などで SDK の正規化とずれるため)。
 */
const ALLOWED_MCP_HOSTNAMES: string[] = [
  new URL(MCP_RESOURCE_URL).hostname,
  ...localhostAllowedHostnames(),
];

/**
 * Host ヘッダーが MCP エンドポイントで許可されるか判定する純関数。
 * SDK の `validateHostHeader` に委譲する (port-agnostic: `mcp.re-port-flow.com:443`
 * や `localhost:5173` のようなポート付き表記は hostname 一致で許可する。
 * rebinding は攻撃者「ホスト名」で成立するためポートの制限に意味は無く、
 * ALB/プロキシ経由でポート付き Host が来ても壊さない)。
 * Host 欠落 / パース不能もここで false (= 403) にする。
 */
export const isAllowedHost = (host: string | undefined): boolean =>
  validateHostHeader(host, ALLOWED_MCP_HOSTNAMES).ok;

/**
 * RFC 6454 serialized-origin (`scheme "://" host [ ":" port ]`) の raw 文法。
 * - scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
 * - host: ブラケット付き IPv6、または reg-name (unreserved / pct-encoded /
 *   sub-delims)。`/` `?` `#` `@` `:` を含まないことがポイント。
 * - port: 数字のみ (レンジ検証は後段の `new URL` が担う)。
 * WHATWG URL パーサーは `https://x.example/.` → `/` のようにパース中に正規化
 * してしまうため、パース後の成分検査では invalid な形を検出できない。必ず
 * **正規化前の raw 文字列**をこの文法で検証する。
 */
const SERIALIZED_ORIGIN_RE =
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~%!$&'()*+,;=-]+)(:\d{1,5})?$/;

/**
 * Origin として現れ得ないスキーム。WHATWG/ブラウザ実装でこれらの URL の
 * origin は opaque (シリアライズ結果は `null`) になるため、`data://evil` の
 * ように `//host` を付けて raw 文法に一致させても正規の Origin ではない。
 * スキーム名で明示的に拒否する。
 * 対象 = ブラウザで opaque origin になる主要スキーム + IANA 登録済みの
 * 非 authority スキーム。**網羅は狙わない (これが設計上の境界)**: スキーム
 * 空間は開集合で、opaque 側の完全列挙は原理的に不可能。完全にするには
 * 逆の allowlist (http/https/拡張のみ許可) が必要だが、WebView シェル
 * (capacitor:// / tauri:// / app:// / 各社独自スキーム) が送る正規の
 * アプリ内スキーム Origin こそ事前列挙できず壊してしまい、threat model 上
 * (ambient credential なし。docs/security.md) 締める得も無いため不採用
 * (PRJ-3-1114 の「allowlist 不採用」決定のスキーム版)。denylist 外の
 * 未知スキームが通ることは許容し、ここに記録する。
 */
const OPAQUE_ORIGIN_SCHEMES = new Set([
  'data',
  'javascript',
  'vbscript',
  'blob',
  'file',
  'about',
  'filesystem',
  'view-source',
  'mailto',
  'urn',
  'tel',
  'sms',
  'geo',
]);

/**
 * Origin ヘッダーを 403 で拒否すべきか判定する純関数 (構造検証のみ)。
 * - 欠落 (undefined): 許可 (Origin を送らないネイティブクライアント)。
 *   空文字は「present but empty」(Node は空値ヘッダーを '' で公開する) で、
 *   serialized origin でも `null` でもないため文法検査に落ちて 403 になる。
 * - リテラル `null`: 許可 (sandboxed iframe 等の opaque origin。spec 上
 *   「invalid な Origin」ではなく正規のシリアライズ結果。403 化の要否は
 *   PRJ-3-1115 未確定事項で、正規利用が無いと人間が確認するまで許容に倒す)。
 * - serialized origin (RFC 6454) の raw 文法に一致しない値: 拒否 (spec の
 *   "present and invalid → 403")。パース不能な値・path/query/fragment/userinfo
 *   付き・authority 欠落 (`https:example.com` / `foo:` / `file:///`)・空デリミタ
 *   (`https://@x` / `https://x?` / `https://x:`)・末尾スラッシュ・`data:` URL は
 *   すべてここで弾く。文法一致後に `new URL` でパース可能性 (ポートレンジ等)
 *   と、opaque origin にしかなり得ないスキームでないこと
 *   (`OPAQUE_ORIGIN_SCHEMES`: `data://evil` 等の偽装拒否) も確認する。
 * - serialized origin 形の値: すべて許可 (全 Origin 許可ポリシーの維持。
 *   ホスト名での選別はしない)。chrome-extension:// 等の非特殊スキームも
 *   この形なら許可 (拡張ページの fetch は実際にこの形の Origin を送る)。
 * NOTE: SDK の `validateOriginHeader` は allowlist 方式かつ `null` を拒否する
 * 実装のため、本方針 (allowlist 無し / null 許容) では採用できず自前実装とする。
 */
export const isRejectableOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) return false;
  if (origin === 'null') return false;
  if (!SERIALIZED_ORIGIN_RE.test(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return true;
  }
  // url.protocol は正規化済み (小文字 + 末尾 ':')。
  return OPAQUE_ORIGIN_SCHEMES.has(url.protocol.slice(0, -1));
};

/**
 * Host / Origin 検証失敗時の 403 応答。
 * ボディは SDK の `hostHeaderValidationResponse` / `originValidationResponse`
 * と同形の JSON-RPC エラー (code -32000 / id null) に揃える。既存の
 * `{ error: ... }` JSON 形式ではなくこちらを採る理由: (1) MCP クライアントが
 * 解釈できる JSON-RPC エラーである、(2) handleMcp の 500 応答が既に同形、
 * (3) SDK 標準形に揃えることでコンフォーマンス審査に対して説明可能。
 */
const respondForbidden = (res: Response, message: string): void => {
  res.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
};

const PROTECTED_METHODS = new Set(['tools/call', 'prompts/get']);

const wwwAuthenticateHeader = (): string =>
  `Bearer realm="reportflow-mcp", resource_metadata="${MCP_RESOURCE_URL}/.well-known/oauth-protected-resource"`;

const respondUnauthorized = (
  res: Response,
  description: string,
  errorCode: 'invalid_token' | 'invalid_request' = 'invalid_token',
): void => {
  res
    .status(401)
    .set('WWW-Authenticate', wwwAuthenticateHeader())
    .json({ error: errorCode, error_description: description });
};

/**
 * OAuth proxy (`/register` / `/token`) が上流を成功として扱えなかったときの応答。
 *
 * **クライアントへ出すのは汎用の OAuth エラーだけ。** 分類 (`rejection`) や
 * 上流の status・本文は出さない。claude.ai 等の外部クライアントに上流の内部
 * 事情を伝える必要は無く、Access の HTML / ログイン URL が漏れる経路も作らない。
 * 切り分けに要る情報は Cloudflare Workers Logs 側 (oauth-upstream.ts の `logRejection`) にある。
 *
 * status は既存どおり 502。`error: 'server_error'` は RFC 6749 §5.2 の値。
 */
const respondProxyFailure = (res: Response, description: string): void => {
  if (res.headersSent) return;
  res.status(502).json({
    error: 'server_error',
    error_description: description,
  });
};

const extractBearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
};

const requestNeedsAuth = (body: unknown): boolean => {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((msg): boolean => {
    if (!msg || typeof msg !== 'object') return false;
    const method = (msg as { method?: unknown }).method;
    return typeof method === 'string' && PROTECTED_METHODS.has(method);
  });
};

export type HttpServerOptions = {
  port?: number;
  /** リクエスト全体の上限 (ms)。未指定時は DEFAULT_REQUEST_TIMEOUT_MS。 */
  requestTimeoutMs?: number;
  /** keep-alive アイドル上限 (ms)。必ず headersTimeoutMs より小さくする。 */
  keepAliveTimeoutMs?: number;
  /** ヘッダ受信上限 (ms)。keepAliveTimeoutMs より大きくする。 */
  headersTimeoutMs?: number;
} & BuildHttpAppOptions;

export type BuildHttpAppOptions = {
  /**
   * リクエストごとのワークスペース権限解決 (PRJ-3-1584 / ST-3)。
   * 既定は本番の resolver。テストがロールを固定するための差し替え口。
   */
  resolveAuthorization?: () => Promise<WorkspaceAuthorization>;
  /**
   * `/` と `/mcp` のレート制限 (PRJ-3-2258)。未指定時は本番の窓と上限。
   * テストが少ない回数で 429 を踏むための差し替え口。無効化はしない。
   */
  mcpRateLimit?: { windowMs: number; limit: number; ipLimit: number };
  /**
   * 接続元ヘッダを IP のキーに使うか。未指定時は環境変数
   * `TRUST_CONNECTING_IP_HEADERS=1` のときだけ使う。それ以外は `req.ip`。
   */
  trustConnectingIpHeaders?: boolean;
};

/** `/` と `/mcp` が共有する窓。プロセス内メモリなのでインスタンスをまたがない。 */
export const MCP_HTTP_RATE_LIMIT_WINDOW_MS = 60_000;

/** Bearer ごとの上限。本番の Container は最大 2 インスタンスなので実効はおおよそこの 2 倍。 */
export const MCP_HTTP_RATE_LIMIT_MAX = 300;

/**
 * 接続元 IP の上限。Bearer の有無にかかわらず掛ける。乱数 Bearer で枠を
 * 増やす回避と、メモリストアの際限ない増加をここで止める。共有 egress を
 * 1 利用者の枠に潰さないため、Bearer 上限より大きい。本番トラフィックの
 * 実測値ではない。
 */
export const MCP_HTTP_IP_RATE_LIMIT_MAX = 3_000;

const MCP_RATE_LIMIT_BODY = {
  jsonrpc: '2.0' as const,
  error: { code: -32000, message: 'Too many requests' },
  id: null,
};

/**
 * `app.all('/')` と `app.all('/mcp')` に当たるパス。
 * Express 4 の既定（末尾スラッシュを許容し、大文字小文字を区別しない）に合わせる。
 */
const isMcpRateLimitedPath = (path: string): boolean =>
  /^\/(?:mcp)?\/?$/i.test(path);

const headerValue = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) return value[0]?.trim() ?? '';
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * 接続元。`trustHeaders` のときだけ、Worker が写した専用ヘッダ、次に
 * CF-Connecting-IP を見る。どちらも IP でなければ、またはヘッダを信用しない
 * ときは req.ip。カスタム keyGenerator は既定の X-Forwarded-For 検査を
 * 置き換えるので、trust proxy は立てない。`ipKeyGenerator` は IPv6 を /56 に
 * まとめる (関数本体にその呼び出しが必要)。Bearer があってもこのキーは外さない。
 */
const mcpIpRateLimitKey =
  (trustHeaders: boolean) =>
  (req: Request): string => {
    const stamped = trustHeaders
      ? headerValue(req.headers[REPORTFLOW_CONNECTING_IP_HEADER])
      : '';
    const fromCloudflare = trustHeaders
      ? headerValue(req.headers['cf-connecting-ip'])
      : '';
    const raw =
      stamped.length > 0 && isIP(stamped) !== 0
        ? stamped
        : fromCloudflare.length > 0 && isIP(fromCloudflare) !== 0
          ? fromCloudflare
          : (req.ip ?? '');
    return raw.length > 0 ? ipKeyGenerator(raw) : 'unknown';
  };

/** Bearer があるリクエストだけ追加で掛ける、トークン単位のキー。 */
const mcpBearerRateLimitKey = (req: Request): string => {
  const token = extractBearer(req) ?? '';
  return `bearer:${createHash('sha256').update(token).digest('hex')}`;
};

/**
 * Express アプリケーションを構築して返す。listen は呼ばない。
 * テストや埋め込み利用を想定。
 */
export const buildHttpApp = (
  options: BuildHttpAppOptions = {},
): express.Express => {
  const resolveAuthorization =
    options.resolveAuthorization ??
    (() => resolveWorkspaceAuthorization('http'));
  const app = express();

  // Cloudflare Access の Service Auth (staging のみ。詳細は oauth-upstream.ts)。
  // **アプリ生成時に 1 度だけ解決する。** 片方だけ設定された状態をここで
  // 例外にして起動を止める (fail-fast)。リクエスト毎に読むと、誰も通れない
  // 設定のままサーバーが上がり、「設定したのに直らない」で時間を失う。
  const accessServiceAuth = resolveAccessServiceAuth();

  // Host / Origin 検証 (MCP spec §Security)。MCP エンドポイント ('/mcp' と
  // ルート '/') に限定した route-scoped guard として、CORS / body パースより
  // **前**に置く:
  // - CORS middleware は preflight (OPTIONS) を 204 で終端し、express.json は
  //   malformed body を 400 で終端するため、ハンドラ内の検証ではそれらの
  //   リクエストに検証が届かない。spec は "all incoming connections" の検証を
  //   要求しており、MCP エンドポイントの全メソッド・全 body 状態で
  //   「不正 Host / invalid Origin → 403」を一貫させる。
  // - 適用外 (guard を通さないパス): /healthz は Container/プロキシのヘルスチェックがターゲット
  //   IP:port を Host に載せてくるため適用外**必須**。favicon / .well-known
  //   (PRM・AS metadata・openai-apps-challenge) は公開メタデータで rebinding と
  //   無関係のため適用外。OAuth proxy (/authorize /token /register) は
  //   リダイレクト・プロキシ経路を壊さないため適用外 (Bearer 発行前の経路で
  //   ambient credential も無い) (PRJ-3-1115)。
  const mcpEndpointGuard = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!isAllowedHost(req.headers.host)) {
      respondForbidden(
        res,
        `Invalid Host header: ${req.headers.host ?? '(missing)'}`,
      );
      return;
    }
    if (isRejectableOrigin(req.headers.origin)) {
      respondForbidden(
        res,
        `Invalid Origin header: ${req.headers.origin ?? ''}`,
      );
      return;
    }
    next();
  };
  app.all('/mcp', mcpEndpointGuard);
  app.all('/', mcpEndpointGuard);
  // A2A も Bearer で skill を実行するエンドポイントなので、MCP と同じ
  // Host / Origin 検証を CORS / body パースより前に掛ける。
  app.all(A2A_ENDPOINT_PATH, mcpEndpointGuard);

  app.use(
    cors({
      origin: true,
      credentials: false,
      exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        // 2026-07-28 の必須 standard headers (SEP-2243)。ブラウザ発クライアントの
        // preflight を通すために列挙する。
        'Mcp-Method',
        'Mcp-Name',
        'Mcp-Protocol-Version',
        // 旧仕様クライアント互換 (2025-era のセッション / SSE resumability 用)。
        'Mcp-Session-Id',
        'Last-Event-ID',
        // A2A の service parameter (A2A v1.0 §3.2.6 / §9.2)。JSON-RPC binding では
        // HTTP ヘッダーで送られるので、ブラウザ発 A2A クライアントの preflight に要る。
        'A2A-Version',
        'A2A-Extensions',
      ],
    }),
  );
  // `/` と `/mcp` はここでは読まない。同じ parser をレート制限の後段に置く。
  // 先に読むと、上限超過でも最大 4mb を JSON.parse し、壊れた JSON は
  // next(err) で制限ミドルウェアを飛ばすためカウンタに入らない。
  // Express 4 の既定は strict: false・caseSensitive: false なので、
  // ルートは `/mcp/` と `/MCP` にも当たる。スキップも同じ規則にする。
  const mcpJson = express.json({ limit: '4mb' });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isMcpRateLimitedPath(req.path)) {
      next();
      return;
    }
    mcpJson(req, res, next);
  });
  // A2A (JSON-RPC binding) では壊れた JSON を JSON-RPC の Parse error (-32700) で
  // 返す。express.json の既定は HTML の 400 で、A2A クライアントが解釈できない。
  // /mcp 側の挙動は変えない (この path だけに掛ける)。
  app.use(
    A2A_ENDPOINT_PATH,
    (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { type?: unknown }).type === 'entity.parse.failed'
      ) {
        res.status(400).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid JSON payload' },
        });
        return;
      }
      next(err);
    },
  );

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // サービス favicon (mcp.re-port-flow.com)。ブラウザが自動取得する /favicon.ico と
  // モダンブラウザ向けの /favicon.svg を、同梱したブランドアセットから配信する。
  const FAVICON_MAX_AGE_SEC = 86400; // 1 day
  app.get('/favicon.ico', (_req: Request, res: Response) => {
    res
      .set('Content-Type', FAVICON_ICO_CONTENT_TYPE)
      .set('Cache-Control', `public, max-age=${FAVICON_MAX_AGE_SEC}`)
      .send(FAVICON_ICO);
  });
  app.get('/favicon.svg', (_req: Request, res: Response) => {
    res
      .set('Content-Type', FAVICON_SVG_CONTENT_TYPE)
      .set('Cache-Control', `public, max-age=${FAVICON_MAX_AGE_SEC}`)
      .send(FAVICON_SVG);
  });

  // RFC 9728 Protected Resource Metadata
  app.get(
    '/.well-known/oauth-protected-resource',
    (_req: Request, res: Response) => {
      res
        .set('Cache-Control', 'no-cache')
        .json(buildProtectedResourceMetadata());
    },
  );

  // A2A Agent Card (A2A v1.0 §8.2。IANA 登録の well-known URI)。
  // 公開メタデータなので Host 検証の対象外 (PRM と同じ扱い)。
  app.get('/.well-known/agent-card.json', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=3600').json(
      buildAgentCard({
        resourceUrl: MCP_RESOURCE_URL,
        version: pkg.version,
        scopes: SUPPORTED_SCOPES,
      }),
    );
  });

  // ─── ChatGPT Apps (OpenAI Apps SDK) ドメイン所有確認 ──────────────────────
  // App 申請時、OpenAI は GET /.well-known/openai-apps-challenge を叩き、
  // 返ってくる検証トークン (plain text) でドメイン所有を確認する。
  // トークンは OpenAI のデベロッパーダッシュボードで発行され、デプロイ環境
  // (Cloudflare Worker Secret) で OPENAI_APPS_CHALLENGE_TOKEN として渡す。
  // - 設定あり: 200 + text/plain で **トークンそのまま** を返す (JSON/HTML 不可)
  // - 設定なし: 404 (従来どおり) を返し、誤って空ボディで検証を通さない
  // NOTE: MCP server URL が subpath (/mcp) を含んでいても、OpenAI の検証は
  // subpath を除いたルートドメインに対して行うため、ここ (ルート) で配信する。
  app.get(
    '/.well-known/openai-apps-challenge',
    (_req: Request, res: Response) => {
      const token = process.env['OPENAI_APPS_CHALLENGE_TOKEN']?.trim();
      if (!token) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res
        .status(200)
        .set('Content-Type', 'text/plain; charset=utf-8')
        .set('Cache-Control', 'no-cache')
        .send(token);
    },
  );

  // ─── OAuth Proxy ──────────────────────────────────────────────────────────
  // claude.ai 等の MCP クライアントは AS Discovery を経由せず、MCP server URL に
  // 直接 OAuth エンドポイントを叩いてくる実装が多い。このため MCP server で
  // 上流 reposts-api の OAuth endpoints を proxy / redirect する。
  //
  // 認可フロー: AuthorizationCode + PKCE
  // - GET  /.well-known/oauth-authorization-server  → AS metadata を返す
  // - GET  /authorize  → 上流 /oauth/authorize へ 302 リダイレクト
  // - POST /token      → 上流 /oauth/token へ proxy (form / json 両対応、JSON に変換して転送)
  // - POST /register   → 上流 /oauth/register (DCR) へ proxy

  // RFC 8414 Authorization Server Metadata
  app.get(
    '/.well-known/oauth-authorization-server',
    (_req: Request, res: Response) => {
      res.set('Cache-Control', 'no-cache').json({
        issuer: MCP_RESOURCE_URL,
        authorization_endpoint: `${MCP_RESOURCE_URL}/authorize`,
        token_endpoint: `${MCP_RESOURCE_URL}/token`,
        registration_endpoint: `${MCP_RESOURCE_URL}/register`,
        scopes_supported: [...SUPPORTED_SCOPES],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    },
  );

  // /authorize: GET クエリをそのまま上流 /oauth/authorize に 302
  // NOTE: REPORTFLOW_OAUTH_ISSUER_URL が path prefix (/api/v1) を含むため、
  // new URL('/oauth/authorize', issuer) では leading slash で base path が
  // リセットされてしまう。明示的に文字列結合してから URL を作る。
  app.get('/authorize', (req: Request, res: Response) => {
    const upstream = new URL(`${REPORTFLOW_OAUTH_ISSUER_URL}/oauth/authorize`);
    Object.entries(req.query).forEach(([key, value]) => {
      if (typeof value === 'string') upstream.searchParams.set(key, value);
      else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === 'string') upstream.searchParams.append(key, v);
        }
      }
    });
    res.redirect(302, upstream.toString());
  });

  // /token: POST body を上流 /oauth/token に proxy
  // claude.ai は form-encoded で送ってくるが、reposts-api (Fastify) は JSON のみ受け付けるため
  // 常に JSON に変換して転送する。RFC 8707 で resource は repeated key になり得るので
  // 配列は単一要素の場合はスカラーに戻す（reposts-api は string を期待）。
  app.post(
    '/token',
    express.urlencoded({ extended: true }),
    (req: Request, res: Response) => {
      const upstream = new URL(`${REPORTFLOW_OAUTH_ISSUER_URL}/oauth/token`);
      const contentType = req.get('Content-Type') ?? 'application/json';
      const isForm = contentType.includes('application/x-www-form-urlencoded');

      let jsonBody: Record<string, unknown>;
      if (isForm) {
        jsonBody = {};
        for (const [key, value] of Object.entries(
          req.body as Record<string, unknown>,
        )) {
          if (Array.isArray(value)) {
            const strs = value.filter(
              (v): v is string => typeof v === 'string',
            );
            jsonBody[key] = strs.length === 1 ? strs[0] : strs;
          } else if (typeof value === 'string') {
            jsonBody[key] = value;
          }
        }
      } else {
        jsonBody = (req.body as Record<string, unknown>) ?? {};
      }

      // RFC 8707: resource は repeated key になり得る。form 経路では上で正規化済みだが、
      // JSON 経路で `resource: ["..."]` が来た場合もここで単一要素配列をスカラーに戻す
      // (reposts-api は string を期待)。
      if (Array.isArray(jsonBody.resource) && jsonBody.resource.length === 1) {
        jsonBody.resource = jsonBody.resource[0];
      }

      const authorization = req.get('Authorization');

      const handle = async (): Promise<void> => {
        const result = await callOAuthUpstream({
          endpoint: 'token',
          url: upstream.toString(),
          body: JSON.stringify(jsonBody),
          // RFC 6749 §5.1: 成功応答は `access_token` を必ず含む。Access の
          // ログイン HTML・空 body・redirect 後の 200 はこれを持てない。
          //
          // **`token_type` は必須にしない。** 同じ上流エンドポイントを stdio 経路が
          // 消費している `auth.ts` の `TokenResponse` は
          // `{ access_token, refresh_token?, expires_in, scope? }` で
          // **`token_type` を持たない**。必須にすると成功した token 交換を
          // 全部 502 にしてしまう（直すつもりの P1 を別原因で再発させる）。
          requiredField: 'access_token',
          headers: authorization ? { Authorization: authorization } : {},
          accessAuth: accessServiceAuth,
        });

        if (!result.ok) {
          respondProxyFailure(res, 'OAuth token proxy failed');
          return;
        }

        // **Content-Type は上流から写さず `application/json` を明示する。**
        // ここへ来る body は JSON として読めたものだけ (oauth-upstream.ts が
        // 検査済み)。上流の Content-Type を写すと、`text/html` を名乗る
        // 応答をそのままクライアントへ渡す経路が残ってしまう。
        //
        // **`Cache-Control: no-store` は必須** (RFC 6749 §5.1: token を含む応答に
        // MUST)。ヘッダーを自前で組み立てるようになった以上、上流の
        // `Cache-Control` は写らないので、ここで明示しないと `access_token` が
        // キャッシュ制御なしでクライアント側の中間層へ届く。`Pragma: no-cache`
        // も同§が指定する (HTTP/1.0 の中間層向け)。
        res
          .status(result.status)
          .set('Content-Type', 'application/json')
          .set('Cache-Control', 'no-store')
          .set('Pragma', 'no-cache')
          .send(result.body);
      };

      handle().catch((err: unknown) => {
        // callOAuthUpstream は上流の失敗を戻り値で返すので、ここへ来るのは
        // 応答の書き出し等の予期しない失敗だけ。値を出さずに 502 で閉じる。
        console.error(
          `[reportflow-mcp] oauth-proxy token handler failed: ${errorNameOf(err)}`,
        );
        respondProxyFailure(res, 'OAuth token proxy failed');
      });
    },
  );

  // /register: POST body を上流 /oauth/register (RFC 7591 DCR) に proxy
  // MCP issuer と同一ドメインに registration_endpoint を置くことで
  // クライアントのドメインチェックに対応する。
  app.post('/register', (req: Request, res: Response) => {
    const upstream = new URL(`${REPORTFLOW_OAUTH_ISSUER_URL}/oauth/register`);

    const handle = async (): Promise<void> => {
      const result = await callOAuthUpstream({
        endpoint: 'register',
        url: upstream.toString(),
        body: JSON.stringify((req.body as Record<string, unknown>) ?? {}),
        // RFC 7591 §3.2.1: 登録成功応答は `client_id` を必ず含む。これが
        // 「Access のログイン HTML を DCR JSON と解釈できない」の検出点。
        requiredField: 'client_id',
        accessAuth: accessServiceAuth,
      });

      if (!result.ok) {
        respondProxyFailure(res, 'OAuth register proxy failed');
        return;
      }

      // Content-Type を上流から写さない理由は /token 側と同じ。
      //
      // **`no-cache` から `no-store` へ変えた。** DCR の成功応答は
      // `client_secret` / `registration_access_token` を含み得る
      // (RFC 7591 §3.2.1)。`no-cache` は「使う前に再検証せよ」であって
      // **保存自体は許す**ので、資格情報を含む応答には足りない。
      res
        .status(result.status)
        .set('Content-Type', 'application/json')
        .set('Cache-Control', 'no-store')
        .set('Pragma', 'no-cache')
        .send(result.body);
    };

    handle().catch((err: unknown) => {
      console.error(
        `[reportflow-mcp] oauth-proxy register handler failed: ${errorNameOf(err)}`,
      );
      respondProxyFailure(res, 'OAuth register proxy failed');
    });
  });

  // MCP ハンドラ本体 (2026-07-28 + 2025-era の両世代を単一エンドポイントで処理)。
  // - 2026-07-28 (per-request _meta envelope): createMcpHandler が per-request に処理。
  //   server/discover / resultType / ttlMs・cacheScope / Mcp-Method・Mcp-Name 検証も
  //   SDK が担う。
  // - 旧仕様 (initialize 系): 既定の legacy: 'stateless' が従来どおりの stateless
  //   idiom (リクエスト毎の server + transport, sessionIdGenerator: undefined) で処理。
  // Apps SDK widget (ui:// リソース + search の outputTemplate) は ChatGPT App 経路
  // でのみ公開する。ChatGPT App は接続 URL を `?widgets=1` 付きで設定し、claude.ai 等
  // 汎用クライアントは通常 URL で接続する想定。widgets フラグは factory がリクエスト
  // URL のクエリから判定する (ステートレス構成では全 POST に同じクエリが乗るため
  // 判定が安定する)。
  const mcpHandler = createMcpHandler(
    async (ctx) => {
      const enableWidgets =
        ctx.requestInfo != null &&
        new URL(ctx.requestInfo.url).searchParams.get('widgets') === '1';
      // ワークスペース権限をリクエスト単位で解決する (PRJ-3-1584 / ST-3)。
      //
      // factory は `runWithHttpAuth` の AsyncLocalStorage スコープの内側で
      // 呼ばれるので、`resolveWorkspaceAuthorization()` はこのリクエストの
      // Bearer を見る。**stateless な per-request 構成だからこそ**、ここで
      // 解決すれば `tools/list` は常に「今のロール」で組み立てられる
      // (接続時に固定されない = 降格・除籍が次のリクエストで反映される)。
      //
      // Bearer が無いリクエスト (未認証の `tools/list` 等) では解決は
      // `unauthenticated` に落ち、公開ギャラリーツールと静的リソースだけが
      // 見える (ST-1 判断3)。解決結果は 60 秒キャッシュされるため、
      // 1 セッション中に上流へ大量の問い合わせが飛ぶことはない。
      const { capabilities } = await resolveAuthorization();
      return createMcpServer({
        mode: 'http',
        enableWidgets,
        capabilities,
        resolveAuthorization,
      });
    },
    {
      onerror: (err: Error) => console.error('MCP handler error:', err),
    },
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler);

  // ─── A2A (Agent2Agent) JSON-RPC binding ───────────────────────────────────
  // skill は MCP ツールそのもの (src/a2a/skills.ts)。ここでは A2A の
  // SendMessage を **同じプロセスの MCP ハンドラ** へ `tools/call` として流す。
  // 認可 (Bearer → runWithHttpAuth)・ワークスペース権限 (factory の
  // resolveAuthorization)・ツールのガードとテレメトリが MCP クライアントと
  // 完全に同じ経路になり、A2A 専用の実装を二重に持たない。
  const callToolViaMcp = async (
    name: string,
    args: Record<string, unknown>,
    token: string,
  ): Promise<ToolCallOutcome> => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: A2A_INTERNAL_MCP_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {
            name: 'reportflow-a2a',
            version: pkg.version,
          },
        },
      },
    };
    const mcpRequest = new globalThis.Request(`${MCP_RESOURCE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': A2A_INTERNAL_MCP_PROTOCOL_VERSION,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': name,
      },
      body: JSON.stringify(body),
    });
    // 上流がトークンを拒否した (期限切れ・失効・不正) 場合は 401 にする。
    // MCP 経路は Bearer の有無しか見ず、拒否されたトークンは公開ツールだけの
    // 一覧へ落ちるので、そのまま流すと「ツールが無い」FAILED になり、A2A
    // クライアントがトークンを更新するきっかけ (WWW-Authenticate) を失う。
    // 解決結果は 60 秒キャッシュされ、直後の factory 呼び出しでも再利用される。
    const { resolution } = await runWithHttpAuth(
      { accessToken: token },
      resolveAuthorization,
    );
    if (resolution.status === 'unauthenticated') {
      return { kind: 'unauthorized' };
    }
    const mcpResponse = await runWithHttpAuth({ accessToken: token }, () =>
      mcpHandler.fetch(mcpRequest, { parsedBody: body }),
    );
    return interpretMcpToolResponse(
      mcpResponse.status,
      mcpResponse.headers.get('content-type'),
      await mcpResponse.text(),
    );
  };

  app.post(A2A_ENDPOINT_PATH, (req: Request, res: Response) => {
    const token = extractBearer(req);
    const versionHeader = req.get('A2A-Version');
    handleA2aJsonRpc(
      req.body,
      { versionHeader, hasBearer: token !== null },
      {
        // hasBearer=false のときは handleA2aJsonRpc が callTool の前に 401 を返す。
        callTool: (name, args) => callToolViaMcp(name, args, token ?? ''),
        newId: randomUUID,
        now: () => new Date(),
      },
    )
      .then((result) => {
        if (result.kind === 'unauthorized') {
          respondUnauthorized(res, result.description);
          return;
        }
        res.status(200).json(result.body);
      })
      .catch((err: unknown) => {
        console.error(
          `[reportflow-mcp] A2A request handling failed: ${errorNameOf(err)}`,
        );
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          });
        }
      });
  });
  // JSON-RPC binding は POST だけ。それ以外は 405 で明示する (404 だと
  // 「エンドポイントが無い」と区別できない)。
  app.all(A2A_ENDPOINT_PATH, (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' });
  });

  // MCP Streamable HTTP ハンドラ。'/mcp' と '/' の両方に登録する。
  // PRM が広告する resource はルート (https://mcp.re-port-flow.com) であり、
  // RFC 9728 準拠の厳格なクライアント (Smithery / Glama 等) は resource を
  // エンドポイントとみなしてルートへ initialize を POST するため、ルートにも
  // 同じハンドラを置いて 404 を防ぐ。OAuth セマンティクス (resource/audience) は不変。
  const handleMcp = (req: Request, res: Response): void => {
    // 有効な MCP リクエストは POST (JSON-RPC) / SSE 用 GET (Accept: text/event-stream) /
    // DELETE (旧仕様のセッション終了) のみ。ルート '/' はクローラー/ボット/ヘルスチェックの
    // GET を無差別に受けるため、ハンドラに渡す前に早期 404 で弾き、リクエスト毎の
    // McpServer 生成によるリソース枯渇 (DoS) を防ぐ (実クライアントの GET は必ず
    // Accept: text/event-stream を伴うため影響しない)。
    // NOTE: SSE 用 GET / DELETE はハンドラへ渡し、stateless 構成では SDK が 405 を返す
    // (2026-07-28 spec は MCP エンドポイントへの GET / DELETE に 405 を返すことを推奨。
    // GET エンドポイントは廃止され通知は subscriptions/listen に置換、セッションも
    // 廃止。旧仕様クライアントも standalone SSE / terminateSession への 405 は
    // benign として扱う)。
    const isSseGet =
      req.method === 'GET' &&
      (req.headers.accept ?? '').includes('text/event-stream');
    if (req.method !== 'POST' && req.method !== 'DELETE' && !isSseGet) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // NOTE: Host / Origin 検証は buildHttpApp 冒頭の mcpEndpointGuard が
    // CORS / body パースより前に実施済み (ここに到達した時点で検証通過)。

    const token = extractBearer(req);
    const needsAuth = requestNeedsAuth(req.body);

    if (needsAuth && !token) {
      respondUnauthorized(
        res,
        '保護対象メソッドの呼び出しには Bearer トークンが必要です',
      );
      return;
    }

    // 新旧を混ぜた `_meta` エンベロープ (2025 系を名乗る / 必須キー欠落) は
    // SDK が新世代として弾き 400 になるため、エンベロープ主張を外して legacy
    // 経路へ流す。正しい新世代リクエストには触れない (protocol-envelope.ts)。
    const normalized =
      req.method === 'POST'
        ? normalizeInboundBody(req.body)
        : { body: undefined, reasons: [] };
    if (normalized.reasons.length > 0) {
      console.warn(
        `[reportflow-mcp] downgraded malformed envelope to legacy: ${normalized.reasons.join('; ')}`,
      );
      if (
        shouldDropProtocolVersionHeader(req.headers['mcp-protocol-version'])
      ) {
        delete req.headers['mcp-protocol-version'];
      }
    }

    // express.json() がパース済みの body を第3引数で渡す (adapter は stream を再読しない)。
    // Bearer トークンは従来どおり AsyncLocalStorage で tools 層へ伝搬する。
    const handle = async (): Promise<void> => {
      await nodeMcpHandler(req, res, normalized.body);
    };

    const dispatched = token
      ? runWithHttpAuth({ accessToken: token }, handle)
      : handle();

    dispatched.catch((err: unknown) => {
      console.error('MCP request handling failed:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    });
  };
  // CodeQL js/missing-rate-limiting は express-rate-limit の rateLimit() の
  // 戻りを、そのルートのミドルウェアとして渡したときだけガードと認める。
  // `/` を app.use で掛けると配下の全パス (healthz を含む) が対象になるため、
  // ハンドラと同じ app.all にだけ載せる。IP の枠は常に掛け、Bearer の枠は
  // トークンがあるときだけ追加する。`/` と `/mcp` はそれぞれの枠を共有する。
  // JSON パーサはこの制限の後。グローバルな express.json は両パスを読まない。
  const windowMs =
    options.mcpRateLimit?.windowMs ?? MCP_HTTP_RATE_LIMIT_WINDOW_MS;
  const rateLimitBody = {
    message: MCP_RATE_LIMIT_BODY,
    statusCode: 429,
    legacyHeaders: false as const,
    standardHeaders: 'draft-8' as const,
    passOnStoreError: true,
  };
  const mcpIpRateLimit = rateLimit({
    ...rateLimitBody,
    windowMs,
    limit: options.mcpRateLimit?.ipLimit ?? MCP_HTTP_IP_RATE_LIMIT_MAX,
    keyGenerator: mcpIpRateLimitKey(
      options.trustConnectingIpHeaders ??
        process.env[TRUST_CONNECTING_IP_HEADERS] === '1',
    ),
  });
  const mcpBearerRateLimit = rateLimit({
    ...rateLimitBody,
    windowMs,
    limit: options.mcpRateLimit?.limit ?? MCP_HTTP_RATE_LIMIT_MAX,
    skip: (req) => extractBearer(req) === null,
    keyGenerator: mcpBearerRateLimitKey,
  });
  app.all('/mcp', mcpIpRateLimit, mcpBearerRateLimit, mcpJson, handleMcp);
  app.all('/', mcpIpRateLimit, mcpBearerRateLimit, mcpJson, handleMcp);

  // 404 for any other path
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
};

/**
 * Express を listen するエントリ。Docker / Cloudflare Container からの起動を想定。
 * `listen` 成功 (listening イベント) または bind エラー (EADDRINUSE 等) で
 * Promise が settle する。呼び出し側でエラーハンドリング可能。
 */
export const startHttpServer = (
  opts: HttpServerOptions = {},
): Promise<import('http').Server> => {
  const port = opts.port ?? DEFAULT_PORT;
  const requestTimeout = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const keepAliveTimeout =
    opts.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  const headersTimeout = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;

  // Validate before listen. Node rejects negative/non-finite timeout
  // assignments after the server exists, and that throw can race the error
  // listener / leave a bound handle behind.
  for (const [name, value] of [
    ['requestTimeoutMs', requestTimeout],
    ['keepAliveTimeoutMs', keepAliveTimeout],
    ['headersTimeoutMs', headersTimeout],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      return Promise.reject(
        new Error(
          `${name} must be a finite number >= 0 (got ${String(value)})`,
        ),
      );
    }
  }

  // Node は keepAliveTimeout < headersTimeout を推奨する。逆転・同値は
  // keep-alive 接続でヘッダ受信中に切れるため、listen 前に落とす。
  if (keepAliveTimeout >= headersTimeout) {
    return Promise.reject(
      new Error(
        `keepAliveTimeout (${keepAliveTimeout}) must be less than headersTimeout (${headersTimeout})`,
      ),
    );
  }

  // **`buildHttpApp()` は Promise の中で呼ぶ。** 設定不備 (Access の 2 値の
  // 片方だけ) は `buildHttpApp` が同期例外で落とす。ここより外で呼ぶと同期
  // 例外のまま index-http.ts の `.catch` を通り抜け、uncaught でスタックだけが
  // 出る。中で呼べば reject になり、既存の起動失敗ログに乗る。
  return new Promise((resolve, reject) => {
    const app = buildHttpApp(opts);
    const httpServer = app.listen(port);
    httpServer.requestTimeout = requestTimeout;
    httpServer.keepAliveTimeout = keepAliveTimeout;
    httpServer.headersTimeout = headersTimeout;
    let settled = false;

    httpServer.once('listening', () => {
      if (settled) return;
      settled = true;
      console.log(
        `[reportflow-mcp] Streamable HTTP server listening on :${port} (resource=${MCP_RESOURCE_URL}; requestTimeout=${requestTimeout}; keepAliveTimeout=${keepAliveTimeout}; headersTimeout=${headersTimeout})`,
      );

      const shutdown = (signal: string): void => {
        console.log(`[reportflow-mcp] received ${signal}, shutting down`);
        httpServer.close(() => process.exit(0));
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

      resolve(httpServer);
    });

    httpServer.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
};
