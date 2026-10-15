import { runWithHttpAuth } from '../auth-context.js';
import type { TelemetryClient, TelemetryEvent } from './client.js';
import { withTelemetry } from './interceptor.js';
import { recordUpstreamFailure, recordUpstreamRequest } from './upstream.js';
import { recordCredentialWorkspace } from './workspace.js';

class RecordingClient implements TelemetryClient {
  events: TelemetryEvent[] = [];
  track(event: TelemetryEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
}

/**
 * 既定の resolver は認証コンテキスト (HTTP の Bearer / 資格情報の記録) を読む。
 * テストではそれを踏ませないよう明示的に注入する。
 */
const noWorkspace = (): string | undefined => undefined;

const ok = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

describe('withTelemetry', () => {
  it('emits integration.mcp.invoked with success=true on normal return', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'list_templates',
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      noWorkspace,
    );

    await wrapped({});

    expect(client.events).toHaveLength(1);
    expect(client.events[0].event).toBe('integration.mcp.invoked');
    expect(client.events[0].properties?.tool).toBe('list_templates');
    expect(client.events[0].properties?.success).toBe(true);
    expect(client.events[0].properties?.errorClass).toBeUndefined();
    expect(typeof client.events[0].properties?.durationMs).toBe('number');
  });

  it('emits success=false + errorClass when result.isError is true', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'generate_pdf_sync',
      async () => ({
        isError: true as const,
        content: [{ type: 'text' as const, text: 'boom' }],
      }),
      noWorkspace,
    );

    await wrapped({});

    expect(client.events[0].properties?.success).toBe(false);
    expect(client.events[0].properties?.errorClass).toBe('ToolError');
  });

  it('emits success=false + Error class name on thrown errors and rethrows', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'authenticate',
      async () => {
        throw new TypeError('nope');
      },
      noWorkspace,
    );

    await expect(wrapped({})).rejects.toThrow('nope');
    expect(client.events[0].properties?.success).toBe(false);
    expect(client.events[0].properties?.errorClass).toBe('TypeError');
  });

  // Error でも文字列でもない値を throw する経路。クラス名を名乗れないので
  // `'Error'` に落ちる (テレメトリへ任意の値を流さないため)。
  it('falls back to Error for thrown values that are not Errors', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'list_templates',
      async () => {
        throw { code: 1 };
      },
      noWorkspace,
    );

    await expect(wrapped({})).rejects.toEqual({ code: 1 });
    expect(client.events[0].properties?.errorClass).toBe('Error');
  });

  it('omits workspaceId when the auth context provides none', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', ok, noWorkspace);

    await wrapped({});

    expect(client.events[0].workspaceId).toBeUndefined();
  });

  // PRJ-3-1093: workspace はツール入力ではなく認証コンテキストに属する。
  // ここが空のままだと MCP 経由の利用をワークスペース単位で集計できない。
  it('attaches the workspaceId resolved from the auth context', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'generate_pdf_sync',
      ok,
      () => '0eLHZZ8PxpU4Z5r7',
    );

    await wrapped({});

    expect(client.events[0].workspaceId).toBe('0eLHZZ8PxpU4Z5r7');
  });

  // PRJ-3-1117 (仕様変更): 以前はツール入力の workspaceId を最優先していたが、
  // 帰属は認証コンテキストのみから決めるようにした。入力は呼び出し側が申告する
  // 値であり、他ワークスペース宛のイベントを作れてしまう (今日 `workspaceId` を
  // 入力に持つツールは無いので、本番挙動は変わらない)。
  it('ignores a workspaceId supplied in the tool input', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'list_templates',
      ok,
      () => 'from-auth-context',
    );

    await wrapped({ workspaceId: 'from-input' });

    expect(client.events[0].workspaceId).toBe('from-auth-context');
  });

  it('does not fall back to the tool input when the auth context has none', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', ok, noWorkspace);

    await wrapped({ workspaceId: 'from-input' });

    expect(client.events[0].workspaceId).toBeUndefined();
  });

  it('always calls the resolver, even when the input carries a workspaceId', async () => {
    const client = new RecordingClient();
    let calls = 0;
    const wrapped = withTelemetry(client, 'list_templates', ok, () => {
      calls += 1;
      return 'from-auth-context';
    });

    await wrapped({ workspaceId: 'from-input' });

    expect(calls).toBe(1);
    expect(client.events[0].workspaceId).toBe('from-auth-context');
  });

  // PRJ-3-1117 (仕様変更): 以前は失敗イベントにも workspace を付けていた。
  // HTTP モードの workspace_id は署名検証していない Bearer JWT の claim で、
  // 上流 API が拒否するまでは通るため、未認証の第三者が任意のワークスペース宛に
  // イベントを注入できてしまう。理由の詳細は interceptor.ts のコメント。
  it('omits the workspaceId when the tool returns isError', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'generate_pdf_sync',
      async () => ({
        isError: true as const,
        content: [{ type: 'text' as const, text: 'boom' }],
      }),
      () => '0eLHZZ8PxpU4Z5r7',
    );

    await wrapped({});

    expect(client.events[0].workspaceId).toBeUndefined();
    expect(client.events[0].properties?.success).toBe(false);
  });

  it('omits the workspaceId when the tool throws', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'generate_pdf_sync',
      async () => {
        throw new Error('boom');
      },
      () => '0eLHZZ8PxpU4Z5r7',
    );

    await expect(wrapped({})).rejects.toThrow('boom');
    expect(client.events[0].workspaceId).toBeUndefined();
    expect(client.events[0].properties?.success).toBe(false);
  });

  // telemetry の解決失敗でツール実行を壊さないこと。
  it('still emits (without workspaceId) when the resolver throws', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', ok, () => {
      throw new Error('auth context unavailable');
    });

    const result = await wrapped({});

    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(client.events).toHaveLength(1);
    expect(client.events[0].workspaceId).toBeUndefined();
    expect(client.events[0].properties?.success).toBe(true);
  });

  // 解決は同期・I/O 無しであること (Codex P2)。ハンドラ完了後に
  // await が挟まると、遅い keychain 等でツール応答が止まる。
  it('resolves the workspace synchronously after the handler settles', async () => {
    const client = new RecordingClient();
    let resolvedAt = 0;
    let handlerFinishedAt = 0;

    const wrapped = withTelemetry(
      client,
      'list_templates',
      async () => {
        handlerFinishedAt = Date.now();
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
      () => {
        resolvedAt = Date.now();
        return 'ws';
      },
    );

    await wrapped({});

    expect(resolvedAt).toBeGreaterThanOrEqual(handlerFinishedAt);
    expect(client.events[0].workspaceId).toBe('ws');
  });
});

// 既定の resolver + 実物の `recordCredentialWorkspace` で本番配線を通す
// (auth.ts の `rememberWorkspace` がこの関数を呼ぶ)。
describe('withTelemetry — 資格情報からの帰属 (既定の resolver)', () => {
  it('この呼び出しが読んだ資格情報の workspace を載せる (cold start を含む)', async () => {
    const client = new RecordingClient();
    // 起動直後の stdio プロセスでは、ハンドラ内の `getAuthHeaders()` で初めて
    // 資格情報が読まれる。開始時点を見る実装だと初回呼び出しが未帰属になる。
    const wrapped = withTelemetry(client, 'list_templates', async () => {
      recordCredentialWorkspace('ws-A');
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    });

    await wrapped({});

    expect(client.events[0].workspaceId).toBe('ws-A');
  });

  it('資格情報を読まずに成功した呼び出しは未帰属', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'list_templates', ok);

    await wrapped({});

    expect(client.events[0].workspaceId).toBeUndefined();
  });

  // `authenticate force=true`: 破棄 → OAuth 交換 → 新 workspace 保存。
  // 401 リトライ: 拒否された資格情報 → refresh した資格情報。
  it('呼び出し中に資格情報が切り替わったら最後に確立された workspace を載せる', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(client, 'authenticate', async () => {
      recordCredentialWorkspace(undefined);
      recordCredentialWorkspace('ws-B');
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    });

    await wrapped({});

    expect(client.events[0].workspaceId).toBe('ws-B');
  });

  // HTTP モードは per-request の Bearer が答え (資格情報の記録は使わない)。
  // 解決はハンドラ完了後に行うため、その時点でもリクエストの ALS コンテキストが
  // 生きていることを固定する。
  it('HTTP モードではリクエストの Bearer から帰属先を決める', async () => {
    const client = new RecordingClient();
    const payload = Buffer.from(
      JSON.stringify({ workspace_id: 'from-bearer' }),
    ).toString('base64url');
    const wrapped = withTelemetry(client, 'search', ok);

    await runWithHttpAuth({ accessToken: `header.${payload}.sig` }, () =>
      wrapped({}),
    );

    expect(client.events[0].workspaceId).toBe('from-bearer');
  });

  it('並行呼び出しの帰属先が互いに混ざらない', async () => {
    const client = new RecordingClient();

    // 「A が資格情報を読む → B が別ワークスペースを確立する → A が完了する」の順に
    // なるよう待ち合わせる。プロセス幅のキャッシュを見る実装だと A が B に付く。
    let releaseA = (): void => {};
    const aCanFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const toolA = withTelemetry(client, 'tool_a', async () => {
      recordCredentialWorkspace('ws-A');
      await aCanFinish;
      return { content: [{ type: 'text' as const, text: 'a' }] };
    });
    const toolB = withTelemetry(client, 'tool_b', async () => {
      recordCredentialWorkspace('ws-B');
      releaseA();
      return { content: [{ type: 'text' as const, text: 'b' }] };
    });

    const a = toolA({});
    await toolB({});
    await a;

    const byTool = new Map(
      client.events.map((e) => [e.properties?.tool, e.workspaceId]),
    );
    expect(byTool.get('tool_a')).toBe('ws-A');
    expect(byTool.get('tool_b')).toBe('ws-B');
  });

  // 月次コホート集計 (developer-docs `Notion「MCP コホート月次集計」(https://app.notion.com/p/3bc2873e44e4813d899ed7eb74e1f3d4)`
  // §3.2 / §6.3) がこの properties の形をそのまま前提にしている。ギャラリー需要
  // テレメトリ (PRJ-3-1350) で新イベントを足したときに、こちらへキーが混ざって
  // いないことを固定する。
  //
  // 仕様変更: 失敗イベントに上流の観測値を足した (`upstreamFailureCount` は常に、
  // `lastUpstream*` は観測できたときだけ)。コホート分類は `tool` / `success` /
  // `success=true` の行しか見ないので追加は影響しない。**成功側のキーは
  // 増やさない** —— この期待値がその保証。
  it('回帰: integration.mcp.invoked の properties キーが増減していない', async () => {
    const client = new RecordingClient();

    await withTelemetry(
      client,
      'search_gallery_templates',
      ok,
      noWorkspace,
    )({});
    expect(Object.keys(client.events[0].properties ?? {}).sort()).toEqual([
      'durationMs',
      'success',
      'tool',
    ]);

    await withTelemetry(
      client,
      'search_gallery_templates',
      async () => ({
        isError: true as const,
        content: [{ type: 'text' as const, text: 'boom' }],
      }),
      noWorkspace,
    )({});
    expect(Object.keys(client.events[1].properties ?? {}).sort()).toEqual([
      'durationMs',
      'errorClass',
      'success',
      'tool',
      'upstreamFailureCount',
      'upstreamRequestCount',
    ]);
  });
});

// 失敗理由の記録 (`upstream.ts`)。実測 (Cloudflare Analytics Engine /
// 2026-07-18〜08-17) で `copy_gallery_template` が 8 回中 4 回失敗していたが、
// `errorClass: 'ToolError'` しか残らず理由が 1 件も分からなかったための追加。
describe('withTelemetry — 失敗理由 (上流の観測値)', () => {
  const failing = async () => ({
    isError: true as const,
    content: [{ type: 'text' as const, text: 'エラー: …' }],
  });

  it('観測できた上流のステータスを失敗イベントに載せる', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'copy_gallery_template',
      async () => {
        recordUpstreamFailure({ status: 403, errorClass: 'HttpError' });
        return failing();
      },
      noWorkspace,
    );

    await wrapped({});

    expect(client.events[0].properties?.success).toBe(false);
    expect(client.events[0].properties?.lastUpstreamStatus).toBe(403);
    expect(client.events[0].properties?.lastUpstreamErrorClass).toBe(
      'HttpError',
    );
    expect(client.events[0].properties?.upstreamFailureCount).toBe(1);
  });

  // 「ステータスが取れなかった」と「ステータスが 0 だった」を混同させない。
  it('応答が返らなかった上流失敗には lastUpstreamStatus を載せない', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'copy_gallery_template',
      async () => {
        recordUpstreamFailure({ errorClass: 'TypeError' });
        return failing();
      },
      noWorkspace,
    );

    await wrapped({});

    expect(client.events[0].properties?.lastUpstreamErrorClass).toBe(
      'TypeError',
    );
    expect('lastUpstreamStatus' in (client.events[0].properties ?? {})).toBe(
      false,
    );
    expect(client.events[0].properties?.upstreamFailureCount).toBe(1);
  });

  // 0 は「観測しなかった」。キーが無い状態（この計測を持たない古いビルド）と
  // 区別できる必要があるので、0 でも必ず載せる。
  it('上流エラーを観測しなかった失敗は件数 0 を載せる', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'suggest_params',
      failing,
      noWorkspace,
    );

    await wrapped({});

    expect(client.events[0].properties?.upstreamRequestCount).toBe(0);
    expect(client.events[0].properties?.upstreamFailureCount).toBe(0);
    expect(client.events[0].properties?.lastUpstreamErrorClass).toBeUndefined();
    expect(client.events[0].properties?.lastUpstreamStatus).toBeUndefined();
  });

  // 「上流を一度も呼ばずに失敗した」と「上流は応答したがツールが応答内容を
  // 拒否した」を、失敗件数 0 のまま区別できるようにする。
  it('上流が応答したのにツールが失敗した場合はリクエスト本数で区別できる', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'copy_gallery_template',
      async () => {
        recordUpstreamRequest();
        recordUpstreamRequest();
        return failing();
      },
      noWorkspace,
    );

    await wrapped({});

    expect(client.events[0].properties?.upstreamRequestCount).toBe(2);
    expect(client.events[0].properties?.upstreamFailureCount).toBe(0);
  });

  // 401 → refresh → 再送で成功する経路。回復した呼び出しの成功行に失敗の痕跡を
  // 残さない。
  it('成功イベントには載せない (上流エラーから回復した場合も)', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'generate_pdf_sync',
      async () => {
        recordUpstreamFailure({ status: 401, errorClass: 'HttpError' });
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
      noWorkspace,
    );

    await wrapped({});

    expect(client.events[0].properties?.success).toBe(true);
    expect(client.events[0].properties?.upstreamFailureCount).toBeUndefined();
    expect(client.events[0].properties?.lastUpstreamErrorClass).toBeUndefined();
    expect(client.events[0].properties?.lastUpstreamStatus).toBeUndefined();
  });

  // 「回復してから別の理由で失敗した」呼び出し。最後の 1 件は**原因ではない**
  // ので、件数を併記して最後の 1 件だけを読ませない。
  it('複数観測したら件数を数え、最後に観測した 1 件を載せる', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'copy_gallery_template',
      async () => {
        recordUpstreamFailure({ status: 401, errorClass: 'HttpError' });
        recordUpstreamFailure({ status: 500, errorClass: 'HttpError' });
        return failing();
      },
      noWorkspace,
    );

    await wrapped({});

    expect(client.events[0].properties?.upstreamFailureCount).toBe(2);
    expect(client.events[0].properties?.lastUpstreamStatus).toBe(500);
  });

  it('throw した失敗にも載せる', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'copy_gallery_template',
      async () => {
        recordUpstreamFailure({ status: 502, errorClass: 'HttpError' });
        throw new TypeError('boom');
      },
      noWorkspace,
    );

    await expect(wrapped({})).rejects.toThrow('boom');
    expect(client.events[0].properties?.errorClass).toBe('TypeError');
    expect(client.events[0].properties?.lastUpstreamStatus).toBe(502);
    expect(client.events[0].properties?.upstreamFailureCount).toBe(1);
  });

  // PRJ-3-1117 の保証が壊れていないこと。**失敗イベントに帰属を足さずに理由だけ
  // 足す**のがこの変更の要点なので、両方を 1 つのテストで固定する。
  it('失敗イベントに workspaceId は付かない (理由を足しても)', async () => {
    const client = new RecordingClient();
    const wrapped = withTelemetry(
      client,
      'copy_gallery_template',
      async () => {
        recordUpstreamFailure({ status: 429, errorClass: 'HttpError' });
        return failing();
      },
      () => '0eLHZZ8PxpU4Z5r7',
    );

    await wrapped({});

    expect(client.events[0].workspaceId).toBeUndefined();
    expect(client.events[0].properties?.lastUpstreamStatus).toBe(429);
  });

  it('並行呼び出しの観測値が互いに混ざらない', async () => {
    const client = new RecordingClient();

    let releaseA = (): void => {};
    const aCanFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const toolA = withTelemetry(
      client,
      'tool_a',
      async () => {
        recordUpstreamFailure({ status: 404, errorClass: 'HttpError' });
        await aCanFinish;
        return failing();
      },
      noWorkspace,
    );
    const toolB = withTelemetry(
      client,
      'tool_b',
      async () => {
        recordUpstreamFailure({ status: 500, errorClass: 'HttpError' });
        releaseA();
        return failing();
      },
      noWorkspace,
    );

    const a = toolA({});
    await toolB({});
    await a;

    const byTool = new Map(
      client.events.map((e) => [
        e.properties?.tool,
        e.properties?.lastUpstreamStatus,
      ]),
    );
    expect(byTool.get('tool_a')).toBe(404);
    expect(byTool.get('tool_b')).toBe(500);
  });

  // スコープ外での記録はどのイベントにも属さないので落とす
  // (`recordCredentialWorkspace` と同じ扱い)。
  it('呼び出しスコープ外の記録は次の呼び出しへ漏れない', async () => {
    const client = new RecordingClient();
    recordUpstreamFailure({ status: 500, errorClass: 'HttpError' });

    await withTelemetry(client, 'list_templates', failing, noWorkspace)({});

    expect(client.events[0].properties?.upstreamFailureCount).toBe(0);
  });
});
