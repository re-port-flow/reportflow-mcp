import * as http from 'http';
import { AddressInfo } from 'net';
import { URL } from 'url';

export type CallbackResult = {
  code: string;
};

export type StartCallbackServerOptions = {
  port: number;
  expectedState: string;
  timeoutMs?: number;
  successHtml?: string;
  // Fires once the server is listening with the actually-bound port. Useful
  // when `port: 0` is passed and the caller needs to know the OS-assigned port.
  onListening?: (port: number) => void;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_SUCCESS_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>Authentication complete</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:64px auto;padding:0 16px;color:#222}
h1{font-size:20px}p{line-height:1.6}</style></head>
<body><h1>認証が完了しました</h1>
<p>このタブを閉じてターミナルに戻ってください。</p></body></html>`;

const FAILURE_HTML = (message: string): string => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>Authentication failed</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:64px auto;padding:0 16px;color:#222}
h1{font-size:20px;color:#c00}p{line-height:1.6}</style></head>
<body><h1>認証に失敗しました</h1>
<p>${message}</p></body></html>`;

type ServerWithClose = http.Server & {
  closeAllConnections?: () => void;
};

// Forcibly drop Keep-Alive connections so server.close() callback fires fast.
const dropKeepAliveConnections = (server: ServerWithClose): void => {
  if (typeof server.closeAllConnections === 'function') {
    try {
      server.closeAllConnections();
    } catch {
      /* ignore */
    }
  }
};

export const startCallbackServer = (
  options: StartCallbackServerOptions,
): Promise<CallbackResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const successHtml = options.successHtml ?? DEFAULT_SUCCESS_HTML;

  return new Promise<CallbackResult>((resolve, reject) => {
    const server: ServerWithClose = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(
          req.url ?? '/',
          `http://localhost:${options.port}`,
        );
        if (reqUrl.pathname !== '/callback') {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }

        const error = reqUrl.searchParams.get('error');
        if (error) {
          const desc = reqUrl.searchParams.get('error_description') ?? error;
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(FAILURE_HTML(`${error}: ${desc}`));
          finish(new Error(`OAuth error: ${error} - ${desc}`));
          return;
        }

        const state = reqUrl.searchParams.get('state');
        const code = reqUrl.searchParams.get('code');
        if (!state || state !== options.expectedState) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(FAILURE_HTML('state パラメータの検証に失敗しました (CSRF)'));
          finish(new Error('state mismatch'));
          return;
        }
        if (!code) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(FAILURE_HTML('authorization code が見つかりません'));
          finish(new Error('missing code'));
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(successHtml);
        finish(null, { code });
      } catch (err) {
        if (!res.writableEnded) {
          try {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Internal Server Error');
          } catch {
            /* ignore — response may already be in a broken state */
          }
        }
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    let finished = false;
    const timer = setTimeout(() => {
      finish(new Error(`Callback server timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(err: Error | null, result?: CallbackResult): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const settle = (): void => {
        if (err) reject(err);
        else if (result) resolve(result);
      };

      // If server.listen() never succeeded (e.g. port conflict, listen error
      // event), calling close() throws ERR_SERVER_NOT_RUNNING. Settle without
      // touching close() in that case.
      if (!server.listening) {
        settle();
        return;
      }

      // Stop accepting new connections; existing in-flight request is allowed
      // to flush its response, then close() callback fires. After that, kick
      // any lingering Keep-Alive sockets so the process is not held open.
      try {
        server.close(() => {
          settle();
          dropKeepAliveConnections(server);
        });
      } catch {
        // Defensive: if close() still throws despite the listening guard,
        // settle anyway so the caller is not stuck.
        settle();
      }
    }

    server.on('error', (err) => finish(err));
    server.listen(options.port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (addr == null) {
        finish(new Error('Failed to bind callback server'));
        return;
      }
      options.onListening?.(addr.port);
    });
  });
};
