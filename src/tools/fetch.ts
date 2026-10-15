import { z } from 'zod';
import { templatePageUrl } from '../app-url.js';
import { listDesigns, getDesignParameters } from '../client.js';
import { getInvocationWorkspaceId } from '../telemetry/workspace.js';

/**
 * ChatGPT Apps コネクター規約の固定名ツール `fetch`。`search` が返した id
 * （`<designId>@<version>` 形式）を受け取り、デザインのパラメータスキーマを
 * 含む詳細を返す。実装は既存 get_design_parameters のラッパー。
 *
 * NOTE: getDesignParameters() の戻り値はパラメータスキーマそのもの
 * （Record<string, DesignParameter>）であり、designName / description を
 * 持たない。title は listDesigns() 側の label から解決する。
 */
export const fetchTool = {
  name: 'fetch',
  description:
    'Re:port Flow の内部テンプレートカタログから、テンプレートの id（"<designId>@<version>" 形式。version は省略可で最新版）で 1 件のテンプレート詳細（PDF 出力に必要なパラメータスキーマ）を取得します。外部サイトや Web へのアクセスは行わず、参照範囲はユーザー自身のワークスペース内に限定されます。search ツールで見つけたテンプレートの中身を確認したいときに使用します。',
};

export const fetchInputSchema = {
  id: z
    .string()
    .describe(
      'search が返したテンプレートの id。"<designId>@<version>" 形式（version 省略時は最新版）。',
    ),
};

export type FetchInput = { id: string };

export type FetchResult = {
  content: [{ type: 'text'; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

export const handleFetch = async (input: FetchInput): Promise<FetchResult> => {
  try {
    const [designId, versionStr] = input.id.split('@');
    const parsedVersion = versionStr ? Number(versionStr) : NaN;
    const version = Number.isInteger(parsedVersion) ? parsedVersion : undefined;

    const schema = await getDesignParameters(designId, version);

    // パラメータスキーマには名称が含まれないため、デザイン一覧から label を解決する。
    // 解決できない場合は designId をフォールバック表示に使う。
    let title = designId;
    // バージョン指定が無いときの画面 URL 用に、一覧の最新バージョンも拾う。
    let latestVersion: number | undefined;
    try {
      const response = await listDesigns();
      const match = response?.designs?.find((d) => d?.id === designId);
      if (match?.label) title = match.label;
      latestVersion = match?.latestVersion;
    } catch {
      // label 解決の失敗は致命的ではない（スキーマ取得が本体）。designId のまま続行。
    }

    // テンプレートの画面（`app-url.ts`）。ワークスペースは呼び出しが認証に使った
    // 資格情報のもの（API 呼び出しの後で読む）。
    const url = templatePageUrl(
      getInvocationWorkspaceId(),
      designId,
      version ?? latestVersion,
    );

    // OpenAI MCP fetch 規約では本文を表す text フィールドが必須。パラメータ
    // スキーマ JSON を本文として返し、構造化アクセス用に metadata.parameters に
    // も同じスキーマを格納する。規約に従い結果は structuredContent で返し、
    // 互換性のため content にも同じ JSON を text 複製する。
    const payload = {
      id: input.id,
      title,
      text: JSON.stringify(schema, null, 2),
      url,
      metadata: { parameters: schema },
    };
    return {
      structuredContent: payload,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (err) {
    // 失敗は構造化して返す（モデルが代替手順を自律的に探し回るのを防ぐため、
    // 誘導文は含めず error オブジェクトに機械可読な情報のみを載せる）。
    const message = err instanceof Error ? err.message : String(err);
    return {
      structuredContent: { error: { tool: 'fetch', id: input.id, message } },
      content: [{ type: 'text', text: `エラー: ${message}` }],
      isError: true,
    };
  }
};
