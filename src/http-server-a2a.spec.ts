/**
 * A2A (Agent2Agent) v1.0 の HTTP 経路検証。
 *
 * jsonrpc.spec.ts が A2A の意味論を単体で押さえるのに対し、ここは
 * **実際の Express アプリ + 実際の MCP ハンドラ**を通して、
 * - Agent Card が配信されること
 * - SendMessage の skill が同一プロセスの MCP `tools/call` として実行されること
 *   (認可・ツール実装が MCP 経路と共通であること)
 * - Bearer 無しは MCP と同じ 401 + WWW-Authenticate になること
 * - Host 検証が /a2a にも掛かっていること
 * を固定する。
 */
import request from 'supertest';
import { buildHttpApp } from './http-server';
import {
  fixedAuthorization,
  unauthenticatedAuthorization,
} from './integration/helpers/createTestClient';

describe('http-server A2A', () => {
  const app = buildHttpApp({
    resolveAuthorization: () => Promise.resolve(fixedAuthorization('ADMIN')),
  });

  const skillMessage = (skill: string, args: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'SendMessage',
    params: {
      message: {
        messageId: 'm-1',
        role: 'ROLE_USER',
        parts: [{ data: { skill, arguments: args } }],
      },
    },
  });

  it('GET /.well-known/agent-card.json は JSON-RPC の /a2a を広告する Agent Card を返す', async () => {
    const res = await request(app)
      .get('/.well-known/agent-card.json')
      .expect(200)
      .expect('Content-Type', /application\/json/);
    const card = res.body as {
      supportedInterfaces: { url: string; protocolBinding: string }[];
      skills: { id: string }[];
    };
    expect(card.supportedInterfaces).toHaveLength(1);
    expect(card.supportedInterfaces[0].url).toMatch(/\/a2a$/);
    expect(card.supportedInterfaces[0].protocolBinding).toBe('JSONRPC');
    expect(card.skills.map((s) => s.id)).toContain('generate_pdf_sync');
  });

  it('skill 無しのメッセージは Bearer 無しでも使い方の Message を返す', async () => {
    const res = await request(app)
      .post('/a2a')
      .set('A2A-Version', '1.0')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            messageId: 'm',
            role: 'ROLE_USER',
            parts: [{ text: 'hi' }],
          },
        },
      })
      .expect(200);
    expect(res.body.result.message.role).toBe('ROLE_AGENT');
  });

  it('Bearer 無しで skill を実行すると 401 + WWW-Authenticate (MCP と同じ誘導)', async () => {
    const res = await request(app)
      .post('/a2a')
      .send(skillMessage('list_templates', {}))
      .expect(401);
    expect(res.headers['www-authenticate']).toContain(
      '/.well-known/oauth-protected-resource',
    );
  });

  it('skill は同一プロセスの MCP tools/call として実行され、完了 Task が返る', async () => {
    // get_design_parameters は上流の parameters API を 1 回引き、その JSON を
    // text content で返す。
    const realFetch = global.fetch;
    const upstream = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          customerName: { name: 'customerName', type: 'string' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    global.fetch = upstream as unknown as typeof fetch;
    try {
      const res = await request(app)
        .post('/a2a')
        .set('Authorization', 'Bearer dummy-token')
        .set('A2A-Version', '1.0')
        .send(skillMessage('get_design_parameters', { designId: 'design-1' }))
        .expect(200);

      expect(res.body.id).toBe('req-1');
      const task = res.body.result.task as {
        status: { state: string };
        artifacts: { name: string; parts: { text?: string }[] }[];
        metadata: { skill: string };
      };
      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
      expect(task.metadata.skill).toBe('get_design_parameters');
      expect(task.artifacts[0].name).toBe('get_design_parameters');
      expect(task.artifacts[0].parts[0].text).toContain('customerName');
      // Bearer は MCP のツール層 (上流 API 呼び出し) まで伝搬している。
      expect(upstream).toHaveBeenCalled();
      const [, init] = upstream.mock.calls[0] as [unknown, RequestInit];
      expect(JSON.stringify(init.headers)).toContain('dummy-token');
    } finally {
      global.fetch = realFetch;
    }
  });

  it('引数の不足は FAILED Task になり、どのフィールドかを status.message で返す', async () => {
    // MCP SDK v2 はツール引数の検証エラーを JSON-RPC エラーではなく
    // isError のツール結果で返す (実測)。A2A では FAILED Task に写る。
    const res = await request(app)
      .post('/a2a')
      .set('Authorization', 'Bearer dummy-token')
      .send(skillMessage('get_design_parameters', {}))
      .expect(200);
    const status = res.body.result.task.status as {
      state: string;
      message: { parts: { text: string }[] };
    };
    expect(status.state).toBe('TASK_STATE_FAILED');
    expect(status.message.parts[0].text).toContain('designId');
  });

  it('上流が拒否したトークン (期限切れ等) は FAILED ではなく 401 + WWW-Authenticate', async () => {
    const rejectingApp = buildHttpApp({
      resolveAuthorization: () =>
        Promise.resolve(unauthenticatedAuthorization()),
    });
    const res = await request(rejectingApp)
      .post('/a2a')
      .set('Authorization', 'Bearer expired-token')
      .send(skillMessage('list_templates', {}))
      .expect(401);
    expect(res.headers['www-authenticate']).toContain(
      '/.well-known/oauth-protected-resource',
    );
  });

  it('壊れた JSON は JSON-RPC の Parse error (-32700) で返す', async () => {
    const res = await request(app)
      .post('/a2a')
      .set('Content-Type', 'application/json')
      .send('{"jsonrpc": "2.0", "id": 1, "method": ')
      .expect(400);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Invalid JSON payload' },
    });
  });

  it('CORS preflight は A2A-Version ヘッダーを許可する', async () => {
    const res = await request(app)
      .options('/a2a')
      .set('Origin', 'https://agent.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,a2a-version')
      .expect(204);
    expect(
      String(res.headers['access-control-allow-headers']).toLowerCase(),
    ).toContain('a2a-version');
  });

  it('不正な Host は MCP と同じく 403', async () => {
    await request(app)
      .post('/a2a')
      .set('Host', 'evil.example.com')
      .send(skillMessage('list_templates', {}))
      .expect(403);
  });

  it('POST 以外は 405 + Allow: POST', async () => {
    const res = await request(app).get('/a2a').expect(405);
    expect(res.headers['allow']).toBe('POST');
  });
});
