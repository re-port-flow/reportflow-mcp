#!/usr/bin/env node
import { startServer } from './server.js';

try {
  startServer();
} catch (err: unknown) {
  console.error(err);
  process.exit(1);
}
