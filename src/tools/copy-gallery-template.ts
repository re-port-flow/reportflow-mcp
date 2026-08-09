import { z } from 'zod';
import {
  duplicateGalleryTemplate,
  getGalleryTemplateBySlug,
  GalleryTemplateNotFoundError,
} from '../gallery-client.js';
import { AuthRequiredError, getAuthWorkspaceId } from '../auth.js';
import { HttpError } from '../http.js';

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
    '公開テンプレートギャラリーのテンプレートを、認可時に選択した自分のワークスペースへ複製します（要認証・書き込み）。複製先ワークスペースは接続時の認可で決まっており、引数で変更できません。成功すると designId と version を返すので、そのまま get_design_parameters → generate_pdf_sync に渡して PDF 生成へ進めます。slug は search_gallery_templates / get_gallery_template で確認してください。注意: 呼ぶたびに新しいデザインが 1 件作成されます（同じ slug でも既存の複製は再利用されません）。同じテンプレートを誤って何度も複製しないでください。',
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

const errorResult = (text: string): CopyGalleryTemplateResult => ({
  content: [{ type: 'text', text: `エラー: ${text}` }],
  isError: true,
});

/**
 * 複製 POST のエラーを AI が次の一手を選べる形に写す。
 * - 401/403/404/412/429/5xx/タイムアウト/未到達を区別する
 * - タイムアウトは「失敗した」と断定しない（サーバー側で成功している可能性が
 *   あり、再試行すると二重複製になるため）
 * - 逆に 412 はガードによる門前払いが確定しているため、二重複製の警告を出さず
 *   「呼び直しても直らない」と伝える（PRJ-3-1245）。ただしクライアントの
 *   送信もれとは断定しない（この分岐は app-key を送る版にしか存在しない）
 * - 未認可は経路ごとに復旧手順が違うため、AuthRequiredError.mode で出し分ける
 */
const describeDuplicateError = (err: unknown, title: string): string => {
  if (err instanceof AuthRequiredError) {
    // DCR (動的クライアント登録) を使うのはリモート HTTP 接続のクライアント
    // (claude.ai 等) だけ。stdio は固定 client_id 'reportflow-mcp' の seed
    // クライアントで認可するため 30 日削除は起こらない。経路を問わず同じ注意を
    // 付けると、stdio ユーザーには「接続を作り直せ」という効かない対処へ誘導して
    // しまう (実際の対処は authenticate ツールの呼び出し)。
    if (err.mode === 'http') {
      return `${err.message} なお、自動登録 (DCR) されたクライアントは 30 日で削除される既知の挙動があるため、以前接続したまま日数が経っている場合は接続の再設定が必要です。`;
    }
    return err.message;
  }
  if (err instanceof HttpError) {
    if (err.status === 403) {
      return `複製する権限がありません: ${err.message} 不足スコープが示されている場合は、そのスコープを含めて再認可（接続のやり直し）が必要です。`;
    }
    if (err.status === 404) {
      return `テンプレートが見つかりませんでした: ${err.message} slug を search_gallery_templates で探し直してください。`;
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
      return `複製 API が前提条件エラー (412) を返しました: ${err.message} サーバーは必須ヘッダー app-key を受け取れなかったときにこの応答を返します。ただしこのクライアントは複製リクエストに常に非空の app-key を付けているため、クライアント側の送信もれではありません。想定される原因は、経路上のプロキシ / CDN / API ゲートウェイがヘッダーを除去・書き換えている、設定された app-key の値が経路上で拒否されている、サーバー側の要求が変わった、のいずれかです。リクエストは入口で拒否されており複製処理は実行されていないため、同じ条件で呼び出しても結果は変わりません。REPORTFLOW_APP_KEY の設定値と、MCP サーバーから API へ至る経路のヘッダー転送設定を確認してください。`;
    }
    if (err.status === 429) {
      // プラン上限（デザイン数上限）等。サーバーのメッセージをそのまま伝える
      return `${err.message}`;
    }
    return `複製 API がエラーを返しました: ${err.message} 再試行する前に list_templates を呼び、「${title}」という名前のデザインが既に作成されていないか確認してください（二重複製の防止）。`;
  }
  if (err instanceof SyntaxError) {
    // CDN 経路が API 応答を JSON 以外に差し替えた場合。リクエスト自体は
    // サーバーに届いている可能性がある
    return `複製 API の応答を解釈できませんでした。複製が完了したかは不明です。自動で再試行せず、list_templates で「${title}」という名前のデザインが増えているか確認してから判断してください。`;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(message)) {
    return `複製リクエストがタイムアウトしました。複製が完了したかは不明です（失敗したと断定できません）。自動で再試行せず、list_templates で「${title}」という名前のデザインが増えているか確認してから判断してください。`;
  }
  return `複製 API に到達できませんでした: ${message} HTTP エラー (404 等) ではなく接続自体が失敗しています。複製は実行されていない可能性が高いですが、再試行前に list_templates での確認を推奨します。`;
};

export const handleCopyGalleryTemplate = async (
  input: CopyGalleryTemplateInput,
): Promise<CopyGalleryTemplateResult> => {
  // 1. 複製先ワークスペースをアクセストークンから解決する（引数では受けない）
  let workspaceId: string | undefined;
  try {
    workspaceId = await getAuthWorkspaceId();
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return errorResult(describeDuplicateError(err, input.slug));
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
  try {
    const detail = await getGalleryTemplateBySlug(input.slug);
    // レスポンスは実行時には未検証。title 欠損時にエラーメッセージや
    // 戻り値の name が "undefined" にならないよう slug で代替する
    title =
      typeof detail.title === 'string' && detail.title !== ''
        ? detail.title
        : input.slug;
    templateVersion = detail.version;
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

    if (!duplication.duplicatedFileId) {
      // サーバーは複製ログのみ記録しデザインを作成しなかった
      // （テンプレートのスナップショットデータ欠損時の挙動）
      return errorResult(
        `複製 API は成功を返しましたが、デザインは作成されませんでした（テンプレート「${title}」のスナップショットデータが欠損している可能性があります）。このテンプレートは現在複製できないため、別のテンプレートを検討してください。`,
      );
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
        'この designId と version を get_design_parameters に渡してパラメータ構造を確認し、generate_pdf_sync で PDF を生成してください。',
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (err) {
    return errorResult(describeDuplicateError(err, title));
  }
};
