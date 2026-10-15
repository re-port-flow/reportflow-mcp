// `integration.mcp.*` イベントへ MCP クライアント種別を付ける薄いラッパ
// (PRJ-3-1438 / ST-1)。
//
// ## なぜ TelemetryClient を包むのか
//
// `withTelemetry` (interceptor) は server.ts の 15 箇所以上から呼ばれている。
// client 情報を引数で足すと全呼び出し側を触ることになり、差分がレビューしづらい。
// **client の解決は「どのツールか」に依らない**ので、interceptor ではなく
// TelemetryClient 側で一度だけ包む。呼び出し側は 1 行も変わらない。
//
// ## 付ける対象を絞る理由
//
// gallery 系イベント (`integration.mcp.gallery.searched` / `.copied`) は
// Notion「Event Telemetry Schema」§3.4 が properties を定義しており、
// **仕様に無い property を勝手に足さない** (§8 の追加手順を踏む)。
// ここでは ST-1 が必要としている 2 つにだけ付ける。
//
// ## 遅延解決にする理由
//
// `getClientInfo` は呼び出しのたびに評価する。initialize ハンドシェイクは
// server 生成より後に完了するので、生成時点で読むと必ず undefined になる。
//
// ## HTTP モードでは種別が取れないことがある（`other` を「未識別」と読むこと）
//
// HTTP はステートレス構成で、`createMcpHandler` がリクエストごとに
// `createMcpServer` を呼ぶ (`http-server.ts`)。つまり `tools/call` を処理する
// インスタンスは `initialize` を見ていない。SDK は 2026-07-28 era の
// per-request `_meta` 封筒に載る clientInfo からこれを埋め直すが
// (`seedClientIdentityFromEnvelope`。実装は
// `@modelcontextprotocol/server` の `dist/index.cjs` で確認)、
// **旧 era の legacy stateless 経路には封筒が無く、埋め直しも起きない**。
//
// したがって HTTP 経由の `client` は「クライアントが 2026-07-28 era で
// clientInfo を送ってきたかどうか」に依存し、送らないクライアントは
// `client: 'other'` / `clientName` 無しになる。**`other` の件数を
// 「その他のクライアント」と読まないこと** — 未識別が混ざる。
//
// User-Agent 等から補完する案は採らなかった: 本番でどの era が使われているかを
// このコードからは観測できず、必要かどうかの根拠が無いまま property を 1 つ
// 増やすことになる。デプロイ後、HTTP 由来の行がすべて `other` になるかどうかで
// 判断できる（そのとき初めて実測が根拠になる）。

import type {
  TelemetryClient,
  TelemetryEvent,
  TelemetryProperties,
} from './client.js';
import { classifyMcpClient, hasMcpClientName } from './client-kind.js';
import { MCP_INVOKED_EVENT } from './interceptor.js';
import { MCP_CONNECTED_EVENT } from './connected.js';

/**
 * client 種別を付けるイベント。ここに無いものは素通しする。
 *
 * **名前は発行側の定数から取る。** ここでリテラルを書き直すと、発行側の綴りが
 * 変わったときに一致が外れて client 種別が黙って付かなくなる (落ちないので
 * 集計側からは「どのクライアントからも来ていない」と読めてしまう)。
 */
export const CLIENT_TAGGED_EVENTS: ReadonlySet<string> = new Set([
  MCP_INVOKED_EVENT,
  MCP_CONNECTED_EVENT,
]);

/**
 * initialize でクライアントが名乗った `Implementation` を返す関数。
 * まだハンドシェイクが済んでいなければ undefined。
 */
export type ClientInfoResolver = () => { name?: unknown } | undefined;

/**
 * `client`（種別）を properties に足した TelemetryClient を返す。
 * 種別を判定できず、かつクライアントが名前を名乗っていたときは
 * `clientNameOmitted: true` も足す。**実名そのものは載せない。**
 *
 * **既に入っている properties は上書きしない** — 呼び出し側が意図して
 * 入れた値を、ラッパが黙って別の値に差し替えるのは事故のもと。
 */
export const withClientContext = (
  base: TelemetryClient,
  getClientInfo: ClientInfoResolver,
): TelemetryClient => ({
  track(event: TelemetryEvent): void {
    if (!CLIENT_TAGGED_EVENTS.has(event.event)) {
      base.track(event);
      return;
    }

    // 解決の失敗で telemetry を落とさない (interceptor と同じ方針)。
    let info: { name?: unknown } | undefined;
    try {
      info = getClientInfo();
    } catch {
      info = undefined;
    }

    const existing: TelemetryProperties = event.properties ?? {};
    const added: TelemetryProperties = {};
    if (existing.client === undefined) {
      added.client = classifyMcpClient(info?.name);
    }
    // **実名は載せない**（client-kind.ts の設計要点 3）。載せるのは
    // 「種別を判定できないクライアントが名前を名乗ってきた」という事実だけ。
    // これが無いと `other` の中身が「ハンドシェイク前」と「未知のクライアント」の
    // どちらなのか分からず、PATTERNS を育てる手掛かりが消える
    // （§11.2 の `slugOmitted` と同じ考え方）。
    if (
      existing.clientNameOmitted === undefined &&
      added.client === 'other' &&
      hasMcpClientName(info?.name)
    ) {
      added.clientNameOmitted = true;
    }

    base.track({ ...event, properties: { ...existing, ...added } });
  },
  flush: () => base.flush(),
});
