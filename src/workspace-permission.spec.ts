import {
  applyCapabilities,
  capabilitiesForRole,
  PUBLIC_CAPABILITIES,
  requiredCapabilityForResource,
  requiredCapabilityForTool,
  RESOURCE_CAPABILITIES,
  roleFromAuthTypeCode,
  sameCapabilities,
  TOOL_CAPABILITIES,
  UnknownCapabilitySubjectError,
  type CapabilityToggle,
  type WorkspaceCapability,
  type WorkspaceRole,
} from './workspace-permission';

describe('roleFromAuthTypeCode', () => {
  it.each([
    ['001', 'ADMIN'],
    ['002', 'WRITE'],
    ['003', 'READ'],
    ['004', 'UNREAD'],
  ] as const)('%s → %s', (code, expected) => {
    expect(roleFromAuthTypeCode(code)).toBe(expected);
  });

  it('前後の空白は正規化する（char(3) の表記ゆれで ADMIN が権限を失わない）', () => {
    expect(roleFromAuthTypeCode(' 001 ')).toBe('ADMIN');
  });

  // 未知値を許可側へ倒さない（親タスク Must の fail-closed）。
  it.each([
    ['005', '将来 reposts-api に増えたロール'],
    ['', '空文字'],
    ['ADMIN', 'コードではなく名前'],
    ['1', 'ゼロ埋めなし'],
  ])('未知のコード %s は UNKNOWN (%s)', (code) => {
    expect(roleFromAuthTypeCode(code)).toBe('UNKNOWN');
  });

  // `Object.prototype` 由来のキーで「未知は UNKNOWN」が崩れないこと。
  // 素の索引参照だと `constructor` は `Object` 関数を返し `?? 'UNKNOWN'` を
  // 素通りする（CodeRabbit の指摘で発見・再現確認済み）。
  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'プロトタイプ継承キー "%s" も UNKNOWN',
    (code) => {
      expect(roleFromAuthTypeCode(code)).toBe('UNKNOWN');
    },
  );

  it.each<[string, unknown]>([
    ['キー欠落', undefined],
    ['null', null],
    ['数値', 1],
    ['オブジェクト', { authTypeCode: '001' }],
    ['配列', ['001']],
  ])('文字列でない値 (%s) は UNKNOWN', (_label, raw) => {
    expect(roleFromAuthTypeCode(raw)).toBe('UNKNOWN');
  });
});

describe('capabilitiesForRole（ST-1 確定マトリクス）', () => {
  const expected: Record<WorkspaceRole, WorkspaceCapability[]> = {
    ADMIN: [
      'public',
      'workspace.read',
      'workspace.generate',
      'workspace.write',
    ],
    WRITE: [
      'public',
      'workspace.read',
      'workspace.generate',
      'workspace.write',
    ],
    // ST-1 判断1 = 案A: READ にも PDF 生成を許可する（Web UI の既存仕様に揃える）。
    READ: ['public', 'workspace.read', 'workspace.generate'],
    UNREAD: ['public'],
    UNKNOWN: ['public'],
  };

  it.each(Object.keys(expected) as WorkspaceRole[])(
    '%s の capability 集合が確定表と完全一致する',
    (role) => {
      expect([...capabilitiesForRole(role)].sort()).toEqual(
        [...expected[role]].sort(),
      );
    },
  );

  it('READ は workspace.write を持たない（copy_gallery_template が唯一の差）', () => {
    expect(capabilitiesForRole('READ').has('workspace.write')).toBe(false);
  });

  it('UNREAD / UNKNOWN は public だけ（未認証と同じ底）', () => {
    for (const role of ['UNREAD', 'UNKNOWN'] as const) {
      expect(
        sameCapabilities(capabilitiesForRole(role), PUBLIC_CAPABILITIES),
      ).toBe(true);
    }
  });

  // 空集合にすると `public` すら落ち、認証と無関係な公開ギャラリーツールまで
  // 消える。fail-closed の写り先は「public のみ」であって「全部拒否」ではない。
  it('表に無い値を渡されても空集合にはせず public を残す', () => {
    const bogus = 'NOT_A_ROLE' as unknown as WorkspaceRole;
    expect([...capabilitiesForRole(bogus)]).toEqual(['public']);
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'プロトタイプ継承キー "%s" でも public のみ',
    (key) => {
      const bogus = key as unknown as WorkspaceRole;
      expect([...capabilitiesForRole(bogus)]).toEqual(['public']);
    },
  );

  it('返す Set を書き換えても次の呼び出しに影響しない（表そのものを渡さない）', () => {
    const first = capabilitiesForRole('READ') as Set<WorkspaceCapability>;
    first.add('workspace.write');
    expect(capabilitiesForRole('READ').has('workspace.write')).toBe(false);
  });
});

describe('ツール別の可視集合（role → 許可ツール名）', () => {
  const toolsFor = (role: WorkspaceRole): string[] => {
    const granted = capabilitiesForRole(role);
    return Object.keys(TOOL_CAPABILITIES)
      .filter((name) => granted.has(requiredCapabilityForTool(name)))
      .sort();
  };

  const PUBLIC_TOOLS = [
    'authenticate',
    'get_gallery_template',
    'search_gallery_templates',
  ];
  const READ_TOOLS = [
    ...PUBLIC_TOOLS,
    'download_file',
    'download_zip',
    'fetch',
    'generate_pdf_async',
    'generate_pdf_sync',
    'generate_pdfs_async',
    'generate_pdfs_sync',
    'get_design_parameters',
    'get_generation_status',
    'list_templates',
    'search',
    'suggest_params',
  ].sort();

  // 仕様変更 (PRJ-3-2018): get_generation_status を追加して 15 → 16
  it('ADMIN / WRITE は全 16 ツール', () => {
    const all = Object.keys(TOOL_CAPABILITIES).sort();
    expect(all).toHaveLength(16);
    expect(toolsFor('ADMIN')).toEqual(all);
    expect(toolsFor('WRITE')).toEqual(all);
  });

  it('READ は copy_gallery_template だけが欠ける', () => {
    expect(toolsFor('READ')).toEqual(READ_TOOLS);
    expect(toolsFor('READ')).not.toContain('copy_gallery_template');
  });

  it.each(['UNREAD', 'UNKNOWN'] as const)(
    '%s は公開ギャラリー 2 種 + authenticate だけ（ST-1 判断3）',
    (role) => {
      expect(toolsFor(role)).toEqual([...PUBLIC_TOOLS].sort());
    },
  );
});

describe('requiredCapabilityForTool / ForResource', () => {
  it('表にあるツールは capability を返す', () => {
    expect(requiredCapabilityForTool('copy_gallery_template')).toBe(
      'workspace.write',
    );
    expect(requiredCapabilityForTool('download_zip')).toBe('workspace.read');
    expect(requiredCapabilityForTool('get_generation_status')).toBe(
      'workspace.read',
    );
  });

  // 既定を「許可」にしないことの確認。表に載せ忘れたツールは登録時に落ちる。
  it('表に無いツール名は UnknownCapabilitySubjectError', () => {
    expect(() => requiredCapabilityForTool('delete_everything')).toThrow(
      UnknownCapabilitySubjectError,
    );
  });

  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'プロトタイプ継承キー "%s" のツール名も throw する（関数を返さない）',
    (name) => {
      expect(() => requiredCapabilityForTool(name)).toThrow(
        UnknownCapabilitySubjectError,
      );
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'プロトタイプ継承キー "%s" のリソース名も throw する',
    (name) => {
      expect(() => requiredCapabilityForResource(name)).toThrow(
        UnknownCapabilitySubjectError,
      );
    },
  );

  it('表に無いリソース名も UnknownCapabilitySubjectError', () => {
    expect(() => requiredCapabilityForResource('unknown-resource')).toThrow(
      UnknownCapabilitySubjectError,
    );
  });

  it('ワークスペース API を叩くリソースは workspace.read、静的リソースは public', () => {
    expect(RESOURCE_CAPABILITIES['designs']).toBe('workspace.read');
    expect(RESOURCE_CAPABILITIES['design-parameters']).toBe('workspace.read');
    expect(RESOURCE_CAPABILITIES['errors']).toBe('public');
    expect(RESOURCE_CAPABILITIES['server-info']).toBe('public');
    // widget 経路 (ChatGPT App) だけ権限集合がずれないよう、同じ表から引く。
    expect(RESOURCE_CAPABILITIES['template-list-widget']).toBe('public');
  });
});

describe('sameCapabilities', () => {
  it('中身が同じなら参照が違っても true', () => {
    expect(
      sameCapabilities(
        new Set(['public', 'workspace.read']),
        new Set(['workspace.read', 'public']),
      ),
    ).toBe(true);
  });

  it('件数が同じでも中身が違えば false', () => {
    expect(
      sameCapabilities(
        new Set(['workspace.read']),
        new Set(['workspace.write']),
      ),
    ).toBe(false);
  });

  it('部分集合は false（縮小も変化として検出する）', () => {
    expect(
      sameCapabilities(
        new Set(['public', 'workspace.read']),
        new Set(['public']),
      ),
    ).toBe(false);
  });
});

describe('applyCapabilities', () => {
  const toggle = (enabled: boolean): CapabilityToggle => {
    const state = {
      enabled,
      enable: () => {
        state.enabled = true;
      },
      disable: () => {
        state.enabled = false;
      },
    };
    return state;
  };

  const required = (name: string): WorkspaceCapability =>
    requiredCapabilityForTool(name);

  it('許可されないものを disable し、許可されたものを enable する', () => {
    const registrations = new Map<string, CapabilityToggle>([
      ['list_templates', toggle(true)],
      ['copy_gallery_template', toggle(true)],
      ['search_gallery_templates', toggle(false)],
    ]);

    const changed = applyCapabilities(
      registrations,
      capabilitiesForRole('READ'),
      required,
    );

    expect(changed).toBe(true);
    expect(registrations.get('list_templates')?.enabled).toBe(true);
    expect(registrations.get('copy_gallery_template')?.enabled).toBe(false);
    expect(registrations.get('search_gallery_templates')?.enabled).toBe(true);
  });

  it('状態が既に一致していれば false（無変化で list_changed を送らないため）', () => {
    const registrations = new Map<string, CapabilityToggle>([
      ['list_templates', toggle(true)],
      ['copy_gallery_template', toggle(false)],
    ]);

    expect(
      applyCapabilities(registrations, capabilitiesForRole('READ'), required),
    ).toBe(false);
  });

  it('未認証相当では workspace 系がすべて無効になる', () => {
    const registrations = new Map<string, CapabilityToggle>(
      Object.keys(TOOL_CAPABILITIES).map((name) => [name, toggle(true)]),
    );

    applyCapabilities(registrations, PUBLIC_CAPABILITIES, required);

    const enabled = [...registrations.entries()]
      .filter(([, registration]) => registration.enabled)
      .map(([name]) => name)
      .sort();
    expect(enabled).toEqual([
      'authenticate',
      'get_gallery_template',
      'search_gallery_templates',
    ]);
  });

  it('表に無い名前が混ざっていれば throw する（黙って許可しない）', () => {
    const registrations = new Map<string, CapabilityToggle>([
      ['not_in_table', toggle(true)],
    ]);
    expect(() =>
      applyCapabilities(registrations, PUBLIC_CAPABILITIES, required),
    ).toThrow(UnknownCapabilitySubjectError);
  });
});
