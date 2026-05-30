import express, { Request, Response } from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { runWithHttpAuth } from './auth-context.js';
import {
  buildProtectedResourceMetadata,
  MCP_RESOURCE_URL,
  REPORTFLOW_OAUTH_ISSUER_URL,
  SUPPORTED_SCOPES,
} from './config.js';
import { createMcpServer } from './server.js';

const DEFAULT_PORT = 3000;

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

  app.use(
    cors({
      origin: true,
      credentials: false,
      exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Mcp-Session-Id',
        'Mcp-Protocol-Version',
        'Last-Event-ID',
      ],
    }),
  );
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
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

  app.all('/mcp', (req: Request, res: Response) => {
    const token = extractBearer(req);
    const needsAuth = requestNeedsAuth(req.body);

    if (needsAuth && !token) {
      respondUnauthorized(
        res,
        '保護対象メソッドの呼び出しには Bearer トークンが必要です',
      );
      return;
    }

    // Stateless: per-request server + transport (claude.ai / API connector も stateless モードを推奨)
    const server = createMcpServer({ mode: 'http' });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    const handle = async (): Promise<void> => {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body as JSONRPCMessage);
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
  });

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
