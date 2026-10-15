// ワークスペース権限の正準定義 (PRJ-3-1584 / ST-1・ST-3)。
//
// ## なぜ 1 ファイルに閉じるのか
// これまで `tools/list` は `mode` だけでツールを登録し、workspace のロールを
// 一切見ていなかった。READ 権限のワークスペースを OAuth 同意で選んでも、書き込み
// ツール (`copy_gallery_template`) が一覧に出て、そのまま呼べた。
//
// 直し方として「一覧から隠す」と「呼び出しを拒む」を別々のリストで持つと、
// 片方だけ更新された瞬間に**隠れているのに呼べる**（またはその逆）になる。
// ツール → 必要 capability の対応をここ 1 箇所に置き、`tools/list` のフィルタと
// `tools/call` のガードの**両方**がこの表だけを読む。
//
// ## 認可の 3 レイヤーは独立条件（どれか 1 つでも欠ければ拒否）
// 1. OAuth scope      : アプリに与えた権限の上限（`config.ts` の SUPPORTED_SCOPES）
// 2. workspace role   : そのワークスペースでの人の権限（ここ）
// 3. 上流 API の認可  : reposts-api / content-service が独自に再検査する
//
// scope は「そのアプリが何を要求したか」しか言わず、**人の権限の代わりにはならない**
// （READ メンバーでも `designs:write` scope のトークンは発行される）。逆に role を
// 満たしていても scope が無ければ上流で 403 になる。この 2 つを混ぜないこと。
//
// ## ここはツールを隠す層ではなく、認可の層
// ツール非表示は UX でしかない（クライアントは一覧に無い名前でも `tools/call`
// できる）。認可境界は `tools/call` のガードと上流 API 側の検査であり、この表は
// その 2 つが同じ判断をするための共有定義である。

/**
 * ワークスペースにおける実効ロール。
 *
 * 値は reposts-api の `AuthType`（`applications/domain/entity/member.entity.ts`）
 * と 1:1 で対応する。`UNKNOWN` は「reposts-api が契約外の値を返した」であって
 * 「権限が無い」ではないが、**扱いは UNREAD と同じ（ワークスペース権限なし）**に
 * 倒す（fail-closed）。
 */
export type WorkspaceRole = 'ADMIN' | 'WRITE' | 'READ' | 'UNREAD' | 'UNKNOWN';

/**
 * ツール / リソースが要求する権限の単位。
 *
 * - `public`             : 認証不要。公開ギャラリー API と静的リソース、および
 *                          stdio の `authenticate`（これが隠れると認証できない）。
 * - `workspace.read`     : ワークスペース内デザインの参照と、**生成済みファイルの
 *                          取得**（ST-1 判断2: download_* は参照 capability）。
 * - `workspace.generate` : PDF の新規生成（ST-1 判断1 = 案A により READ にも許可）。
 * - `workspace.write`    : ワークスペースにデザインを作る操作（テンプレート複製）。
 */
export type WorkspaceCapability =
  | 'public'
  | 'workspace.read'
  | 'workspace.generate'
  | 'workspace.write';

/** 認証できていない / ロールを解決できないときに残る capability（fail-closed の底）。 */
export const PUBLIC_CAPABILITIES: ReadonlySet<WorkspaceCapability> =
  new Set<WorkspaceCapability>(['public']);

/**
 * reposts-api の `memberAuth.authTypeCode` → ロール。
 *
 * コードは `m_member.auth_type_code`（`char(3)`）の実値。ここを「未知なら READ」
 * のような寛容な既定にすると、reposts-api 側でロールが 1 つ増えた日に、その新ロール
 * が黙って既存権限を得る。**未知は必ず `UNKNOWN`**（= ワークスペース権限なし）。
 */
const AUTH_TYPE_CODE_TO_ROLE: Readonly<Record<string, WorkspaceRole>> = {
  '001': 'ADMIN',
  '002': 'WRITE',
  '003': 'READ',
  '004': 'UNREAD',
};

/**
 * `memberAuth.authTypeCode` をロールへ写す純関数。
 *
 * 文字列以外（欠落 / null / 数値 / オブジェクト）は `UNKNOWN`。
 *
 * 前後の空白だけは落とす。これは**値の推測ではなく正規化**で、値の出所は
 * 自社 API の `char(3)` カラム 1 つに限られる。トリムしないと、上流の 1 文字の
 * 表記ゆれだけで ADMIN が丸ごと権限を失う（可用性の事故）——一方、トリムしても
 * 攻撃者が権限を上げる経路は生まれない（この値を攻撃者は書けない）。
 */
export const roleFromAuthTypeCode = (raw: unknown): WorkspaceRole => {
  if (typeof raw !== 'string') return 'UNKNOWN';
  const code = raw.trim();
  // **`Object.hasOwn` で自前プロパティだけを見る。** 素の索引参照だと
  // `AUTH_TYPE_CODE_TO_ROLE['constructor']` が `Object` 関数を返し、`?? 'UNKNOWN'`
  // を素通りする（`toString` / `valueOf` / `__proto__` も同様）。そのまま
  // `capabilitiesForRole` へ渡ると `ROLE_CAPABILITIES[<関数>]` が undefined になり、
  // capability が **空集合**（`public` すら無い）になる。権限昇格ではないが、
  // 宣言した fail-closed の写り先（UNKNOWN → public のみ）とは別の状態で、
  // 公開ギャラリーツールまで消える（CodeRabbit の指摘で発見・再現確認済み）。
  return Object.hasOwn(AUTH_TYPE_CODE_TO_ROLE, code)
    ? AUTH_TYPE_CODE_TO_ROLE[code]
    : 'UNKNOWN';
};

/**
 * ロール → capability の確定表（ST-1 で人間が確定した権限マトリクス）。
 *
 * | capability          | ADMIN | WRITE | READ | UNREAD / 非所属 / 未認証 |
 * |---------------------|-------|-------|------|--------------------------|
 * | public              | ✅    | ✅    | ✅   | ✅                       |
 * | workspace.read      | ✅    | ✅    | ✅   | ❌                       |
 * | workspace.generate  | ✅    | ✅    | ✅   | ❌                       |
 * | workspace.write     | ✅    | ✅    | ❌   | ❌                       |
 *
 * READ に `workspace.generate` があるのは ST-1 判断1 の**案A（現行維持）**。
 * reposts-api の `file.usecase.ts generateSyncFile` に「出力ボタンは従来から
 * ロール制限が無く READ メンバーも押せる」と明記された既存仕様に揃える。
 * ここを案B/C（READ の生成禁止）へ変える場合は、この 1 行と content-service 側の
 * 許可ロール、developer-docs の表を同時に直すこと。
 */
const ROLE_CAPABILITIES: Readonly<
  Record<WorkspaceRole, readonly WorkspaceCapability[]>
> = {
  ADMIN: ['public', 'workspace.read', 'workspace.generate', 'workspace.write'],
  WRITE: ['public', 'workspace.read', 'workspace.generate', 'workspace.write'],
  READ: ['public', 'workspace.read', 'workspace.generate'],
  UNREAD: ['public'],
  UNKNOWN: ['public'],
};

/**
 * ロールが持つ capability 集合（純関数。呼び出し側は変更しない前提の読み取り専用）。
 *
 * 表に無い値を渡されても**空集合にはしない**。`public` すら落とすと、認証と無関係な
 * 公開ギャラリーツールまで消えて「fail-closed」ではなく「全部壊れる」になる。
 * 型の外から来た値（実行時の契約違反）に対する最後の受け皿。
 */
export const capabilitiesForRole = (
  role: WorkspaceRole,
): ReadonlySet<WorkspaceCapability> =>
  new Set<WorkspaceCapability>(
    Object.hasOwn(ROLE_CAPABILITIES, role)
      ? ROLE_CAPABILITIES[role]
      : ROLE_CAPABILITIES.UNKNOWN,
  );

/**
 * ツール名 → 必要 capability の正準表。
 *
 * **`annotations.readOnlyHint` を認可判断に使わない。** あれはクライアント AI 向けの
 * ヒントで、`download_file` のように「読み取りに見えて書き込む」ものもあり
 * (server.ts のコメント参照)、実際 `readOnlyHint: false` が付いている。
 * 認可はこの表だけを根拠にする。
 *
 * ここに無い名前のツールを登録すると `requiredCapabilityForTool` が throw する
 * （= 起動時 / テスト時に落ちる）。表に載せ忘れたツールが「capability 不明のまま
 * 誰でも呼べる」状態で出荷されるのを防ぐため、既定を「許可」にはしない。
 */
export const TOOL_CAPABILITIES: Readonly<Record<string, WorkspaceCapability>> =
  {
    // 認証導線そのもの。隠すと stdio ユーザーは認証できなくなる。
    authenticate: 'public',
    // 公開ギャラリー API は認証不要（gallery-client.ts は Authorization を付けない）。
    search_gallery_templates: 'public',
    get_gallery_template: 'public',
    // ワークスペース内デザインの参照。
    list_templates: 'workspace.read',
    get_design_parameters: 'workspace.read',
    search: 'workspace.read',
    fetch: 'workspace.read',
    // Sampling 経由だが、参照するのはワークスペース内デザインのパラメータ。
    suggest_params: 'workspace.read',
    // 生成済みファイルの取得（ST-1 判断2: 参照 capability）。
    download_file: 'workspace.read',
    download_zip: 'workspace.read',
    // 生成リクエストの状態確認 (PRJ-3-2018)。download_* と同じく生成物の参照。
    get_generation_status: 'workspace.read',
    // PDF の新規生成。
    generate_pdf_sync: 'workspace.generate',
    generate_pdf_async: 'workspace.generate',
    generate_pdfs_sync: 'workspace.generate',
    generate_pdfs_async: 'workspace.generate',
    // ワークスペースへデザインを 1 件作る（唯一の書き込みツール）。
    copy_gallery_template: 'workspace.write',
  };

/**
 * リソース名 → 必要 capability の正準表（`registerResource` の第 1 引数と一致）。
 *
 * `designs` / `design-parameters` は content-service のワークスペース API を叩く。
 * `errors` / `server-info` / widget は静的テキストなので `public`。
 */
export const RESOURCE_CAPABILITIES: Readonly<
  Record<string, WorkspaceCapability>
> = {
  designs: 'workspace.read',
  'design-parameters': 'workspace.read',
  errors: 'public',
  'server-info': 'public',
  'template-list-widget': 'public',
};

/** 表に無いツール名を登録した / 呼び出したことを示すプログラミングエラー。 */
export class UnknownCapabilitySubjectError extends Error {
  constructor(kind: 'tool' | 'resource', name: string) {
    super(
      `${kind} "${name}" has no entry in the workspace capability table (src/workspace-permission.ts)`,
    );
    this.name = 'UnknownCapabilitySubjectError';
  }
}

/** ツールが要求する capability。未登録の名前は throw（既定許可にしない）。 */
export const requiredCapabilityForTool = (
  toolName: string,
): WorkspaceCapability => {
  // `Object.hasOwn` の理由は `roleFromAuthTypeCode` と同じ。素の索引参照では
  // `requiredCapabilityForTool('toString')` が throw せず関数を返す。
  if (!Object.hasOwn(TOOL_CAPABILITIES, toolName)) {
    throw new UnknownCapabilitySubjectError('tool', toolName);
  }
  return TOOL_CAPABILITIES[toolName];
};

/** リソースが要求する capability。未登録の名前は throw（既定許可にしない）。 */
export const requiredCapabilityForResource = (
  resourceName: string,
): WorkspaceCapability => {
  if (!Object.hasOwn(RESOURCE_CAPABILITIES, resourceName)) {
    throw new UnknownCapabilitySubjectError('resource', resourceName);
  }
  return RESOURCE_CAPABILITIES[resourceName];
};

/**
 * 2 つの capability 集合が同じか（stdio でツール一覧を貼り替えるべきかの判定）。
 * `Set` は参照比較になるため、中身で比べる小さなヘルパーを置く。
 */
export const sameCapabilities = (
  a: ReadonlySet<WorkspaceCapability>,
  b: ReadonlySet<WorkspaceCapability>,
): boolean => a.size === b.size && [...a].every((value) => b.has(value));

/**
 * `RegisteredTool` / `RegisteredResource` / `RegisteredResourceTemplate` が
 * 共通で持つ有効・無効の切り替え口（SDK v2 の公式 API）。
 *
 * 内部実装へ手を入れず、この 3 つだけで `tools/list` / `resources/list` の
 * 見え方を変える。SDK の型そのものを import しないのは、3 種の登録ハンドルを
 * 1 つの関数で扱うため（構造的部分型で十分で、テストのフェイクも書ける）。
 */
export type CapabilityToggle = {
  enabled: boolean;
  enable(): void;
  disable(): void;
};

/**
 * 登録ハンドル群へ capability 集合を適用する。1 つでも状態が変われば `true`。
 *
 * 戻り値を見て `sendToolListChanged()` を送るかどうかを決める（無変化でも毎回
 * 通知を送ると、クライアントが一覧を取り直し続ける）。
 */
export const applyCapabilities = (
  registrations: ReadonlyMap<string, CapabilityToggle>,
  granted: ReadonlySet<WorkspaceCapability>,
  requiredFor: (name: string) => WorkspaceCapability,
): boolean => {
  let changed = false;
  for (const [name, registration] of registrations) {
    const allowed = granted.has(requiredFor(name));
    if (registration.enabled === allowed) continue;
    if (allowed) registration.enable();
    else registration.disable();
    changed = true;
  }
  return changed;
};
