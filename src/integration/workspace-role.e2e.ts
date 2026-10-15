// ロール別のツールカタログと直接 call の拒否 (PRJ-3-1584 / ST-3)。
//
// `handshake.e2e.ts` が「ADMIN で全ツールが見える」ことを押さえているのに対し、
// ここは **role を変えると何が消え、消えたものを直接呼ぶと何が起きるか** を見る。
// 実プロトコル (InMemoryTransport 経由の tools/list / tools/call) で検証するので、
// 「純関数の表は正しいがサーバーへの配線が抜けている」という失敗を拾える。

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../server';
import {
  authorizationOptions,
  createTestClient,
  fixedAuthorization,
  unauthenticatedAuthorization,
} from './helpers/createTestClient';
import {
  capabilitiesForRole,
  TOOL_CAPABILITIES,
  type WorkspaceRole,
} from '../workspace-permission';
import type { WorkspaceAuthorization } from '../workspace-role';

const upstream = jest.fn();
global.fetch = upstream as unknown as typeof fetch;

const toolNames = async (
  mode: 'stdio' | 'http',
  options: { role?: WorkspaceRole; authorization?: WorkspaceAuthorization },
): Promise<string[]> => {
  const handle = await createTestClient(mode, options);
  try {
    const { tools } = await handle.client.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await handle.cleanup();
  }
};

const PUBLIC_STDIO_TOOLS = [
  'authenticate',
  'get_gallery_template',
  'search_gallery_templates',
].sort();

beforeEach(() => {
  jest.clearAllMocks();
});

describe('tools/list をロールでフィルタする', () => {
  it('ADMIN (stdio) は表に載っている全ツールが見える', async () => {
    expect(await toolNames('stdio', { role: 'ADMIN' })).toEqual(
      Object.keys(TOOL_CAPABILITIES).sort(),
    );
  });

  it('WRITE (stdio) は ADMIN と同じ集合', async () => {
    expect(await toolNames('stdio', { role: 'WRITE' })).toEqual(
      await toolNames('stdio', { role: 'ADMIN' }),
    );
  });

  it('READ (stdio) からは copy_gallery_template だけが消える', async () => {
    const admin = await toolNames('stdio', { role: 'ADMIN' });
    const read = await toolNames('stdio', { role: 'READ' });

    expect(admin.filter((name) => !read.includes(name))).toEqual([
      'copy_gallery_template',
    ]);
    // ST-1 判断1 (案A) / 判断2: 生成と生成物取得は READ でも残る。
    expect(read).toEqual(
      expect.arrayContaining(['generate_pdf_sync', 'download_file']),
    );
  });

  it.each(['UNREAD', 'UNKNOWN'] as const)(
    '%s は公開ツールだけ (ST-1 判断3)',
    async (role) => {
      expect(await toolNames('stdio', { role })).toEqual(PUBLIC_STDIO_TOOLS);
    },
  );

  it('未認証 (Bearer 無し) も公開ツールだけ', async () => {
    expect(
      await toolNames('stdio', {
        authorization: unauthenticatedAuthorization(),
      }),
    ).toEqual(PUBLIC_STDIO_TOOLS);
  });

  it('READ (http) は copy_gallery_template を含まない', async () => {
    const read = await toolNames('http', { role: 'READ' });
    expect(read).not.toContain('copy_gallery_template');
    expect(read).toContain('generate_pdf_sync');
    // http では authenticate / stdio 専用ツールは元から登録されない。
    expect(read).not.toContain('authenticate');
    expect(read).not.toContain('download_file');
  });

  it('未認証 (http) は公開ギャラリー 2 種だけ', async () => {
    expect(
      await toolNames('http', {
        authorization: unauthenticatedAuthorization(),
      }),
    ).toEqual(['get_gallery_template', 'search_gallery_templates']);
  });
});

describe('resources/list もロールでフィルタする', () => {
  const resourceUris = async (options: {
    role?: WorkspaceRole;
    authorization?: WorkspaceAuthorization;
  }): Promise<string[]> => {
    const handle = await createTestClient('stdio', options);
    try {
      const { resources } = await handle.client.listResources();
      return resources.map((resource) => resource.uri).sort();
    } finally {
      await handle.cleanup();
    }
  };

  it('READ ではワークスペースのデザイン一覧リソースが見える', async () => {
    // 認証済みなら listDesigns が呼ばれるので、空の一覧を返しておく。
    upstream.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ designs: [] }),
      headers: new Headers(),
      body: null,
    } as unknown as Response);

    expect(await resourceUris({ role: 'READ' })).toContain(
      'reportflow://designs',
    );
  });

  it('未認証では静的リソースだけが見える（designs は消える）', async () => {
    const uris = await resourceUris({
      authorization: unauthenticatedAuthorization(),
    });

    expect(uris).toContain('reportflow://errors');
    expect(uris).toContain('reportflow://server-info');
    expect(uris).not.toContain('reportflow://designs');
    // 静的リソースの読み出しに上流は要らない。
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('非表示ツールを直接 tools/call しても副作用が起きない', () => {
  it('READ が copy_gallery_template を直接呼ぶと拒否され、上流 fetch は 0 回', async () => {
    const handle = await createTestClient('stdio', { role: 'READ' });
    try {
      // SDK は無効なツールへの tools/call を handler より前に弾く
      // (ProtocolError InvalidParams)。副作用が起きないことがここでの本題。
      await expect(
        handle.client.callTool({
          name: 'copy_gallery_template',
          arguments: { slug: 'invoice' },
        }),
      ).rejects.toThrow(/copy_gallery_template/);
    } finally {
      await handle.cleanup();
    }

    expect(upstream).not.toHaveBeenCalled();
  });

  it('未認証が list_templates を直接呼んでも上流 fetch は 0 回', async () => {
    const handle = await createTestClient('stdio', {
      authorization: unauthenticatedAuthorization(),
    });
    try {
      await expect(
        handle.client.callTool({ name: 'list_templates', arguments: {} }),
      ).rejects.toThrow(/list_templates/);
    } finally {
      await handle.cleanup();
    }

    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('カタログより後に降格した場合（call ガードが最後の砦）', () => {
  /**
   * 接続時は ADMIN でカタログを組み、call ガードだけ READ を返す状態を作る。
   * これは実運用の「stdio で接続したあとに WRITE→READ へ落とされた」
   * および「HTTP でロール解決のキャッシュが切れた直後」に相当する。
   */
  const staleCatalogClient = async () => {
    const downgraded = fixedAuthorization('READ');
    const server = createMcpServer({
      mode: 'stdio',
      capabilities: capabilitiesForRole('ADMIN'),
      resolveAuthorization: () => Promise.resolve(downgraded),
    });
    const client = new Client(
      { name: 'e2e-stale-catalog', version: '0.0.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return { client, cleanup: () => client.close() };
  };

  it('一覧に残っていても call は permission error になり、上流 fetch は 0 回', async () => {
    const handle = await staleCatalogClient();
    try {
      const before = await handle.client.listTools();
      expect(before.tools.map((tool) => tool.name)).toContain(
        'copy_gallery_template',
      );

      const result = (await handle.client.callTool({
        name: 'copy_gallery_template',
        arguments: { slug: 'invoice' },
      })) as { isError?: boolean; content: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('READ');
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await handle.cleanup();
    }
  });

  it('除籍・失効ではリソース一覧からもワークスペース系が消える', async () => {
    // 接続時は ADMIN、その後トークンが失効した状態 (= 未認証相当) を作る。
    const server = createMcpServer({
      mode: 'stdio',
      capabilities: capabilitiesForRole('ADMIN'),
      resolveAuthorization: () =>
        Promise.resolve(unauthenticatedAuthorization()),
    });
    const client = new Client(
      { name: 'e2e-revoked', version: '0.0.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const before = await client.listResources();
      expect(before.resources.map((resource) => resource.uri)).toContain(
        'reportflow://designs',
      );

      await client
        .callTool({ name: 'list_templates', arguments: {} })
        .catch(() => undefined);

      const after = await client.listResources();
      expect(after.resources.map((resource) => resource.uri)).not.toContain(
        'reportflow://designs',
      );
      expect(after.resources.map((resource) => resource.uri)).toContain(
        'reportflow://errors',
      );
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('降格は次の tools/list に反映される（call ガードがカタログを貼り替える）', async () => {
    const handle = await staleCatalogClient();
    try {
      await handle.client
        .callTool({ name: 'copy_gallery_template', arguments: { slug: 'x' } })
        .catch(() => undefined);

      const after = await handle.client.listTools();
      expect(after.tools.map((tool) => tool.name)).not.toContain(
        'copy_gallery_template',
      );
    } finally {
      await handle.cleanup();
    }
  });
});

describe('widget 有効時 (ChatGPT App 経路) でも権限集合がずれない', () => {
  it('widgets=1 相当でも READ の可視ツールは通常 http と同じ', async () => {
    const authorization = fixedAuthorization('READ');
    const withWidgets = createMcpServer({
      mode: 'http',
      enableWidgets: true,
      ...authorizationOptions(authorization),
    });
    const client = new Client(
      { name: 'e2e-widgets', version: '0.0.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      withWidgets.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      await toolNames('http', { role: 'READ' }),
    );
  });
});
