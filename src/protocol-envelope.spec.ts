import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import {
  normalizeInboundBody,
  shouldDropProtocolVersionHeader,
} from './protocol-envelope';

const MODERN = '2026-07-28';

type JsonRecord = Record<string, unknown>;

const message = (
  meta?: JsonRecord,
  extraParams: JsonRecord = {},
): JsonRecord => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: { ...extraParams, ...(meta === undefined ? {} : { _meta: meta }) },
});

const metaOf = (body: unknown): JsonRecord | undefined => {
  const params = (body as { params?: { _meta?: JsonRecord } }).params;
  return params?._meta;
};

describe('normalizeInboundBody', () => {
  it('2025 era を名乗るエンベロープは protocolVersion を外す (本番 -32022 の回帰)', () => {
    const input = message({
      [PROTOCOL_VERSION_META_KEY]: '2025-06-18',
      [CLIENT_CAPABILITIES_META_KEY]: {},
    });

    const { body, reasons } = normalizeInboundBody(input);

    expect(metaOf(body)).not.toHaveProperty([PROTOCOL_VERSION_META_KEY]);
    expect(reasons).toEqual(['envelope claims 2025-era revision 2025-06-18']);
  });

  it.each([
    '2024-10-07',
    '2024-11-05',
    '2025-03-26',
    '2025-06-18',
    '2025-11-25',
  ])('2025 era の %s はすべて外す', (version) => {
    const { body, reasons } = normalizeInboundBody(
      message({
        [PROTOCOL_VERSION_META_KEY]: version,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      }),
    );

    expect(metaOf(body)).not.toHaveProperty([PROTOCOL_VERSION_META_KEY]);
    expect(reasons).toHaveLength(1);
  });

  it('新世代を名乗るが clientCapabilities 欠落なら外す (本番 -32602 の回帰)', () => {
    const { body, reasons } = normalizeInboundBody(
      message({ [PROTOCOL_VERSION_META_KEY]: MODERN }),
    );

    expect(metaOf(body)).toBeUndefined();
    expect(reasons).toEqual([
      `envelope claims ${MODERN} without ${CLIENT_CAPABILITIES_META_KEY}`,
    ]);
  });

  it('protocolVersion が文字列でない壊れたエンベロープも外す', () => {
    const { body, reasons } = normalizeInboundBody(
      message({ [PROTOCOL_VERSION_META_KEY]: 42 }),
    );

    expect(metaOf(body)).toBeUndefined();
    expect(reasons).toEqual(['envelope protocolVersion is not a string']);
  });

  it('正しい新世代リクエストには触れない (同一参照を返す)', () => {
    const input = message({
      [PROTOCOL_VERSION_META_KEY]: MODERN,
      [CLIENT_CAPABILITIES_META_KEY]: {},
    });

    const { body, reasons } = normalizeInboundBody(input);

    expect(body).toBe(input);
    expect(reasons).toEqual([]);
  });

  // SDK が将来の revision に対応したとき、ここで先回りして落としていると
  // 黙って legacy へ流し続けてしまう。未知の版は SDK の判断（対応 or -32022）に任せる。
  // 既存テスト「未サポート protocolVersion は 400 + -32022」が壊れないことの保証でもある。
  it('未知の将来 revision は必須キーが揃っていれば触れない', () => {
    const input = message({
      [PROTOCOL_VERSION_META_KEY]: '2099-01-01',
      [CLIENT_CAPABILITIES_META_KEY]: {},
    });

    const { body, reasons } = normalizeInboundBody(input);

    expect(body).toBe(input);
    expect(reasons).toEqual([]);
  });

  it('旧仕様の _meta (progressToken 等) は温存する', () => {
    const { body } = normalizeInboundBody(
      message({
        [PROTOCOL_VERSION_META_KEY]: '2025-06-18',
        [CLIENT_CAPABILITIES_META_KEY]: {},
        progressToken: 'tok-1',
      }),
    );

    const meta = metaOf(body);
    expect(meta).toEqual({
      [CLIENT_CAPABILITIES_META_KEY]: {},
      progressToken: 'tok-1',
    });
  });

  it('params の他のフィールドは保持する', () => {
    const { body } = normalizeInboundBody(
      message({ [PROTOCOL_VERSION_META_KEY]: '2025-06-18' }, { cursor: 'abc' }),
    );

    expect((body as { params: JsonRecord }).params).toEqual({ cursor: 'abc' });
  });

  it('入力オブジェクトを破壊しない', () => {
    const input = message({ [PROTOCOL_VERSION_META_KEY]: '2025-06-18' });

    normalizeInboundBody(input);

    expect(metaOf(input)).toHaveProperty([PROTOCOL_VERSION_META_KEY]);
  });

  it('エンベロープ主張が無い旧クライアントは同一参照', () => {
    const input = message({ progressToken: 'tok-1' });
    expect(normalizeInboundBody(input).body).toBe(input);
  });

  it('_meta を持たないリクエストは同一参照', () => {
    const input = message();
    expect(normalizeInboundBody(input).body).toBe(input);
  });

  it.each([
    ['null', null],
    ['文字列', 'not-json-rpc'],
    ['params が配列', { jsonrpc: '2.0', method: 'x', params: [1, 2] }],
    ['_meta が配列', { jsonrpc: '2.0', method: 'x', params: { _meta: [] } }],
  ])('JSON-RPC として扱えない body (%s) は同一参照', (_label, input) => {
    expect(normalizeInboundBody(input).body).toBe(input);
  });

  describe('バッチ (配列 body)', () => {
    it('該当する要素だけ外し、理由を件数分返す', () => {
      const input = [
        message({ [PROTOCOL_VERSION_META_KEY]: '2025-06-18' }),
        message({
          [PROTOCOL_VERSION_META_KEY]: MODERN,
          [CLIENT_CAPABILITIES_META_KEY]: {},
        }),
        message({ [PROTOCOL_VERSION_META_KEY]: MODERN }),
      ];

      const { body, reasons } = normalizeInboundBody(input);
      const entries = body as JsonRecord[];

      expect(metaOf(entries[0])).toBeUndefined();
      expect(entries[1]).toBe(input[1]);
      expect(metaOf(entries[2])).toBeUndefined();
      expect(reasons).toHaveLength(2);
    });

    it('外す要素が無ければ同一参照', () => {
      const input = [message(), message({ progressToken: 't' })];
      expect(normalizeInboundBody(input).body).toBe(input);
    });
  });
});

describe('shouldDropProtocolVersionHeader', () => {
  it.each([
    ['未設定', undefined, false],
    ['2025 era の値は温存', '2025-06-18', false],
    ['新世代を名乗る値は外す', '2026-07-28', true],
    ['未知の値も外す', '2099-01-01', true],
    ['空文字は何もしない', '', false],
    ['空白のみは何もしない', '   ', false],
  ])('%s', (_label, header, expected) => {
    expect(shouldDropProtocolVersionHeader(header as string | undefined)).toBe(
      expected,
    );
  });

  it('配列ヘッダーは先頭要素で判定する', () => {
    expect(shouldDropProtocolVersionHeader(['2026-07-28', '2025-06-18'])).toBe(
      true,
    );
    expect(shouldDropProtocolVersionHeader(['2025-06-18'])).toBe(false);
  });
});
