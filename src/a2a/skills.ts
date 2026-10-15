/**
 * A2A (Agent2Agent) で公開する skill の一覧。
 *
 * **skill の id は MCP ツール名そのもの。** A2A の SendMessage は、
 * 同じプロセス内の MCP ハンドラへ `tools/call` として流す (`./jsonrpc.ts`)。
 * 認可・ワークスペース権限・テレメトリを MCP クライアントと同じ経路に揃える
 * ためで、A2A 専用の実装を二重に持たない。id と MCP ツール名がずれると
 * 「カードに載っているのに呼ぶと必ず失敗する skill」になるので、
 * `skills.spec.ts` が HTTP モードで実際に登録されるツール名と突き合わせる。
 *
 * 公開するのは HTTP モードのツールのうち帳票作成の導線に要るものだけ。
 * `search` / `fetch` は ChatGPT コネクタ向けの汎用検索で、A2A の skill として
 * 名乗る意味が無いため載せない。`suggest_params` も載せない: 提案の生成は
 * クライアント側の Sampling に頼っており、A2A 経由の呼び出しは Sampling を
 * 持たないので、常にスキーマのフォールバックしか返せない (説明文を無視する)。
 */
export type A2aSkillDefinition = {
  /** MCP ツール名 = A2A skill id。 */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples: readonly string[];
};

/** SendMessage の data part で skill と引数を渡す形の例 (examples に載せる)。 */
const invocationExample = (
  skill: string,
  args: Record<string, unknown>,
): string => JSON.stringify({ skill, arguments: args });

export const A2A_SKILLS: readonly A2aSkillDefinition[] = [
  {
    id: 'search_gallery_templates',
    name: 'Search the public template gallery',
    description:
      'Searches the public Re:port Flow template gallery (invoices, quotations, delivery notes and more). Use it when the workspace has no template that fits.',
    tags: ['templates', 'gallery', 'search'],
    examples: [
      'Find an invoice template in the gallery.',
      invocationExample('search_gallery_templates', { query: 'invoice' }),
    ],
  },
  {
    id: 'get_gallery_template',
    name: 'Get a gallery template',
    description:
      'Returns the details of one public gallery template so a caller can decide whether to copy it into the workspace.',
    tags: ['templates', 'gallery'],
    examples: ['Show me the details of this gallery template.'],
  },
  {
    id: 'copy_gallery_template',
    name: 'Copy a gallery template into the workspace',
    description:
      "Copies a public gallery template into the caller's workspace and returns the new template's designId. Every call creates a new template, so copy a gallery template once and reuse the returned designId.",
    tags: ['templates', 'gallery', 'workspace'],
    examples: ['Copy the standard invoice template into my workspace.'],
  },
  {
    id: 'list_templates',
    name: 'List workspace templates',
    description:
      "Lists the templates that already exist in the caller's workspace, with the designId (template ID) a later skill needs.",
    tags: ['templates', 'workspace', 'catalog'],
    examples: [
      'Which templates are in my workspace?',
      invocationExample('list_templates', {}),
    ],
  },
  {
    id: 'get_design_parameters',
    name: "Get a template's parameter schema",
    description:
      'Returns the parameters a template needs, so the caller knows which values to supply before generating a PDF.',
    tags: ['templates', 'schema', 'parameters'],
    examples: [
      'What fields does this invoice template require?',
      invocationExample('get_design_parameters', { designId: '<designId>' }),
    ],
  },
  {
    id: 'generate_pdf_sync',
    name: 'Generate a PDF',
    description:
      "Generates one PDF from a template and the supplied parameters and returns the URL of its output-history page in the Re:port Flow web app (sign-in required; not a direct file download link). Generating consumes the workspace's monthly page quota, so do not retry blindly.",
    tags: ['pdf', 'generation', 'documents'],
    examples: [
      invocationExample('generate_pdf_sync', {
        designId: '<designId>',
        version: 1,
        content: { fileName: 'invoice.pdf', params: {} },
      }),
    ],
  },
  {
    id: 'generate_pdfs_async',
    name: 'Generate PDFs in bulk',
    description:
      "Starts a bulk generation job that produces several PDFs from one template. Consumes the workspace's monthly page quota.",
    tags: ['pdf', 'generation', 'bulk'],
    examples: [
      invocationExample('generate_pdfs_async', {
        designId: '<designId>',
        version: 1,
        contents: [{ fileName: 'a.pdf', params: {} }],
      }),
    ],
  },
  {
    // generate_pdfs_async で始めたジョブの完了・失敗を確かめる手段 (PRJ-3-2018)。
    // これが無いと A2A の呼び出し側はバッチの結果を知る方法を持たない。
    id: 'get_generation_status',
    name: 'Get the status of a generation job',
    description:
      'Returns the state of a generation request (queued / processing / completed / failed) by its requestId, with the files, per-file failures and the failure reason. Read-only; poll it after generate_pdfs_async, waiting retryAfterSeconds between calls.',
    tags: ['pdf', 'generation', 'status'],
    examples: [
      invocationExample('get_generation_status', {
        requestId: '<requestId>',
      }),
    ],
  },
];

export const A2A_SKILL_IDS: ReadonlySet<string> = new Set(
  A2A_SKILLS.map((s) => s.id),
);
