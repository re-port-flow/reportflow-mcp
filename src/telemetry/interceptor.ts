// Wraps MCP tool handlers with fire-and-forget telemetry.
//
// Emits `integration.mcp.invoked` after every tool call (success or failure):
//   success: { tool, durationMs, success }
//   failure: { tool, durationMs, success, errorClass, upstreamRequestCount,
//              upstreamFailureCount, lastUpstreamErrorClass?,
//              lastUpstreamStatus? }
// Never mutates the handler return value, so existing callers see identical
// behavior.
//
// workspace の帰属規則は `telemetry/workspace.ts` 冒頭のコメントを参照。
// 失敗イベントに載せる上流の観測値は `telemetry/upstream.ts` 冒頭を参照。

import type { TelemetryClient, TelemetryProperties } from './client.js';
import {
  buildUpstreamProperties,
  createInvocationUpstream,
  errorClassOf,
  runWithInvocationUpstream,
  type InvocationUpstream,
} from './upstream.js';
import {
  resolveInvocationWorkspaceId,
  runWithInvocationWorkspace,
  type InvocationWorkspace,
} from './workspace.js';

/**
 * ツール呼び出しイベント名。`telemetry/client-context.ts` がこの名前で
 * client 種別を付ける対象を選ぶので、**リテラルを二重に書かない**
 * (綴りがずれると client 種別が黙って付かなくなる)。
 * gallery-demand.ts が `GALLERY_*_EVENT` を名前付きで持つのと同じ扱い。
 */
export const MCP_INVOKED_EVENT = 'integration.mcp.invoked';

type ToolHandler<I, R> = (input: I) => Promise<R>;

type ToolResultLike = {
  isError?: boolean;
  [key: string]: unknown;
};

/**
 * 帰属先の解決関数。テストから差し替えられるよう注入可能にする。
 *
 * 同期関数であることが重要 — telemetry の解決でツール応答を待たせない
 * (keychain / ファイル I/O はここでは行わない)。
 */
export type WorkspaceIdResolver = (
  invocation: InvocationWorkspace,
) => string | undefined;

const inferErrorClass = (
  result: unknown,
  error: unknown,
): string | undefined => {
  // クラス名の抽出は `upstream.ts` の `errorClassOf` が唯一の定義
  // (形の検査つき。テレメトリへ自由記述を流さないため)。
  if (error instanceof Error) return errorClassOf(error);
  if (typeof error === 'string') return 'Error';
  const r = result as ToolResultLike | undefined;
  if (r?.isError) return 'ToolError';
  return undefined;
};

/**
 * 失敗イベントにだけ載せる properties。
 *
 * `errorClass` は「ツールがどう失敗を表現したか」しか言わない —— `isError: true`
 * を返す経路（**全ツールの通常の失敗経路**）では常に定数 `'ToolError'` になり、
 * 情報量がゼロだった。そこへ「この呼び出し中に観測できた上流の失敗」を足す。
 *
 * **成功イベントには載せない。** 上流エラーから回復して成功した呼び出し
 * （401 → refresh → 再送）で観測値を載せると、成功行に失敗の痕跡が並び、
 * 集計側が「成功だが上流は失敗していた」という解釈の要らない区別を持つことになる。
 */
const failureProperties = (
  result: unknown,
  error: unknown,
  upstream: InvocationUpstream,
): TelemetryProperties => ({
  errorClass: inferErrorClass(result, error) ?? 'Error',
  ...buildUpstreamProperties(upstream),
});

export const withTelemetry = <I, R extends ToolResultLike>(
  client: TelemetryClient,
  toolName: string,
  handler: ToolHandler<I, R>,
  resolveWorkspace: WorkspaceIdResolver = resolveInvocationWorkspaceId,
): ToolHandler<I, R> => {
  return async (input: I): Promise<R> => {
    const startedAt = Date.now();

    // この呼び出しが認証に使った資格情報を受け取るスロット。ハンドラ内の auth 層
    // (`recordCredentialWorkspace`) が書き込む。
    const invocation: InvocationWorkspace = {};

    // この呼び出し中に観測した上流 API の失敗を受け取るスロット。ハンドラ内の
    // HTTP 層 (`http.ts` の `request`) が書き込む。
    const upstream = createInvocationUpstream();

    // 例外は握って undefined に落とす — telemetry の失敗でツールを壊さない。
    const resolveSafely = (): string | undefined => {
      try {
        return resolveWorkspace(invocation);
      } catch {
        return undefined;
      }
    };

    try {
      const result = await runWithInvocationWorkspace(invocation, () =>
        runWithInvocationUpstream(upstream, () => handler(input)),
      );
      client.track({
        event: MCP_INVOKED_EVENT,
        // 成功した呼び出しにのみ workspace を付ける (PRJ-3-1117)。
        // HTTP モードの workspace_id は**署名検証していない** Bearer JWT の claim
        // で、`handleMcp` は Bearer の存在しか見ない。失敗イベントにも載せると、
        // 未認証の第三者が任意のワークスペース宛に `integration.mcp.invoked` を
        // 注入でき、本番指標を汚染できてしまう。成功 = 上流 API がその Bearer を
        // 受理した、なので成功だけ帰属すればこの経路は閉じる。
        // 月次コホート分類は success=true の行だけを見るため影響しない
        // (developer-docs `Notion「MCP コホート月次集計」(https://app.notion.com/p/3bc2873e44e4813d899ed7eb74e1f3d4)` §3.1 / §6.3)。
        workspaceId: result.isError ? undefined : resolveSafely(),
        // Stamp client-side ingest time so events from clock-skewed clients
        // remain orderable in Analytics Engine (matches schema §6).
        timestamp: Date.now(),
        properties: {
          tool: toolName,
          durationMs: Date.now() - startedAt,
          success: !result.isError,
          ...(result.isError
            ? failureProperties(result, undefined, upstream)
            : {}),
        },
      });
      return result;
    } catch (err) {
      client.track({
        event: MCP_INVOKED_EVENT,
        // throw = 失敗。上と同じ理由で workspace は付けない。
        timestamp: Date.now(),
        properties: {
          tool: toolName,
          durationMs: Date.now() - startedAt,
          success: false,
          ...failureProperties(undefined, err, upstream),
        },
      });
      throw err;
    }
  };
};
