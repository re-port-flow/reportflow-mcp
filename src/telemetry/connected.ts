// `integration.mcp.connected` — ST-1 の `mcp_connected` (PRJ-3-1438)。
//
// ## 何を「接続」と数えるか
//
// **stdio モードの OAuth 完了だけ**を数える。`authenticate` ツールが
// `authorize()` を完走した時点 = トークン交換が成功した時点で 1 回送る。
//
// ## HTTP モードで送らない理由（0 件は「接続が無い」ではない）
//
// HTTP は**ステートレス構成**で、`createMcpHandler` のファクトリがリクエストごとに
// `createMcpServer` を呼ぶ (`http-server.ts`)。したがって `initialize` は
// 「接続 1 回」に対応せず、そこで送ると接続数を水増しする。
//
// さらに HTTP の workspace は**署名検証していない** Bearer JWT の claim で、
// `handleMcp` は Bearer の存在しか見ない。接続イベントに帰属を付けると、
// 未認証の第三者が任意のワークスペース宛に接続イベントを注入できる
// (`telemetry/interceptor.ts` が失敗イベントに帰属を付けない理由と同じ / PRJ-3-1117)。
//
// **つまり HTTP 経路の接続数はこのイベントでは出ない。** 集計側
// (`report-flow` の `tools/telemetry/mcp-funnel.mjs`) は初回のツール呼び出しを
// 代理指標にしているが、あれは接続そのものではない。HTTP の接続を数えるには
// セッションストアか認可サーバー側の計測が要る（別タスク）。

import type { TelemetryClient } from './client.js';

export const MCP_CONNECTED_EVENT = 'integration.mcp.connected';

export type TrackMcpConnectedOptions = {
  /** OAuth で確定したワークスペース。取得できなければ付けない。 */
  workspaceId?: string;
};

/**
 * 接続イベントを 1 回送る。
 *
 * 送信は fire-and-forget (`client.track`) だが、payload の組み立てで throw する
 * 余地を残さないためここでも握る。**計測の失敗でツール応答を壊さない。**
 */
export const trackMcpConnected = (
  client: TelemetryClient,
  options: TrackMcpConnectedOptions = {},
): void => {
  try {
    client.track({
      event: MCP_CONNECTED_EVENT,
      timestamp: Date.now(),
      // 空文字は渡さない (collector は未設定と同じ空文字を blob3 に書くので、
      // 意味は同じだが「付けた」と誤読される)。gallery-demand.ts と同じ扱い。
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      properties: {
        // stdio の OAuth 完了だけを送っているので固定。将来 HTTP 経路を足すときに
        // 混ざらないよう、最初から区別できる形にしておく。
        via: 'oauth',
      },
    });
  } catch {
    // 意図的に無視する (計測は応答に影響させない)
  }
};
