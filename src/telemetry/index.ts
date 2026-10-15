export {
  TELEMETRY_SECRET_HEADER,
  TELEMETRY_DEFAULT_TIMEOUT_MS,
  createTelemetryClient,
  telemetryClientFromEnv,
} from './client.js';
export type {
  TelemetryClient,
  TelemetryClientOptions,
  TelemetryEvent,
  TelemetryProperties,
  TelemetryPropertyValue,
} from './client.js';
export { withTelemetry } from './interceptor.js';

// ギャラリー需要計測 (PRJ-3-1350) はこの barrel から再輸出しない。
// TypeScript の再輸出は CommonJS 上で 1 export = 1 getter 関数にコンパイルされ、
// 誰も barrel 経由で触らない export を足すと関数カバレッジだけが落ちる
// (unit テストは実装モジュールを直接 import するため)。唯一の利用者である
// server.ts から `./telemetry/gallery-demand.js` を直接 import する。
