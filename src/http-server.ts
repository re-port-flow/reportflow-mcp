import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import {
  createMcpHandler,
  localhostAllowedHostnames,
  validateHostHeader,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { runWithHttpAuth } from './auth-context.js';
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
import { createMcpServer } from './server.js';
import {
  FAVICON_ICO,
  FAVICON_ICO_CONTENT_TYPE,
  FAVICON_SVG,
  FAVICON_SVG_CONTENT_TYPE,
} from './favicon.js';

const DEFAULT_PORT = 3000;

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

const PROTECTED_METHODS = new Set([
  'tools/call',
  'resources/read',
  'resources/list',
  'prompts/get',
]);

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
};

/**
 * Express アプリケーションを構築して返す。listen は呼ばない。
 * テストや埋め込み利用を想定。
 */
export const buildHttpApp = (): express.Express => {
  const app = express();

  // Host / Origin 検証 (MCP spec §Security)。MCP エンドポイント ('/mcp' と
  // ルート '/') に限定した route-scoped guard として、CORS / body パースより
  // **前**に置く:
  // - CORS middleware は preflight (OPTIONS) を 204 で終端し、express.json は
  //   malformed body を 400 で終端するため、ハンドラ内の検証ではそれらの
  //   リクエストに検証が届かない。spec は "all incoming connections" の検証を
  //   要求しており、MCP エンドポイントの全メソッド・全 body 状態で
  //   「不正 Host / invalid Origin → 403」を一貫させる。
  // - 適用外 (guard を通さないパス): /healthz は ALB ヘルスチェックがターゲット
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
      ],
    }),
  );
  app.use(express.json({ limit: '4mb' }));

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

  // ─── ChatGPT Apps (OpenAI Apps SDK) ドメイン所有確認 ──────────────────────
  // App 申請時、OpenAI は GET /.well-known/openai-apps-challenge を叩き、
  // 返ってくる検証トークン (plain text) でドメイン所有を確認する。
  // トークンは OpenAI のデベロッパーダッシュボードで発行され、デプロイ環境
  // (ECS Task Definition) で OPENAI_APPS_CHALLENGE_TOKEN として渡す。
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
        const upstreamRes = await fetch(upstream.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body: JSON.stringify(jsonBody),
        });
        const text = await upstreamRes.text();
        res
          .status(upstreamRes.status)
          .set(
            'Content-Type',
            upstreamRes.headers.get('content-type') ?? 'application/json',
          )
          .send(text);
      };

      handle().catch((err: unknown) => {
        console.error('OAuth token proxy failed:', err);
        if (!res.headersSent) {
          res.status(502).json({
            error: 'server_error',
            error_description: 'OAuth token proxy failed',
          });
        }
      });
    },
  );

  // /register: POST body を上流 /oauth/register (RFC 7591 DCR) に proxy
  // MCP issuer と同一ドメインに registration_endpoint を置くことで
  // クライアントのドメインチェックに対応する。
  app.post('/register', (req: Request, res: Response) => {
    const upstream = new URL(`${REPORTFLOW_OAUTH_ISSUER_URL}/oauth/register`);

    const handle = async (): Promise<void> => {
      const upstreamRes = await fetch(upstream.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify((req.body as Record<string, unknown>) ?? {}),
      });
      const text = await upstreamRes.text();
      res
        .status(upstreamRes.status)
        .set(
          'Content-Type',
          upstreamRes.headers.get('content-type') ?? 'application/json',
        )
        .set('Cache-Control', 'no-cache')
        .send(text);
    };

    handle().catch((err: unknown) => {
      console.error('OAuth register proxy failed:', err);
      if (!res.headersSent) {
        res.status(502).json({
          error: 'server_error',
          error_description: 'OAuth register proxy failed',
        });
      }
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
    (ctx) => {
      const enableWidgets =
        ctx.requestInfo != null &&
        new URL(ctx.requestInfo.url).searchParams.get('widgets') === '1';
      return createMcpServer({ mode: 'http', enableWidgets });
    },
    {
      onerror: (err: Error) => console.error('MCP handler error:', err),
    },
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler);

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
  app.all('/mcp', handleMcp);
  app.all('/', handleMcp);

  // 404 for any other path
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
};

/**
 * Express を listen するエントリ。Docker / ECS Fargate からの起動を想定。
 * `listen` 成功 (listening イベント) または bind エラー (EADDRINUSE 等) で
 * Promise が settle する。呼び出し側でエラーハンドリング可能。
 */
export const startHttpServer = (
  opts: HttpServerOptions = {},
): Promise<void> => {
  const port = opts.port ?? DEFAULT_PORT;
  const app = buildHttpApp();

  return new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(port);
    let settled = false;

    httpServer.once('listening', () => {
      if (settled) return;
      settled = true;
      console.log(
        `[reportflow-mcp] Streamable HTTP server listening on :${port} (resource=${MCP_RESOURCE_URL})`,
      );

      const shutdown = (signal: string): void => {
        console.log(`[reportflow-mcp] received ${signal}, shutting down`);
        httpServer.close(() => process.exit(0));
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

      resolve();
    });

    httpServer.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
};
