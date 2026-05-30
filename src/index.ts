import { startServer } from './server.js';

startServer().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
