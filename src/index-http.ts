import { parsePort, startHttpServer } from './http-server.js';

let port: number | undefined;
try {
  port = parsePort(process.env['PORT']);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

startHttpServer({ port }).catch((err: unknown) => {
  console.error('[reportflow-mcp] Failed to start HTTP server:', err);
  process.exit(1);
});
