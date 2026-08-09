/**
 * 2026-07-28 (modern era) の Streamable HTTP 経路検証。
 *
 * createMcpHandler 移行後の两世代同時サポートを HTTP 層でピン止めする:
 * - 公式 v2 Client (pin: 2026-07-28) と旧仕様 Client (initialize) の両方が
 *   同一エンドポイントに接続できること (ST2 受け入れ基準)
 * - 新仕様 raw リクエストの resultType / ttlMs / cacheScope / エラーコード
 *   (-32020 HeaderMismatch / -32022 UnsupportedProtocolVersion) (ST2/ST3)
 * - server/discover が認証不要で応答すること (initialize と同等の扱い) (ST3)
 * - 旧仕様 GET (standalone SSE) は stateless 構成の SDK 既定で 405 になること
 *   (SSE resumability / GET エンドポイント廃止。クライアントは 405 を benign 扱い)
 */
import type { AddressInfo } from 'net';
import type { Server as HttpServer } from 'http';
import request from 'supertest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { buildHttpApp } from './http-server';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** 新仕様リクエストの params._meta envelope を組み立てる。 */
const modernMeta = (
  protocolVersion: string = MODERN_PROTOCOL_VERSION,
): Record<string, unknown> => ({
  [PROTOCOL_VERSION_META_KEY]: protocolVersion,
  [CLIENT_CAPABILITIES_META_KEY]: {},
});

/**
 * supertest レスポンスから JSON-RPC メッセージを取り出す。
 * modern 経路の応答は application/json 単一ボディだが、SSE (text/event-stream)
 * で返るケースにも備えて data: 行のパースをフォールバックで持つ。
 */
const parseJsonRpc = (res: {
  headers: Record<string, string>;
  text: string;
  body: unknown;
}): Record<string, unknown> => {
  const contentType = res.headers['content-type'] ?? '';
  if (contentType.includes('text/event-stream')) {
    const dataLines = res.text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    expect(dataLines.length).toBeGreaterThan(0);
    return JSON.parse(dataLines[dataLines.length - 1]) as Record<
      string,
      unknown
    >;
  }
  if (res.body && typeof res.body === 'object') {
    return res.body as Record<string, unknown>;
  }
  return JSON.parse(res.text) as Record<string, unknown>;
};

describe('http-server (2026-07-28 modern era)', () => {
  const app = buildHttpApp();

  describe('raw wire (supertest)', () => {
    it('新仕様 tools/list (_meta envelope + Mcp-Method) は 200 で resultType/ttlMs/cacheScope を含む', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
        .set('Mcp-Method', 'tools/list')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: modernMeta() },
        })
        .expect(200);

      const msg = parseJsonRpc(res);
      const result = msg.result as {
        resultType?: string;
        ttlMs?: number;
        cacheScope?: string;
        tools?: Array<{ name: string }>;
      };
      expect(result).toBeDefined();
      expect(result.resultType).toBe('complete');
      // CacheableResult (SEP-2549): SDK 既定は ttlMs: 0 / cacheScope: 'private'
      expect(typeof result.ttlMs).toBe('number');
      expect(result.cacheScope).toBe('private');
      const names = (result.tools ?? []).map((t) => t.name);
      expect(names).toContain('generate_pdf_sync');
      expect(names).toContain('search');
      // HTTP モードでは stdio 専用の authenticate は公開しない (従来どおり)
      expect(names).not.toContain('authenticate');
    });

    it('Mcp-Method ヘッダーとボディ method の不一致は 400 + HeaderMismatchError (-32020)', async () => {
      // spec: Server Validation — ヘッダー検証失敗は HTTP 400 MUST + JSON-RPC -32020
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
        .set('Mcp-Method', 'tools/call')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: { _meta: modernMeta() },
        })
        .expect(400);

      const msg = parseJsonRpc(res);
      const error = msg.error as { code?: number } | undefined;
      expect(error?.code).toBe(-32020);
    });

    it('必須の Mcp-Name ヘッダー欠落 (tools/call) は 400 + HeaderMismatchError (-32020)', async () => {
      // spec: Standard Request Headers — Mcp-Name は tools/call / resources/read /
      // prompts/get で REQUIRED。欠落は検証失敗 (400 + -32020)。
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', 'Bearer dummy-token')
        .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
        .set('Mcp-Method', 'tools/call')
        .send({
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/call',
          params: { name: 'search', arguments: {}, _meta: modernMeta() },
        })
        .expect(400);

      const msg = parseJsonRpc(res);
      const error = msg.error as { code?: number } | undefined;
      expect(error?.code).toBe(-32020);
    });

    it('未サポート protocolVersion は 400 + UnsupportedProtocolVersionError (-32022)', async () => {
      // spec: Protocol Version Header — 未実装バージョンは 400 MUST + -32022
      // (サポート一覧を data.supported で広告)
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', '2099-01-01')
        .set('Mcp-Method', 'tools/list')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
          params: { _meta: modernMeta('2099-01-01') },
        })
        .expect(400);

      const msg = parseJsonRpc(res);
      const error = msg.error as
        | { code?: number; data?: { supported?: string[] } }
        | undefined;
      expect(error?.code).toBe(-32022);
      expect(error?.data?.supported).toContain(MODERN_PROTOCOL_VERSION);
    });

    it('廃止メソッド (ping) は新仕様経路で 404 + Method not found (-32601)', async () => {
      // spec: Protocol Version Header — 未実装 RPC メソッドは 404 MUST + -32601。
      // changelog Major 5: ping / logging/setLevel / roots/list_changed は削除済み。
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
        .set('Mcp-Method', 'ping')
        .send({
          jsonrpc: '2.0',
          id: 22,
          method: 'ping',
          params: { _meta: modernMeta() },
        })
        .expect(404);

      const msg = parseJsonRpc(res);
      const error = msg.error as { code?: number } | undefined;
      expect(error?.code).toBe(-32601);
    });

    it('prompts/list も CacheableResult (resultType/ttlMs/cacheScope) を含む', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
        .set('Mcp-Method', 'prompts/list')
        .send({
          jsonrpc: '2.0',
          id: 23,
          method: 'prompts/list',
          params: { _meta: modernMeta() },
        })
        .expect(200);

      const msg = parseJsonRpc(res);
      const result = msg.result as {
        resultType?: string;
        ttlMs?: number;
        cacheScope?: string;
        prompts?: Array<{ name: string }>;
      };
      expect(result.resultType).toBe('complete');
      expect(typeof result.ttlMs).toBe('number');
      expect(result.cacheScope).toBe('private');
      expect((result.prompts ?? []).map((p) => p.name)).toContain(
        'generate_pdf',
      );
    });

    it('resources/list (Bearer 有り) も CacheableResult を含む', async () => {
      const realFetch = global.fetch;
      // resources/list は design-parameters テンプレートの list callback が
      // 上流 API を呼ぶため、外向き fetch をモックする。
      global.fetch = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ designs: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ) as unknown as typeof fetch;
      try {
        const res = await request(app)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', 'Bearer dummy-token')
          .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
          .set('Mcp-Method', 'resources/list')
          .send({
            jsonrpc: '2.0',
            id: 24,
            method: 'resources/list',
            params: { _meta: modernMeta() },
          })
          .expect(200);

        const msg = parseJsonRpc(res);
        const result = msg.result as {
          resultType?: string;
          ttlMs?: number;
          cacheScope?: string;
          resources?: Array<{ uri: string }>;
        };
        expect(result.resultType).toBe('complete');
        expect(typeof result.ttlMs).toBe('number');
        expect(result.cacheScope).toBe('private');
        expect((result.resources ?? []).map((r) => r.uri)).toContain(
          'reportflow://server-info',
        );
      } finally {
        global.fetch = realFetch;
      }
    });

    it('suggest_params は新仕様経路では Sampling を使わずスキーマフォールバックを返す', async () => {
      // Sampling は 2026-07-28 で Deprecated (SEP-2577)。新仕様接続では
      // capability 判定が false になり、既存の samplingUnavailable フォールバック
      // (スキーマ + 手動入力ガイド) が自動で効くことをピン止めする。
      const realFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            customerName: { name: 'customerName', type: 'string' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ) as unknown as typeof fetch;
      try {
        const res = await request(app)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', 'Bearer dummy-token')
          .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
          .set('Mcp-Method', 'tools/call')
          .set('Mcp-Name', 'suggest_params')
          .send({
            jsonrpc: '2.0',
            id: 25,
            method: 'tools/call',
            params: {
              name: 'suggest_params',
              arguments: { designId: 'design-1', description: '請求書' },
              _meta: modernMeta(),
            },
          })
          .expect(200);

        const msg = parseJsonRpc(res);
        const result = msg.result as {
          resultType?: string;
          isError?: boolean;
          content?: Array<{ type: string; text?: string }>;
        };
        expect(result.resultType).toBe('complete');
        expect(result.isError).toBeUndefined();
        const text = result.content?.[0]?.text ?? '';
        expect(text).toContain('"samplingUnavailable": true');
      } finally {
        global.fetch = realFetch;
      }
    });

    it('server/discover は Bearer 無しで応答する (initialize と同等の認証免除)', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
        .set('Mcp-Method', 'server/discover')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'server/discover',
          params: { _meta: modernMeta() },
        });

      expect(res.status).not.toBe(401);
      const msg = parseJsonRpc(res);
      expect(msg.error).toBeUndefined();
      const result = msg.result as Record<string, unknown>;
      expect(result).toBeDefined();
      // サポートバージョンに 2026-07-28 を含む (旧リビジョンとの両対応は
      // 下の「旧仕様クライアント」テストで担保)
      expect(JSON.stringify(result)).toContain(MODERN_PROTOCOL_VERSION);
    });

    it('ルート / でも server/discover が /mcp と同様に応答する (Smithery/Glama 対策の維持)', async () => {
      const res = await request(app)
        .post('/')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
        .set('Mcp-Method', 'server/discover')
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'server/discover',
          params: { _meta: modernMeta() },
        });

      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(404);
      const msg = parseJsonRpc(res);
      expect(msg.error).toBeUndefined();
    });

    it('新仕様でも保護対象メソッド (tools/call) は Bearer 無しで 401 (認可ガード維持)', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
        .set('Mcp-Method', 'tools/call')
        .set('Mcp-Name', 'search')
        .send({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'search',
            arguments: {},
            _meta: modernMeta(),
          },
        })
        .expect(401);
      expect(res.headers['www-authenticate']).toContain('Bearer');
    });

    it('新仕様 tools/call (Bearer 有り) の結果に resultType: complete が付く', async () => {
      const realFetch = global.fetch;
      const fetchMock = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ designs: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      try {
        const res = await request(app)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', 'Bearer dummy-token')
          .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
          .set('Mcp-Method', 'tools/call')
          .set('Mcp-Name', 'search')
          .send({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: {
              name: 'search',
              arguments: {},
              _meta: modernMeta(),
            },
          })
          .expect(200);

        const msg = parseJsonRpc(res);
        const result = msg.result as { resultType?: string } | undefined;
        expect(result?.resultType).toBe('complete');
      } finally {
        global.fetch = realFetch;
      }
    });

    it('旧仕様 GET (standalone SSE) は stateless 構成では 405 (クライアントは benign 扱い)', async () => {
      await request(app)
        .get('/mcp')
        .set('Accept', 'text/event-stream')
        .expect(405);
    });

    it('DELETE (旧仕様のセッション終了) は 405 (spec: GET/DELETE には 405 を返す)', async () => {
      // セッション廃止に伴い DELETE は処理対象外。旧仕様クライアントの
      // terminateSession は 405 を正常終了として扱う。
      await request(app).delete('/mcp').expect(405);
    });
  });

  describe('公式クライアントでの新旧両世代接続 (実ソケット)', () => {
    let httpServer: HttpServer;
    let baseUrl: string;

    beforeAll(async () => {
      await new Promise<void>((resolve) => {
        httpServer = app.listen(0, '127.0.0.1', () => resolve());
      });
      const { port } = httpServer.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}/mcp`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it('新仕様クライアント (pin: 2026-07-28) が接続・tools/list できる', async () => {
      const client = new Client(
        { name: 'modern-test-client', version: '0.0.0' },
        { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
      await client.connect(transport);
      try {
        expect(client.getProtocolEra()).toBe('modern');
        // 正式版仕様: serverInfo は結果 _meta (io.modelcontextprotocol/serverInfo)
        // 経由で伝わる (spec PR #3002)。SDK が読み出して getServerVersion で返す。
        expect(client.getServerVersion()?.name).toBe('reportflow-mcp');
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        expect(names).toContain('generate_pdf_sync');
        expect(names).toContain('list_templates');
        expect(names).not.toContain('authenticate');
      } finally {
        await client.close();
      }
    });

    it('旧仕様クライアント (initialize ハンドシェイク) も従来どおり接続できる (後方互換)', async () => {
      const client = new Client({
        name: 'legacy-test-client',
        version: '0.0.0',
      });
      const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
      await client.connect(transport);
      try {
        expect(client.getServerVersion()?.name).toBe('reportflow-mcp');
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain('generate_pdf_sync');
      } finally {
        await client.close();
      }
    });

    it('?widgets=1 付き接続では search に openai/outputTemplate が付く (ChatGPT App 経路の回帰確認)', async () => {
      const client = new Client(
        { name: 'widgets-test-client', version: '0.0.0' },
        { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
      );
      const transport = new StreamableHTTPClientTransport(
        new URL(`${baseUrl}?widgets=1`),
      );
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        const search = tools.find((t) => t.name === 'search') as
          | { _meta?: Record<string, unknown> }
          | undefined;
        expect(search?._meta?.['openai/outputTemplate']).toBe(
          'ui://widget/template-list.html',
        );
      } finally {
        await client.close();
      }
    });

    it('通常 URL (widgets なし) では search に _meta が付かない (claude.ai 経路)', async () => {
      const client = new Client(
        { name: 'no-widgets-test-client', version: '0.0.0' },
        { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        const search = tools.find((t) => t.name === 'search') as
          | { _meta?: Record<string, unknown> }
          | undefined;
        expect(search?._meta?.['openai/outputTemplate']).toBeUndefined();
      } finally {
        await client.close();
      }
    });

    it('subscriptions/listen は SSE ストリームで acknowledged 通知を返す (changelog Major 4)', async () => {
      // GET エンドポイント / resources/subscribe の置換先。SDK のエントリが
      // 処理することを確認する (通知の発行自体は本サーバーでは行わない)。
      const abort = new AbortController();
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
          'Mcp-Method': 'subscriptions/listen',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 30,
          method: 'subscriptions/listen',
          params: {
            notifications: { toolsListChanged: true },
            _meta: modernMeta(),
          },
        }),
        signal: abort.signal,
      });
      try {
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const reader = (
          res.body as ReadableStream<Uint8Array>
        ).getReader();
        const { value } = await reader.read();
        const firstFrame = new TextDecoder().decode(value);
        expect(firstFrame).toContain(
          'notifications/subscriptions/acknowledged',
        );
        expect(firstFrame).toContain('io.modelcontextprotocol/subscriptionId');
      } finally {
        abort.abort();
      }
    });
  });

  // ── PRJ-3-1251: 新旧混在エンベロープの互換 ───────────────────────────────
  //
  // 本番でコミュニティ経由のクライアントが「新世代の _meta エンベロープを
  // 付けながら中で 2025 系を名乗る」形で送ってきており、SDK が modern と分類
  // → 400 になって **ツールを 1 つも呼べなかった** (2026-07-30 / 08-06 / 08-08 に
  // 計 2390 件。-32022 と -32602 がペアで再試行ループ)。クライアント側を修正
  // できないため、成立していないエンベロープは剥がして legacy 経路へ流す。
  describe('新旧混在エンベロープの互換 (PRJ-3-1251)', () => {
    const expectToolsResult = (msg: Record<string, unknown>): void => {
      const result = msg.result as { tools?: Array<{ name: string }> };
      expect(result).toBeDefined();
      expect((result.tools ?? []).map((t) => t.name)).toContain(
        'generate_pdf_sync',
      );
    };

    it('エンベロープが 2025 系を名乗っても 400 にせず結果を返す (旧: -32022)', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 40,
          method: 'tools/list',
          params: { _meta: modernMeta('2025-06-18') },
        })
        .expect(200);

      expectToolsResult(parseJsonRpc(res));
    });

    it('エンベロープが新世代を名乗るが clientCapabilities 欠落でも結果を返す (旧: -32602)', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 41,
          method: 'tools/list',
          params: {
            _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION },
          },
        })
        .expect(200);

      expectToolsResult(parseJsonRpc(res));
    });

    // body のエンベロープだけ剥がすと、今度は「ヘッダーが新世代を名乗るのに
    // エンベロープが無い」で 400 になる。ヘッダーも併せて外すことの回帰テスト。
    it('新世代ヘッダー付きで壊れたエンベロープを送っても結果を返す', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
        .send({
          jsonrpc: '2.0',
          id: 42,
          method: 'tools/list',
          params: {
            _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION },
          },
        })
        .expect(200);

      expectToolsResult(parseJsonRpc(res));
    });

    // 正しい新世代リクエストは従来どおり modern 経路 (CacheableResult を含む)。
    // 互換処理が modern を巻き込んで legacy に落としていないことを確認する。
    it('正しい新世代リクエストは modern 経路のまま', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', MODERN_PROTOCOL_VERSION)
        .set('Mcp-Method', 'tools/list')
        .send({
          jsonrpc: '2.0',
          id: 43,
          method: 'tools/list',
          params: { _meta: modernMeta() },
        })
        .expect(200);

      const msg = parseJsonRpc(res);
      expect((msg.result as { resultType?: string }).resultType).toBe(
        'complete',
      );
    });
  });
});
