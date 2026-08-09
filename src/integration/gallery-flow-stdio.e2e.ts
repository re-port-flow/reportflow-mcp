/**
 * Layer B: stdio モードのギャラリーフロー統合テスト（実 HTTP・実 auth 経路）
 *
 * 目的: 「ギャラリー検索 → 複製 → パラメータ取得 → PDF 生成」を stdio モードの
 * サーバー登録・実 fetch・実 token-store を通して 1 本で検証する。
 *
 * 既存レイヤーとの違い（なぜこのファイルが必要か）:
 * - `tools/*.spec.ts` と `tools-mocked.e2e.ts` は `global.fetch` と `../auth` を
 *   モックするため、**送信ヘッダーの欠落を構造的に検出できない**。実際 PRJ-3-1245
 *   では必須ヘッダー `app-key` の欠落で複製が 412 になり一度も成功しなかったが、
 *   fetch を stub した UT は全て green だった。
 * - ここでは実 HTTP サーバー（node:http）を立て、リクエストの method / path /
 *   headers / body をそのまま記録して検証する。`../auth` もモックせず、file
 *   token-store に注入したトークンから Bearer と workspace_id を解決させる。
 *
 * 実プロセス（`node dist/index.js`）での stdio ハンドシェイクとツール公開は
 * `scripts/packaging-smoke.mjs`（CI の packaging-smoke ジョブ）が担当する。
 *
 * 各 getter（`client.ts` の `getBaseUrl` / `gallery-client.ts` の
 * `getMainApiBaseUrl` / `auth.ts` の `getOAuthConfig` / token-store の
 * `resolveStoreDir`）は呼び出し時に `process.env` を読むため、env の設定は
 * import 後（`beforeAll`）で足りる。
 */

import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { createTestClient, TestClientHandle } from './helpers/createTestClient';

// ─── 記録付きスタブ API ───────────────────────────────────────────────────────

type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

type StubBehavior = {
  /** 複製 POST に返すステータス（既定 201）。412 等の異常系で差し替える */
  duplicateStatus: number;
};

const WORKSPACE_ID = 'ws-from-jwt';
const OTHER_WORKSPACE_ID = 'ws-someone-else';
const SLUG = 'invoice-basic';
const NEW_DESIGN_ID = 'design-copied-1';
const PDF_BYTES = Buffer.from('%PDF-1.7\nstub\n%%EOF\n', 'utf8');

const DUPLICATE_PATH_PATTERN =
  /^\/api\/v1\/([^/]+)\/my\/templates\/([^/]+)\/duplicate$/;

const templateItem = {
  slug: SLUG,
  title: '請求書（標準）',
  description: '請求書のテンプレート',
  category: 'invoice',
  tags: ['請求書'],
  thumbnailUrl: 'https://files.example.test/thumb.pdf',
  duplicateCount: 3,
  version: 2,
  updatedAt: '2026-07-29T13:46:10.000Z',
};

const recorded: RecordedRequest[] = [];
const behavior: StubBehavior = { duplicateStatus: 201 };

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const sendJson = (
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

const handle = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
): void => {
  const method = req.method ?? 'GET';
  const pathname = (req.url ?? '').split('?')[0];

  // 公開ギャラリー API（認証不要）
  if (method === 'GET' && pathname === '/api/v1/public/templates') {
    sendJson(res, 200, { items: [templateItem], nextCursor: null, total: 1 });
    return;
  }
  if (method === 'GET' && pathname === `/api/v1/public/templates/${SLUG}`) {
    sendJson(res, 200, {
      ...templateItem,
      ownerName: null,
      createdAt: '2026-03-21T14:13:02.000Z',
    });
    return;
  }

  // 複製 API（Bearer + app-key 必須。パスの workspaceId は JWT 由来のはず）
  const duplicateMatch = DUPLICATE_PATH_PATTERN.exec(pathname);
  if (method === 'POST' && duplicateMatch) {
    if (behavior.duplicateStatus !== 201) {
      sendJson(res, behavior.duplicateStatus, {
        message: 'Precondition Failed',
      });
      return;
    }
    sendJson(res, 201, {
      id: 'dup-log-1',
      templateId: 'tpl-1',
      templateSlug: duplicateMatch[2],
      userId: 'user-1',
      workspaceId: duplicateMatch[1],
      duplicatedFileId: NEW_DESIGN_ID,
      sourceTemplateVersion: 2,
      createdAt: '2026-08-08T00:00:00.000Z',
    });
    return;
  }

  // content-service: パラメータ取得
  if (
    method === 'GET' &&
    pathname === `/v1/file/design/parameter/${NEW_DESIGN_ID}`
  ) {
    sendJson(res, 200, { 請求先: 'string', 合計金額: 'string' });
    return;
  }

  // content-service: PDF 同期生成（本文 = PDF バイト列 + メタはヘッダー）
  if (method === 'POST' && pathname === '/v1/file/sync/single') {
    const mapping = encodeURIComponent(
      JSON.stringify([{ fileId: 'file-1', fileName: 'invoice.pdf' }]),
    );
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': PDF_BYTES.length,
      'File-URL': 'https://files.example.test/download/req-1',
      'Request-Id': 'req-1',
      'X-File-Mapping': mapping,
    });
    res.end(PDF_BYTES);
    return;
  }

  sendJson(res, 404, { message: `unhandled: ${method} ${pathname}`, body });
};

const server = http.createServer((req, res) => {
  readBody(req)
    .then((body) => {
      recorded.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(', ') : (v ?? ''),
          ]),
        ),
        body,
      });
      handle(req, res, body);
    })
    .catch(() => {
      res.writeHead(500).end();
    });
});

// ─── テスト用トークン ─────────────────────────────────────────────────────────

const CLIENT_ID = 'e2e-stdio-client';
const SCOPE =
  'openid profile designs:read designs:write templates:read templates:write pdf:generate';
const ACCESS_TOKEN = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url',
  ),
  Buffer.from(JSON.stringify({ workspace_id: WORKSPACE_ID })).toString(
    'base64url',
  ),
  'stub-signature',
].join('.');

const findRequest = (
  predicate: (r: RecordedRequest) => boolean,
): RecordedRequest | undefined => recorded.find(predicate);

const duplicateRequests = (): RecordedRequest[] =>
  recorded.filter(
    (r) => r.method === 'POST' && DUPLICATE_PATH_PATTERN.test(r.url),
  );

type ToolCallResult = {
  isError?: boolean;
  content: { type: string; text?: string }[];
};

describe('stdio モード: ギャラリー → 複製 → パラメータ → PDF (Layer B)', () => {
  let handleClient: TestClientHandle;
  let tokenDir: string;
  let outputDir: string;
  let previousTokenStorePath: string | undefined;

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> =>
    (await handleClient.client.callTool({
      name,
      arguments: args,
    })) as ToolCallResult;

  const textOf = (result: ToolCallResult): string =>
    result.content.map((c) => c.text ?? '').join('\n');

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rf-mcp-token-'));
    // outputDir は Roots 非対応クライアント時の許可ルート
    // (safe-paths.ts の DEFAULT_FALLBACK_DIR = os.tmpdir()/reportflow) 配下に置く
    outputDir = path.join(os.tmpdir(), 'reportflow', 'e2e-gallery-stdio');
    await fs.mkdir(outputDir, { recursive: true });

    process.env['REPORTFLOW_AUTH_URL'] = `${baseUrl}/api/v1`;
    process.env['REPORTFLOW_API_BASE_URL'] = baseUrl;
    process.env['REPORTFLOW_CLIENT_ID'] = CLIENT_ID;
    process.env['REPORTFLOW_TOKEN_STORE'] = 'file';
    // TOKEN_STORE_PATH は test-setup.ts が毎ファイルで再設定しない env のため、
    // 同一 worker の後続テストファイルへ漏らさないよう afterAll で元に戻す
    previousTokenStorePath = process.env['REPORTFLOW_TOKEN_STORE_PATH'];
    process.env['REPORTFLOW_TOKEN_STORE_PATH'] = tokenDir;
    delete process.env['REPORTFLOW_APP_KEY'];

    await fs.writeFile(
      path.join(tokenDir, `${CLIENT_ID}.json`),
      JSON.stringify({
        accessToken: ACCESS_TOKEN,
        refreshToken: 'stub-refresh',
        // 期限切れ判定で refresh 経路へ行かないよう十分先にする
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: SCOPE,
        workspaceId: WORKSPACE_ID,
      }),
    );

    handleClient = await createTestClient();
  });

  afterAll(async () => {
    await handleClient.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousTokenStorePath === undefined) {
      delete process.env['REPORTFLOW_TOKEN_STORE_PATH'];
    } else {
      process.env['REPORTFLOW_TOKEN_STORE_PATH'] = previousTokenStorePath;
    }
    await fs.rm(tokenDir, { recursive: true, force: true });
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    recorded.length = 0;
    behavior.duplicateStatus = 201;
  });

  it('stdio モードでギャラリー3ツールが公開される', async () => {
    const { tools } = (await handleClient.client.listTools()) as {
      tools: { name: string }[];
    };
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_gallery_templates');
    expect(names).toContain('get_gallery_template');
    expect(names).toContain('copy_gallery_template');
  });

  it('公開ギャラリー API には認証ヘッダーも app-key も送らない', async () => {
    const result = await callTool('search_gallery_templates', {
      query: '請求',
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(SLUG);

    const req = findRequest((r) =>
      r.url.startsWith('/api/v1/public/templates'),
    );
    expect(req).toBeDefined();
    // 認証不要 API に不要なヘッダーを増やさない（PRJ-3-1237 の非変更範囲）
    expect(req?.headers['authorization']).toBeUndefined();
    expect(req?.headers['app-key']).toBeUndefined();
  });

  it('複製 POST は Bearer と非空の app-key を送り、workspaceId は JWT 由来になる', async () => {
    const result = await callTool('copy_gallery_template', { slug: SLUG });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      designId: NEW_DESIGN_ID,
      version: 1,
      workspaceId: WORKSPACE_ID,
    });

    const req = duplicateRequests()[0];
    expect(req).toBeDefined();
    // これが PRJ-3-1245（412 で一度も複製できなかった不具合）の回帰テスト
    expect(req?.headers['app-key']).toBeTruthy();
    expect(req?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    // パスと body の両方が JWT の workspace_id であること
    expect(req?.url).toBe(
      `/api/v1/${WORKSPACE_ID}/my/templates/${SLUG}/duplicate`,
    );
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      workspaceId: WORKSPACE_ID,
    });
  });

  // 複製先は JWT の workspace_id 固定で、ツール引数からは受け取らない設計
  // （PRJ-3-1238）。同名の UT は handler を直接呼ぶため zod 検証層を通らないので、
  // ここでは MCP クライアント経由（= 実際の入力検証を含む経路）で確認する。
  // 引数に他 WS を混ぜても、その WS 宛のリクエストが一切出ないこと。呼び出しが
  // 入力検証で弾かれた場合も「リクエストが出ない」ので同じ結論で成立する。
  it('引数に他ワークスペースを渡しても、そのワークスペース宛には複製しない', async () => {
    await callTool('copy_gallery_template', {
      slug: SLUG,
      workspaceId: OTHER_WORKSPACE_ID,
    }).catch(() => undefined);

    const toOther = recorded.filter(
      (r) =>
        r.url.includes(OTHER_WORKSPACE_ID) ||
        r.body.includes(OTHER_WORKSPACE_ID),
    );
    expect(toOther).toEqual([]);
    for (const req of duplicateRequests()) {
      expect(req.url).toBe(
        `/api/v1/${WORKSPACE_ID}/my/templates/${SLUG}/duplicate`,
      );
    }
  });

  it('複製で得た designId から get_design_parameters → generate_pdf_sync まで通る', async () => {
    const copied = await callTool('copy_gallery_template', { slug: SLUG });
    const { designId, version } = JSON.parse(textOf(copied)) as {
      designId: string;
      version: number;
    };

    const params = await callTool('get_design_parameters', {
      designId,
      version,
    });
    expect(params.isError).toBeFalsy();
    expect(textOf(params)).toContain('請求先');

    const generated = await callTool('generate_pdf_sync', {
      designId,
      version,
      content: {
        fileName: 'invoice.pdf',
        params: { 請求先: 'Acme', 合計金額: '330' },
      },
      outputDir,
    });
    expect(generated.isError).toBeFalsy();

    // stdio モードは実ファイルを保存して絶対パスを返す
    const savedPath = path.join(outputDir, 'invoice.pdf');
    const saved = await fs.readFile(savedPath);
    expect(saved.equals(PDF_BYTES)).toBe(true);
    expect(textOf(generated)).toContain(savedPath);

    const pdfReq = findRequest(
      (r) => r.method === 'POST' && r.url === '/v1/file/sync/single',
    );
    expect(pdfReq?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('複製 API が 412 を返したら再試行・二重複製を促さない', async () => {
    behavior.duplicateStatus = 412;

    const result = await callTool('copy_gallery_template', { slug: SLUG });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('app-key');
    expect(text).not.toContain('二重複製');
    expect(text).not.toContain('再試行する前に');
  });
});
