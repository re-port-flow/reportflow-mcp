import { z } from 'zod';
import { listDesigns } from '../client.js';

/**
 * ChatGPT Apps コネクター規約の固定名ツール `search`。
 * ChatGPT は Developer Mode 無し（一般 Apps 経路）の MCP サーバーに対して
 * `search(query)` / `fetch(id)` の 2 ツールが存在することを期待する。これらは
 * 単一文字列引数であることが規約上前提のため、複雑な object 引数は取らない。
 *
 * 実装は既存 list_templates (listDesigns) のラッパー。デザイン名 (label) の
 * 部分一致でフィルタし、id / title / url を返す。id は fetch とペアを揃えるため
 * `<designId>@<latestVersion>` 形式にする。
 */
export const searchTool = {
  name: 'search',
  description:
    'Re:port Flow の内部テンプレートカタログ（ユーザー自身のワークスペースに登録済みのデザイン）から、名称の部分一致でテンプレートを解決し、各ヒットの id・title・url を返します。外部サイトや Web の検索は一切行わず、参照範囲は当該ワークスペース内に限定されます。請求書・見積書などのテンプレートを探したいときに使用します。返した id（"<designId>@<version>" 形式）は fetch ツールに渡してパラメータ詳細を取得できます。',
};

export const searchInputSchema = {
  query: z
    .string()
    .optional()
    .describe(
      '検索キーワード（デザイン名の部分一致）。省略・空文字なら全件を返す。',
    ),
};

export type SearchInput = { query?: string };

export type SearchResult = {
  content: [{ type: 'text'; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

export const handleSearch = async (
  input: SearchInput,
): Promise<SearchResult> => {
  try {
    const response = await listDesigns();
    const designs = response?.designs ?? [];
    const q = (input.query ?? '').trim().toLowerCase();
    const hits = designs
      .filter((d) => q === '' || (d?.label ?? '').toLowerCase().includes(q))
      .map((d) => ({
        id: `${d?.id ?? ''}@${d?.latestVersion ?? ''}`,
        title: d?.label ?? '',
        url: `https://re-port-flow.com/designs/${d?.id ?? ''}`,
      }));
    // OpenAI MCP search 規約は結果を structuredContent で返すことを要求する。
    // 互換性のため content にも同じ JSON を text 複製する。
    const payload = { results: hits };
    return {
      structuredContent: payload,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (err) {
    // 失敗は構造化して返す（モデルが代替手順を自律的に探し回るのを防ぐため、
    // 誘導文は含めず error オブジェクトに機械可読な情報のみを載せる）。
    const message = err instanceof Error ? err.message : String(err);
    return {
      structuredContent: { error: { tool: 'search', message } },
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
