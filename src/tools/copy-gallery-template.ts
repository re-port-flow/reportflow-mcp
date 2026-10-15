import { z } from 'zod';
import {
  duplicateGalleryTemplate,
  getGalleryTemplateBySlug,
  GalleryTemplateNotFoundError,
} from '../gallery-client.js';
import type {
  DuplicateGalleryTemplateResponse,
  GalleryTemplateDetail,
} from '../gallery-client.js';
import { AuthRequiredError, getAuthWorkspaceId } from '../auth.js';
import { HttpError, WRITE_REJECTED_STATUSES } from '../http.js';
import type { GalleryCopyObservation } from '../telemetry/gallery-demand.js';

/**
 * ギャラリーテンプレートの複製ツール。report-mcp 初の書き込みツール (PRJ-3-1238)。
 *
 * 複製先ワークスペースはアクセストークン JWT の workspace_id（同意画面で
 * ユーザーが選んだワークスペース）に固定し、ツール引数では一切受け取らない。
 * 引数で受けると AI に他ワークスペース ID を推測・指定させる余地を与えるため。
 */
export const copyGalleryTemplateTool = {
  name: 'copy_gallery_template',
  description:
    '公開テンプレートギャラリーのテンプレートを、認可時に選択した自分のワークスペースへ複製します（要認証・ワークスペースの編集者以上）。複製先ワークスペースは接続時の認可で決まっており、引数で変更できません。成功すると designId と version を返すので、そのまま get_design_parameters → generate_pdf_sync に渡して PDF の出力へ進めます。slug は search_gallery_templates / get_gallery_template で確認してください。注意: 呼ぶたびに新しいテンプレートが 1 件作成されます（同じ slug でも既存の複製は再利用されません）。同じテンプレートを誤って何度も複製しないでください。',
};

export const copyGalleryTemplateInputSchema = {
  slug: z
    .string()
    .min(1)
    .describe(
      '複製するテンプレートの slug（search_gallery_templates の結果から取得）',
    ),
};

export type CopyGalleryTemplateInput = {
  slug: string;
};

export type CopyGalleryTemplateResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

/**
 * 失敗の戻り値。`CopyOutcome` を返すので `workspaceId` は付かない —— 複製が
 * 成立していない呼び出しに帰属を付けないことを型で保証する。
 *
 * `outcomeUnknown` は「失敗として返すが、サーバー側で複製が完了している可能性が
 * ある」ことを表す（既定は false = 複製が起きていないと確定している）。
 */
const errorResult = (
  text: string,
  { outcomeUnknown = false }: { outcomeUnknown?: boolean } = {},
): CopyOutcome => ({
  result: {
    content: [{ type: 'text', text: `エラー: ${text}` }],
    isError: true,
  },
  ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
});

/**
 * `describeDuplicateError` の戻り値。文言と `outcomeUnknown` を**同じ分岐**から
 * 返すのが要点。
 *
 * 「完了したかは不明」と書く分岐と、テレメトリへ不明フラグを立てる分岐を別々に
 * 持つと、片方だけ増えたときに黙ってずれる（文言は不明・記録は失敗確定）。
 * 1 つの switch から両方を出せば、ずれようが無い。
 */
type DuplicateErrorDescription = {
  text: string;
  /** 複製が完了したか判定できない（サーバー側で成功している可能性がある）。 */
  outcomeUnknown?: true;
};

/**
 * 複製 POST のエラーを AI が次の一手を選べる形に写す。
 * - 401/403/404/412/429/5xx/タイムアウト/未到達を区別する
 * - タイムアウト・5xx は「失敗した」と断定しない（サーバー側で成功している
 *   可能性があり、再試行すると二重複製になるため）
 * - 逆に 412 はガードによる門前払いが確定しているため、二重複製の警告を出さず
 *   「呼び直しても直らない」と伝える（PRJ-3-1245）。ただしクライアントの
 *   送信もれとは断定しない（この分岐は app-key を送る版にしか存在しない）
 * - 未認可は経路ごとに復旧手順が違うため、AuthRequiredError.mode で出し分ける
 */
const describeDuplicateError = (
  err: unknown,
  title: string,
): DuplicateErrorDescription => {
  if (err instanceof AuthRequiredError) {
    // DCR (動的クライアント登録) を使うのはリモート HTTP 接続のクライアント
    // (claude.ai 等) だけ。stdio は固定 client_id 'reportflow-mcp' の seed
    // クライアントで認可するため 30 日削除は起こらない。経路を問わず同じ注意を
    // 付けると、stdio ユーザーには「接続を作り直せ」という効かない対処へ誘導して
    // しまう (実際の対処は authenticate ツールの呼び出し)。
    if (err.mode === 'http') {
      return {
        text: `${err.message} なお、自動登録 (DCR) されたクライアントは 30 日で削除される既知の挙動があるため、以前接続したまま日数が経っている場合は接続の再設定が必要です。`,
      };
    }
    return { text: err.message };
  }
  if (err instanceof HttpError) {
    if (err.status === 403) {
      return {
        text: `複製する権限がありません: ${err.message} 不足スコープが示されている場合は、そのスコープを含めて再認可（接続のやり直し）が必要です。`,
      };
    }
    if (err.status === 404) {
      return {
        text: `テンプレートが見つかりませんでした: ${err.message} slug を search_gallery_templates で探し直してください。`,
      };
    }
    if (err.status === 412) {
      // reposts-api が 412 を返すのは VerifyVersion ガードだけで（同 API 内で
      // PreconditionFailedException を投げる箇所は verify-version.guard.ts の
      // 1 箇所のみ）、サーバーが app-key を受け取れなかったことを意味する。
      // ガードはコントローラのハンドラより前に働くため複製処理は動いていない。
      //
      // 汎用分岐の「時間を置いて再実行」「既に作成済みかもしれない」と読める
      // 文言を返すと、AI が一時障害と誤要約してユーザーに誤案内する
      // （PRJ-3-1245 で実害が出たため専用分岐にする）。
      //
      // ただし「クライアントがヘッダーを送っていない」と断定してはいけない。
      // この分岐を持つのは duplicateGalleryTemplate が常に非空の app-key を
      // 付けるバージョンだけで（getAppKey は空・空白のみを既定値へフォール
      // バックさせる）、送っていなかった旧版はこの文言自体を持たない。つまり
      // ここに到達した時点でクライアントは送信済みであり、実際の原因は経路上
      // でのヘッダー除去・書き換えかサーバー要求の変化。「最新版へ更新」を
      // 促すと効かない対処へ誘導し、真因（経路・設定）を隠す（PR #109 レビュー）。
      return {
        text: `複製 API が前提条件エラー (412) を返しました: ${err.message} サーバーは必須ヘッダー app-key を受け取れなかったときにこの応答を返します。ただしこのクライアントは複製リクエストに常に非空の app-key を付けているため、クライアント側の送信もれではありません。想定される原因は、経路上のプロキシ / CDN / API ゲートウェイがヘッダーを除去・書き換えている、設定された app-key の値が経路上で拒否されている、サーバー側の要求が変わった、のいずれかです。リクエストは入口で拒否されており複製処理は実行されていないため、同じ条件で呼び出しても結果は変わりません。REPORTFLOW_APP_KEY の設定値と、MCP サーバーから API へ至る経路のヘッダー転送設定を確認してください。`,
      };
    }
    if (err.status === 429) {
      // プラン上限（デザイン数上限）等。サーバーのメッセージをそのまま伝える
      return { text: `${err.message}` };
    }
    // 上の分岐は「確定できるステータスに**専用の文言**を返す」ためのもので、
    // 「確定か否か」の判断そのものは http.ts の WRITE_REJECTED_STATUSES が唯一の
    // 根拠。ここで取りこぼすと、集合に追加されたステータスがこのツールでだけ
    // 不明扱いのまま残る（auth.ts は集合を見ているので判断が食い違う）。
    if (WRITE_REJECTED_STATUSES.has(err.status)) {
      return {
        text: `複製 API がエラーを返しました: ${err.message} サーバーがリクエストを拒否しており、複製は実行されていません。`,
      };
    }
    //
    // 5xx を「複製は起きなかった」の証拠にしてはいけない。origin が commit の
    // **後**に落ちる、プロキシが応答経路で 502 / 504 を返す、といった経路では
    // デザインが作られたまま 5xx が返る。ここで失敗確定として記録すると、
    // まさにこの節が避けようとしている転換率の歪みを作り直す
    // (developer-docs PR #175 の Codex 指摘)。API が「書き込んでいない」ことを
    // 明示的に保証しない限り不明とする。
    //
    // 5xx 以外の未分類ステータス (400 等) も同じ扱いにする。**こちらが意味を
    // 判断していないステータス**なので、「書き込みは起きていない」と断定する
    // 根拠が無い。この分岐の文言が元から二重複製の確認を促しているのも、
    // 書き込みが起きた可能性を前提にしているため。
    return {
      text: `複製 API がエラーを返しました: ${err.message} 再試行する前に list_templates を呼び、「${title}」という名前のテンプレートが既に作成されていないか確認してください（二重複製の防止）。`,
      outcomeUnknown: true,
    };
  }
  // ここから下は「サーバーが解釈できる応答を返さなかった」系。複製が実行された
  // かどうかを**こちら側では確定できない**ので、文言だけでなくテレメトリにも
  // 不明として残す (outcomeUnknown)。失敗と断定して記録すると、実際には完了した
  // 複製が転換率の分母だけ増やして分子から消える (PR #117 の Codex 指摘)。
  if (err instanceof SyntaxError) {
    // CDN 経路が API 応答を JSON 以外に差し替えた場合。リクエスト自体は
    // サーバーに届いている可能性がある
    return {
      text: `複製 API の応答を解釈できませんでした。複製が完了したかは不明です。自動で再試行せず、list_templates で「${title}」という名前のテンプレートが増えているか確認してから判断してください。`,
      outcomeUnknown: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(message)) {
    return {
      text: `複製リクエストがタイムアウトしました。複製が完了したかは不明です（失敗したと断定できません）。自動で再試行せず、list_templates で「${title}」という名前のテンプレートが増えているか確認してから判断してください。`,
      outcomeUnknown: true,
    };
  }
  // 接続自体の失敗。文言は「実行されていない可能性が高い」と傾きを示すが、
  // これは**確定ではない**。fetch は DNS / 接続拒否のような送信前の失敗でも、
  // 応答の読み取り中に接続が切れた (= サーバーは処理を終えている) 場合でも同じ
  // 例外になり、こちらからは区別できない。傾きを確定として記録しないため、
  // ここも不明にしておく（観測できなかったものを「異常なし」にしない原則）。
  return {
    text: `複製 API に到達できませんでした: ${message} HTTP エラー (404 等) ではなく接続自体が失敗しています。複製は実行されていない可能性が高いですが、再試行前に list_templates での確認を推奨します。`,
    outcomeUnknown: true,
  };
};

/**
 * `describeDuplicateError` の文言と `outcomeUnknown` を 1 箇所で戻り値へ写す。
 * 呼び出し側で片方だけ拾う書き方をできなくするために挟む。
 */
const duplicateErrorResult = (err: unknown, title: string): CopyOutcome => {
  const { text, outcomeUnknown } = describeDuplicateError(err, title);
  return errorResult(text, { outcomeUnknown });
};

/**
 * 複製需要テレメトリ (PRJ-3-1350) の受け口。search_gallery_templates 側と同じく、
 * 送信は呼び出し側 (server.ts) が行い、ここは観測値を渡すだけにする。
 */
export type CopyGalleryTemplateDeps = {
  // 型だけの import なので telemetry への実行時依存は無い
  // (search_gallery_templates 側と同じ形)。観測値の形を 1 箇所に置くことで、
  // 「失敗に複製先を、成功に不明を付ける」が型として書けない状態を共有する。
  onCopied?: (observation: GalleryCopyObservation) => void;
};

/** 本体の戻り値。`workspaceId` は複製が成立したときだけ入る。 */
type CopyOutcome = {
  result: CopyGalleryTemplateResult;
  workspaceId?: string;
  /** 失敗として返すが、サーバー側で複製が完了している可能性がある。 */
  outcomeUnknown?: boolean;
  /**
   * `getGalleryTemplateBySlug()` が成功した後の結果か。
   *
   * 複製 POST が失敗しても、**slug がギャラリーに実在する公開識別子である
   * ことは既に証明されている**。これを持たないと、タイムアウト / 5xx で不明に
   * なった複製の slug が正規化・マスク・切り詰めされ、どのテンプレートの転換が
   * 取りこぼされたのか追えなくなる (developer-docs PR #175 の Codex 指摘)。
   */
  slugVerified?: boolean;
};

/**
 * 「検索 → 複製」の転換を見るための計測を 1 箇所に集約する薄いラッパー。
 *
 * 本体には early return が 8 箇所あり、各所に送信を足すと必ずどれかを取り
 * こぼす。戻り値の `isError` だけを見れば成功・失敗は確定するので、出口を
 * 1 つにまとめる。
 */
export const handleCopyGalleryTemplate = async (
  input: CopyGalleryTemplateInput,
  deps: CopyGalleryTemplateDeps = {},
): Promise<CopyGalleryTemplateResult> => {
  // 計測の失敗で複製結果を握りつぶさない (fire-and-forget 厳守)
  const emitSuccess = (workspaceId?: string): void => {
    try {
      deps.onCopied?.({
        slug: input.slug,
        success: true,
        // 帰属は成功時だけ。失敗時に付けると、書き込みが起きていない呼び出しを
        // 任意のワークスペース宛に注入できてしまう（ユニオンで型としても封じる）。
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });
    } catch {
      // 意図的に無視する
    }
  };
  const emitFailure = (outcomeUnknown = false, slugVerified = false): void => {
    try {
      deps.onCopied?.({
        slug: input.slug,
        success: false,
        ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
        // 実在確認を通った slug は、複製が失敗していても公開識別子。
        ...(slugVerified ? { slugVerified: true } : {}),
      });
    } catch {
      // 意図的に無視する
    }
  };

  let outcome: CopyOutcome;
  try {
    outcome = await runCopyGalleryTemplate(input);
  } catch (err) {
    // 本体は想定外のエラーを rethrow する (auth 層の非 AuthRequiredError 等)。
    // ここで拾わないと、その呼び出しだけ複製イベントが欠落し、転換率の分母が
    // 静かに減る。withTelemetry が invoked を成功・失敗の両方で出すのと揃える。
    //
    // rethrow が起きるのは複製 POST より前（ワークスペース解決）だけなので、
    // 書き込みは実行されていない = 不明ではなく失敗確定。
    emitFailure();
    throw err;
  }

  if (outcome.result.isError !== true) {
    emitSuccess(outcome.workspaceId);
  } else {
    emitFailure(outcome.outcomeUnknown, outcome.slugVerified);
  }
  return outcome.result;
};

/**
 * 詳細応答が「要求した slug の実在テンプレート」だと実行時に確かめる。
 *
 * `fetchJson` は実行時検証をしないので、2xx + `{}` のような契約外の応答でも
 * 呼び出し側へ届く。それを実在確認として扱うと、**AI が渡した任意の文字列**
 * （`victim@example.com` 等）に `slugVerified` が立ち、telemetry 側でマスクを
 * 免除されてそのまま記録される (PR #117 の Codex 指摘)。
 *
 * **slug の一致だけでは足りない**。`{ "slug": "victim@example.com" }` のように
 * 要求値を反射するだけの応答が同じく通ってしまう (PR #117 の Codex 指摘)。
 * `GalleryTemplateDetail` が必ず持つ非 null フィールドの型まで見る。
 * 誤判定の向きは安全側 —— 実在するのに検証を落とせば「マスクして記録」に
 * なるだけで、漏洩にはならない。
 */
const isNullableString = (value: string | null): boolean =>
  value === null || typeof value === 'string';

const isNonNegativeInteger = (value: number): boolean =>
  Number.isInteger(value) && value >= 0;

const isVerifiedGalleryDetail = (
  detail: GalleryTemplateDetail,
  slug: string,
): boolean => {
  // `Record<keyof GalleryTemplateDetail, boolean>` で受けるのが要点。
  // フィールドを 1 つでも書き忘れる / 型に新しいフィールドが増えると
  // **コンパイルエラーになる**ので、「検査した項目の列挙が実物より少ない」
  // という失敗が起こりえない。手で数個ずつ足していたときは、その都度
  // 「まだ足りない」と指摘され続けた (PR #117 の Codex 指摘 2 回)。
  const checks: Record<keyof GalleryTemplateDetail, boolean> = {
    slug: detail.slug === slug,
    title: typeof detail.title === 'string',
    description: isNullableString(detail.description),
    category: isNullableString(detail.category),
    tags:
      detail.tags === null ||
      (Array.isArray(detail.tags) &&
        detail.tags.every((tag) => typeof tag === 'string')),
    thumbnailUrl: isNullableString(detail.thumbnailUrl),
    // 数値は NaN / Infinity も弾く（`typeof x === 'number'` は NaN を通し、
    // その値が payload の templateVersion に乗る）
    // 件数・版数は非負の整数（検索側の item 検証と同じ基準）
    duplicateCount: isNonNegativeInteger(detail.duplicateCount),
    version: isNonNegativeInteger(detail.version),
    ownerName: isNullableString(detail.ownerName),
    createdAt: typeof detail.createdAt === 'string' && detail.createdAt !== '',
    updatedAt: typeof detail.updatedAt === 'string' && detail.updatedAt !== '',
  };
  return Object.values(checks).every(Boolean);
};

/**
 * 複製 API の応答が契約どおりか。**`Record<keyof DuplicateGalleryTemplateResponse,
 * boolean>` で受けるので、型にフィールドが増えたらコンパイルエラーになる。**
 *
 * `duplicatedFileId` だけを見ていた頃は、`workspaceId` が欠損・型違い・**別の
 * ワークスペース**でも、`templateSlug` が**別テンプレート**でも成功として扱っていた。この値はそのまま応答に載り、
 * テレメトリの帰属先にもなるため、**成功イベントが別ワークスペースへ付く**
 * (PR #117 の Codex 指摘)。認証済みの複製先と一致することまで確かめる。
 *
 * `duplicatedFileId` の `null` は契約どおりの値（スナップショット欠損）なので
 * ここでは通し、呼び出し側が「確定した失敗」として扱う。
 */
const isVerifiedDuplication = (
  duplication: DuplicateGalleryTemplateResponse,
  authorizedWorkspaceId: string,
  requestedSlug: string,
): boolean => {
  // 根が object であることを先に確かめる（2xx + JSON `null` でのプロパティ参照を
  // 防ぐ。検索側と同じ穴 —— セルフレビューで横展開）
  if (duplication === null || typeof duplication !== 'object') return false;
  const checks: Record<keyof DuplicateGalleryTemplateResponse, boolean> = {
    // 識別子は空文字を弾く（型は満たすが値として使えない）
    id: typeof duplication.id === 'string' && duplication.id !== '',
    templateId:
      typeof duplication.templateId === 'string' &&
      duplication.templateId !== '',
    // 型だけでなく**要求した slug と一致するか**を見る。古い / 誤配送の応答が
    // 別テンプレートを指していると、「別の帳票を複製した」と伝えつつ転換イベントは
    // 要求した slug に付く (PR #117 の Codex 指摘)。
    templateSlug: duplication.templateSlug === requestedSlug,
    userId: typeof duplication.userId === 'string' && duplication.userId !== '',
    workspaceId: duplication.workspaceId === authorizedWorkspaceId,
    // **空文字は契約外**。デザイン ID として使えないのに、下の falsy 判定では
    // 契約どおりの `null`（スナップショット欠損）と同じ「確定した失敗」に
    // なってしまう。書き込みが完了した後の壊れた応答でありうるので不明扱いへ
    // 落とす (PR #117 の Codex 指摘)。
    duplicatedFileId:
      duplication.duplicatedFileId === null ||
      (typeof duplication.duplicatedFileId === 'string' &&
        duplication.duplicatedFileId !== ''),
    sourceTemplateVersion:
      duplication.sourceTemplateVersion === null ||
      isNonNegativeInteger(duplication.sourceTemplateVersion),
    createdAt:
      typeof duplication.createdAt === 'string' && duplication.createdAt !== '',
  };
  return Object.values(checks).every(Boolean);
};

const runCopyGalleryTemplate = async (
  input: CopyGalleryTemplateInput,
): Promise<CopyOutcome> => {
  // 1. 複製先ワークスペースをアクセストークンから解決する（引数では受けない）
  let workspaceId: string | undefined;
  try {
    workspaceId = await getAuthWorkspaceId();
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return duplicateErrorResult(err, input.slug);
    }
    throw err;
  }
  if (!workspaceId) {
    return errorResult(
      'アクセストークンにワークスペースが紐づいていません。認可（接続）をやり直し、同意画面で複製先にするワークスペースを選択してください。',
    );
  }

  // 2. slug の実在確認 + タイトル取得（公開 API・認証不要）。
  //    CDN が複製 POST の 404 を JSON 以外に差し替える可能性があるため、
  //    書き込み前に読み取り側で slug を検証して 404 の意味を確定させる
  let title: string;
  let templateVersion: number;
  let slugVerified = false;
  try {
    const detail = await getGalleryTemplateBySlug(input.slug);
    // 根が object でなければ以降のプロパティ参照が TypeError になり、
    // 「確認に失敗」ではなく別のエラーに化ける（検索側と同じ穴）
    if (detail === null || typeof detail !== 'object') {
      return errorResult(
        `複製前のテンプレート確認で契約外の応答を受け取りました（slug="${input.slug}"）。複製は実行されていません。`,
      );
    }
    // レスポンスは実行時には未検証。title 欠損時にエラーメッセージや
    // 戻り値の name が "undefined" にならないよう slug で代替する
    title =
      typeof detail.title === 'string' && detail.title !== ''
        ? detail.title
        : input.slug;
    templateVersion = detail.version;
    slugVerified = isVerifiedGalleryDetail(detail, input.slug);
  } catch (err) {
    if (err instanceof GalleryTemplateNotFoundError) {
      return errorResult(
        `${err.message}。slug を search_gallery_templates で探し直してください。複製は実行されていません。`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(
      `複製前のテンプレート確認に失敗しました: ${message} 複製は実行されていません。`,
    );
  }

  // 3. 複製実行（Bearer 認証・書き込み）
  try {
    const duplication = await duplicateGalleryTemplate(workspaceId, input.slug);

    // 契約どおりの `null`（スナップショット欠損）と、**スキーマ違反の payload**
    // （`{}` / 型違い）を区別する。後者は fetchJson が実行時検証をしないので
    // ここまで来るが、サーバーがデザインを作っていない保証は無い
    // (PR #117 の Codex 指摘)。断定できないので不明として記録する。
    if (!isVerifiedDuplication(duplication, workspaceId, input.slug)) {
      return {
        ...errorResult(
          `複製 API が契約外の応答を返しました（テンプレート「${title}」）。テンプレートが作成されたかは不明です。自動で再試行せず、list_templates で「${title}」という名前のテンプレートが増えているか確認してから判断してください。`,
          { outcomeUnknown: true },
        ),
        slugVerified,
      };
    }
    if (!duplication.duplicatedFileId) {
      // サーバーは複製ログのみ記録しデザインを作成しなかった
      // （テンプレートのスナップショットデータ欠損時の挙動）
      return {
        ...errorResult(
          `複製 API は成功を返しましたが、テンプレートは作成されませんでした（テンプレート「${title}」のスナップショットデータが欠損している可能性があります）。このテンプレートは現在複製できないため、別のテンプレートを検討してください。`,
        ),
        slugVerified,
      };
    }

    const payload = {
      // 複製直後のデザインは常に version 1 で作成される
      // (reposts-api design.repository.service create: latestVersion 1)
      designId: duplication.duplicatedFileId,
      version: 1,
      name: title,
      workspaceId: duplication.workspaceId,
      duplicatedFrom: {
        slug: duplication.templateSlug,
        templateId: duplication.templateId,
        templateVersion: duplication.sourceTemplateVersion ?? templateVersion,
      },
      nextStep:
        'この designId と version を get_design_parameters に渡してパラメータ構造を確認し、generate_pdf_sync で PDF を出力してください。',
    };
    return {
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      },
      // 未検証の JWT claim ではなく、複製 API が確定させた複製先を使う。
      workspaceId: duplication.workspaceId,
    };
  } catch (err) {
    // 複製 POST の失敗。slug の実在は step 2 で確認済みなので、その事実を残す。
    const outcome = duplicateErrorResult(err, title);
    // `requestWithAuth` は 401 で token を refresh し、**retry した POST の
    // あらゆるエラーを `AuthRequiredError` で包む**。retry のタイムアウト・
    // 不正 JSON・5xx が混ざるため、サーバーが既にデザインを作っている可能性が
    // あり「書き込みは起きていない」と断定できない (PR #117 の Codex 指摘)。
    //
    // ただし **AuthRequiredError なら全部不明、ではない**。401 そのもの (http 経路) /
    // トークン欠如 / refresh 自体の失敗は**再送していない**ので書き込みは起きて
    // いない。これらまで不明にすると、確定した認証失敗が失敗件数から消える
    // (PR #117 の Codex 指摘)。判定は auth.ts が立てる `retryAttempted` で行う。
    if (err instanceof AuthRequiredError && err.retryAttempted) {
      return { ...outcome, outcomeUnknown: true, slugVerified };
    }
    return { ...outcome, slugVerified };
  }
};
