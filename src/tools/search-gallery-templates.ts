import { z } from 'zod';
import {
  listGalleryTemplates,
  GalleryTemplateItem,
} from '../gallery-client.js';
import { HttpError } from '../http.js';
import { TEMPLATE_GALLERY_SITE_URL } from '../config.js';
import type { GallerySearchObservation } from '../telemetry/gallery-demand.js';
import { isQueryRecordable } from '../telemetry/gallery-demand.js';

/**
 * 公開テンプレートギャラリー (templates.re-port-flow.com 掲載分) の検索ツール。
 *
 * 既存の `search` / `list_templates` (ワークスペース内デザイン) とは対象が別:
 * こちらは「まだワークスペースに取り込んでいない」公開テンプレートを探す。
 * 公開 API のため認証不要 (トークン未取得でも呼べる)。
 *
 * 公開一覧 API にはテキスト検索パラメータが無い (category / tags / cursor /
 * limit / sort のみ。reposts-api TemplateListReq 実測) ため、ページを取得して
 * クライアント側で部分一致フィルタする。走査上限は MAX_SCAN 件で、超過時は
 * 「全件を見ていない」ことを戻り値に明示する (黙って切ると AI が誤認する)。
 */
export const searchGalleryTemplatesTool = {
  name: 'search_gallery_templates',
  description:
    '公開テンプレートギャラリーから、まだワークスペースに取り込んでいないテンプレートをキーワードで探します（認証不要）。タイトル・説明・タグ・カテゴリの部分一致で絞り込み、各候補の slug・title・description・category・tags・thumbnailUrl・duplicateCount を返します。ワークスペース内の既存テンプレートを探す場合はこのツールではなく list_templates / search を使ってください。重要: このツールが返す slug では PDF を出力できません。先に copy_gallery_template で自分のワークスペースへ複製し、返された designId を get_design_parameters / generate_pdf_sync に渡してください。',
};

/** 1 回の検索で走査する公開テンプレートの上限 (100 件/ページ × 3 ページ) */
const MAX_SCAN = 300;
/** サーバー側 (TemplateListReq) の 1 ページ上限 */
const PAGE_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** 一覧では description を切り詰める (詳細は get_gallery_template で取る) */
const DESCRIPTION_PREVIEW_LENGTH = 200;

export const searchGalleryTemplatesInputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      '検索キーワード（タイトル・説明・タグ・カテゴリの部分一致。1文字以上）',
    ),
  category: z
    .string()
    .optional()
    .describe('カテゴリ code で絞り込み（任意。例: "invoice", "other"）'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('返す最大件数（既定 20、上限 50。超過分は残り件数として通知）'),
};

export type SearchGalleryTemplatesInput = {
  query: string;
  category?: string;
  limit?: number;
};

export type SearchGalleryTemplatesResult = {
  content: [{ type: 'text'; text: string }];
  isError?: true;
};

/**
 * 検索需要テレメトリ (PRJ-3-1350) の受け口。
 *
 * 送信は呼び出し側 (server.ts) が行い、ここは観測値を渡すだけにする — ツールを
 * telemetry クライアントに依存させないため (import も型のみ)。省略時は何もしない
 * ので、既存の呼び出し (テスト含む) は挙動が変わらない。
 */
export type SearchGalleryTemplatesDeps = {
  onSearched?: (observation: GallerySearchObservation) => void;
};

/**
 * 計測の失敗を検索応答へ絶対に伝播させない。
 *
 * とくに成功パスでは、この呼び出しがハンドラ本体の try の中にある。素で呼ぶと
 * コールバックの例外が catch へ落ち、**成功した検索が「ギャラリー API に到達
 * できませんでした」というエラー応答に化ける**。
 */
const emitSafely = (
  deps: SearchGalleryTemplatesDeps,
  observation: GallerySearchObservation,
): void => {
  try {
    deps.onSearched?.(observation);
  } catch {
    // 意図的に無視する (fire-and-forget 厳守)
  }
};

/** 未到達 (TypeError 等) と API のエラー応答 (HttpError) を集計で区別できるようにする。 */
const classifyError = (err: unknown): string => {
  if (err instanceof Error) return err.name || 'Error';
  return 'Error';
};

const isNullableString = (value: string | null): boolean =>
  value === null || typeof value === 'string';

const isNonNegativeInteger = (value: number): boolean =>
  Number.isInteger(value) && value >= 0;

/**
 * 一覧の 1 件が契約どおりか。**`Record<keyof GalleryTemplateItem, boolean>` で
 * 受けるので、型にフィールドが増えたらここがコンパイルエラーになる。**
 *
 * 配列であることだけを見ていた頃は `[{}]` のような中身が素通りし、
 * `matchesQuery` の防御的な型チェックが「一致しない」に変えた結果、上流の
 * スキーマ崩れが `success: true / matchedCount: 0`（＝未充足需要）として
 * 記録されていた (PR #117 の Codex 指摘)。件数の根拠になるのは 1 件ずつの
 * 中身なので、器だけ検査しても意味が無い。
 */
const isValidGalleryItem = (item: GalleryTemplateItem): boolean => {
  if (item === null || typeof item !== 'object') return false;
  const checks: Record<keyof GalleryTemplateItem, boolean> = {
    // 識別子は**空文字を弾く**。型は満たすが値として使えないものが
    // 「正常な観測」として通ると、件数の根拠が崩れる。数値は NaN / Infinity も
    // 弾く（`typeof x === 'number'` は NaN を通す）
    slug: typeof item.slug === 'string' && item.slug !== '',
    title: typeof item.title === 'string',
    description: isNullableString(item.description),
    category: isNullableString(item.category),
    tags:
      item.tags === null ||
      (Array.isArray(item.tags) &&
        item.tags.every((tag) => typeof tag === 'string')),
    thumbnailUrl: isNullableString(item.thumbnailUrl),
    // 件数・版数は**非負の整数**。`-1` / `1.5` は有限でも値としてありえず、
    // そのまま呼び出し側へ返り success として記録される (PR #117 の Codex 指摘)
    duplicateCount: isNonNegativeInteger(item.duplicateCount),
    version: isNonNegativeInteger(item.version),
    updatedAt: typeof item.updatedAt === 'string' && item.updatedAt !== '',
  };
  return Object.values(checks).every(Boolean);
};

const matchesQuery = (item: GalleryTemplateItem, q: string): boolean => {
  const haystacks = [
    item.title,
    item.description,
    item.category,
    item.slug,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ];
  // API レスポンスは実行時には未検証のため、文字列以外 (null / 欠損) は
  // 落として比較する (クラッシュを「未到達」エラーに誤分類しない)
  return haystacks.some(
    (h) => typeof h === 'string' && h.toLowerCase().includes(q),
  );
};

const toListItem = (item: GalleryTemplateItem) => ({
  slug: item.slug,
  title: item.title,
  description:
    item.description != null &&
    item.description.length > DESCRIPTION_PREVIEW_LENGTH
      ? `${item.description.slice(0, DESCRIPTION_PREVIEW_LENGTH)}…`
      : item.description,
  category: item.category,
  tags: item.tags,
  thumbnailUrl: item.thumbnailUrl,
  duplicateCount: item.duplicateCount,
});

/** 接続失敗 (未到達) を HTTP エラー (404/500 等) と区別したメッセージにする */
const describeGalleryError = (err: unknown, toolLabel: string): string => {
  if (err instanceof HttpError) {
    return `ギャラリー API がエラーを返しました (${toolLabel}): ${err.message}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `ギャラリー API に到達できませんでした (${toolLabel}): ${message}。HTTP エラー (404 等) ではなく接続自体が失敗しています。時間を置いて再試行してください。`;
};

export const handleSearchGalleryTemplates = async (
  input: SearchGalleryTemplatesInput,
  deps: SearchGalleryTemplatesDeps = {},
): Promise<SearchGalleryTemplatesResult> => {
  try {
    const q = input.query.trim().toLowerCase();
    const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    // 人気順で走査する (テンプレート 0 件の新規ユーザーに実績あるものを先に出す)
    const scanned: GalleryTemplateItem[] = [];
    let cursor: string | undefined = undefined;
    let total = 0;
    // 空ページとして扱った (= 契約外の応答を見た) ことを覚えておく。
    // これを覚えずに success:true で送ると、上流のスキーマ崩れが
    // **未充足需要 (matchedCount: 0)** に化ける —— この計測の主目的そのものを
    // 汚染し、任意のキーワードを「需要あり」に押し上げうる (PR #117 の Codex 指摘)。
    let sawMalformedPage = false;
    // **走査を最後まで進められなかった**か。`sawMalformedPage` はテレメトリ用で
    // ユーザー応答には出ないため、これが無いと「カーソルが使えず打ち切った」
    // 呼び出しが、未走査があるのに note の無い通常の成功応答になる
    // (PR #117 の Codex 指摘)。
    let scanIncomplete = false;
    // 使い終わったカーソルを覚える。同じカーソルが返ると同じページを取り直し、
    // 件数が水増しされたまま success で記録される（下の nextCursor 検査参照）。
    const usedCursors = new Set<string>();
    do {
      if (cursor !== undefined) usedCursors.add(cursor);
      const page = await listGalleryTemplates({
        category: input.category,
        cursor,
        limit: PAGE_LIMIT,
        sort: 'popular',
      });
      // **根が object であることを最初に確かめる。** 2xx + JSON `null` のとき、
      // 下のフィールド検査より前にプロパティ参照で TypeError になり、catch 側の
      // 「ギャラリー API に到達できませんでした」へ落ちて errorClass も
      // TypeError で記録される (PR #117 の Codex 指摘)。
      if (page === null || typeof page !== 'object') {
        sawMalformedPage = true;
        scanIncomplete = true;
        cursor = undefined;
        break;
      }
      // レスポンスは実行時には未検証。欠損時にクラッシュして「未到達」エラーに
      // 誤分類されないよう、形が想定外なら既定値で埋める。
      //
      // **埋めた事実は必ず記録する。** `items` だけを見て `total` / `nextCursor`
      // の契約違反を見逃すと、`totalPublished` に `scanned.length` という別物が
      // 入った行や、走査を途中で止めた行が「正常な観測」として残る。
      // 契約違反はフィールドを問わず同じ扱いにする。
      //
      // `nextCursor` は「文字列なら何でも可」ではない。**空文字**は
      // `listGalleryTemplates` が falsy として送信を省くため、次の要求が
      // 先頭ページの取り直しになり、`MAX_SCAN` まで同じ結果を積み増して
      // 水増しした件数を success として記録する (PR #117 の Codex 指摘)。
      // **同じカーソルの再提示**も結果は同じなので、まとめて契約違反にする。
      const nextCursor = page.nextCursor;
      const cursorUsable =
        typeof nextCursor === 'string' &&
        nextCursor !== '' &&
        !usedCursors.has(nextCursor);
      // 契約外の要素は**落としてから**走査に渡す。残すと `matchesQuery` の中で
      // `null.title` を踏んで例外になり、成功した呼び出しが catch へ落ちて
      // 「ギャラリー API に到達できませんでした」という別物のエラーに化ける
      // （セルフレビューで検出）。落としたことは sawMalformedPage が持っている。
      const validItems = Array.isArray(page.items)
        ? page.items.filter(isValidGalleryItem)
        : [];
      // **サーバーの申告は、自分が実測した値と矛盾しない範囲でしか採用しない。**
      // フィールド単体の型検査を重ねていた頃は、個々の型は正しいのに互いに
      // 矛盾する組み合わせを success として記録していた —— 要求上限 100 に対し
      // 301 件返すページ（`scannedCount` が走査上限 300 を破る）、1 件返しながら
      // `total: 0` と申告するページ（`scannedCount > totalPublished` という
      // ありえない需要データ）(PR #117 の Codex 指摘。2 件とも同じ型)。
      //
      // 申告値は 3 つ (`items` の件数 / `total` / `nextCursor`) で、いずれも
      // 「実測と突き合わせて、通らなければ実測側を採る」に統一してある。
      const overPageLimit = validItems.length > PAGE_LIMIT;
      // 超過分は**切り詰めてから**積む。矛盾を記録するだけでは `scanned` が
      // 伸び続け、`scannedCount` が走査上限を破った値のまま残る。
      const items = overPageLimit
        ? validItems.slice(0, PAGE_LIMIT)
        : validItems;
      scanned.push(...items);
      // 「これまでに実際に受け取った件数」を下回る total は公開総数として
      // 成立しない。非整数・負数もここで落ちる（`scanned.length >= 0` のため
      // 別に検査しなくても `>= scanned.length` が偽になる）。
      //
      // 逆向き（申告が実測を**上回る**）は矛盾ではないので許す。走査は
      // `MAX_SCAN` とページ上限で意図的に打ち切るので、`total > scanned.length`
      // は正常な状態である。
      const totalUsable =
        Number.isInteger(page.total) && page.total >= scanned.length;
      total = totalUsable ? page.total : scanned.length;
      if (
        !Array.isArray(page.items) ||
        validItems.length !== page.items.length ||
        overPageLimit ||
        !totalUsable ||
        !(typeof nextCursor === 'string' || nextCursor === null) ||
        (typeof nextCursor === 'string' && !cursorUsable)
      ) {
        sawMalformedPage = true;
      }
      // 切り詰めたページには**見ていない要素**が残っている
      if (overPageLimit) scanIncomplete = true;
      // サーバーが「次は無い」と言っているのに未走査が残る形。自分の都合で
      // 打ち切ったとき (MAX_SCAN / ページ切り詰め) の `total > scanned.length` は
      // 正常だが、これは**サーバー側が走査の終わりを宣言している**ので別物。
      // 残さないと「探したが無かった」需要として集計され、実在するテンプレートが
      // 未充足需要に化ける (PR #117 の Codex 指摘)。
      //
      // ここは `sawMalformedPage` にはしない。`total` が category 絞り込み後の
      // 件数なのか公開総数なのかは、このクライアントからは確かめられない
      // (reposts-api は本 workspace に無く、応答からも判別できない)。後者だと
      // category 指定の検索が軒並み「スキーマ崩れ」として記録され、需要データ
      // そのものが壊れる。**確かめられない原因は断定せず、確かめられる事実
      // (未走査が残った) だけを残す。**
      if (nextCursor === null && total > scanned.length) scanIncomplete = true;
      // 「使えるカーソルがあるのに items が空」は矛盾した応答。無限ループを
      // 避けて打ち切るが、**打ち切った事実を観測値へ残す**。残さないと
      // 未走査があるのに `success / matchedCount: 0`（＝未充足需要）として
      // 記録される (PR #117 の Codex 指摘)。
      if (cursorUsable && items.length === 0) {
        sawMalformedPage = true;
        scanIncomplete = true;
      }
      // カーソルが契約外（空文字・再提示）で打ち切ったときも未走査が残りうる
      if (typeof nextCursor === 'string' && !cursorUsable)
        scanIncomplete = true;
      cursor = cursorUsable && items.length > 0 ? nextCursor : undefined;
    } while (cursor !== undefined && scanned.length < MAX_SCAN);

    const matched = scanned.filter((item) => matchesQuery(item, q));
    const items = matched.slice(0, limit).map(toListItem);
    // 走査を最後まで進められなかったか。**応答の note と観測値で同じ式を使う。**
    // 別々に書いていた頃は、ループが `MAX_SCAN` で終わった場合が note にだけ
    // 現れ、テレメトリ側には出ていなかった（セルフレビュー）。
    const incomplete = scanIncomplete || cursor !== undefined;

    const payload = {
      items,
      returnedCount: items.length,
      matchedCount: matched.length,
      // 切り詰めが起きたときに「他に N 件ある」ことを明示する
      remainingCount: matched.length - items.length,
      scannedCount: scanned.length,
      totalPublished: total,
      ...(incomplete
        ? {
            note: `公開テンプレートは全 ${total} 件ありますが、先頭 ${scanned.length} 件のみ検索しました。目的のものが無ければ query や category を変えて再検索してください。`,
          }
        : {}),
      ...(items.length === 0
        ? {
            hint: '該当するテンプレートがありませんでした。query を短くする・category を外すなど条件を緩めて再検索してください。',
            // 0 件で行き止まりにしない (PRJ-3-2270)。公開テンプレートのタイトルは
            // 日本語が中心で、AI が英語の汎用語 ("report" 等) で探すと当たらない。
            // 名前の一覧ではデザインが分からず選べないため、デザインを見て選べる
            // サイトへ誘導する。詳細ページの URL 末尾がそのまま slug になる。
            templateSite: {
              url: TEMPLATE_GALLERY_SITE_URL,
              message: `公開テンプレートは ${TEMPLATE_GALLERY_SITE_URL} でデザインを見て選べます。利用者にこのリンクを案内してください。気に入ったテンプレートの詳細ページ URL（${TEMPLATE_GALLERY_SITE_URL}/{slug}）を伝えてもらえば、その slug を copy_gallery_template に渡して複製できます。`,
            },
          }
        : {}),
    };
    // 応答本文を先に組み立ててから送る。送信のあとに throw しうる処理を残すと、
    // 同じ呼び出しが success=true と success=false の 2 件を出しうる。
    const text = JSON.stringify(payload, null, 2);

    // 0 件ヒットこそ「未充足需要」の本体なので、件数に関係なく必ず送る。
    //
    // ただし**キーワードが空になる呼び出しは送らない**。`z.string().min(1)` は
    // 通るが検索側は `trim().toLowerCase()` で `''` にするため `includes('')` が
    // 全件に一致し、「キーワード無しの呼び出し」がギャラリー全件ヒットの需要として
    // 記録される (PR #117 の Codex 指摘)。需要ランキングにも未充足需要にも意味を
    // 持たない。
    //
    // 判定は `isQueryRecordable`（テレメトリ側）に持たせてある。生の入力を
    // `trim()` で近似していた頃は、正規化が消す文字だけの query（U+200B のみ等）が
    // すり抜けて `query: ''` の行になっていた (PR #117 の Codex 指摘)。
    if (isQueryRecordable(input.query)) {
      emitSafely(
        deps,
        sawMalformedPage
          ? {
              // 件数を載せられない形 (失敗) で送る。0 件ヒットと同じ枠に入れると
              // 「探したが無かった」需要と「一覧 API のスキーマ崩れ」が
              // 集計上まったく区別できなくなる。
              success: false,
              query: input.query,
              // `listGalleryTemplates` は falsy な category を送らない。ここだけ `''` を
              // 載せると、絞り込んでいない検索が「category 指定あり」として記録され、
              // 同じキーワードの行が空 category とそれ以外に分かれる
              // (PR #117 の Codex 指摘)。**実際に効いた条件と同じ式**で判定する。
              ...(input.category ? { category: input.category } : {}),
              errorClass: 'MalformedGalleryPage',
            }
          : {
              success: true,
              query: input.query,
              // `listGalleryTemplates` は falsy な category を送らない。ここだけ `''` を
              // 載せると、絞り込んでいない検索が「category 指定あり」として記録され、
              // 同じキーワードの行が空 category とそれ以外に分かれる
              // (PR #117 の Codex 指摘)。**実際に効いた条件と同じ式**で判定する。
              ...(input.category ? { category: input.category } : {}),
              matchedCount: matched.length,
              scannedCount: scanned.length,
              totalPublished: total,
              // **`matchedCount: 0` を未充足需要と読んでよいのは、これが無いとき
              // だけ。** 打ち切った走査の 0 件は「無かった」ではなく「見ていない」。
              ...(incomplete ? { scanIncomplete: true as const } : {}),
            },
      );
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    // 失敗時は件数を送らない。0 を送ると本当の 0 件ヒットと区別できなくなる。
    // キーワードが空になる呼び出しを送らないのは成功側と同じ判定 (同じ関数)。
    // 片側だけに条件を置くと、同じ入力が「API が落ちたときだけ記録される」という
    // 一貫しない状態になる。
    if (isQueryRecordable(input.query)) {
      emitSafely(deps, {
        success: false,
        query: input.query,
        ...(input.category ? { category: input.category } : {}),
        errorClass: classifyError(err),
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: `エラー: ${describeGalleryError(err, 'search_gallery_templates')}`,
        },
      ],
      isError: true,
    };
  }
};
