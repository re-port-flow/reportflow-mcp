import { startHttpServer } from './http-server.js';

const portStr = process.env['PORT'];
const port = portStr ? parseInt(portStr, 10) : undefined;
if (port !== undefined && (Number.isNaN(port) || port <= 0)) {
  console.error(`PORT must be a positive integer (got ${portStr})`);
  process.exit(1);
}

startHttpServer({ port }).catch((err: unknown) => {
  console.error('[reportflow-mcp] Failed to start HTTP server:', err);
  process.exit(1);
});
