import {
  SLACK_BUTTON_VALUE_MAX,
  buildAcceptedCard,
  buildStatusCard,
  safeCard,
  isAllowedLinkUrl,
  isValidRequestId,
  toolButtonValue,
} from './status-card';
import type { ExportResponse, GenerationStatusResult } from '../client';

const REQUEST_ID = 'AbCd1234EfGh5678';
const opts = { allowedLinkHosts: ['re-port-flow.com'] };
const HISTORY_URL = `https://re-port-flow.com/ws-1/templates/d-1/outputs?requestId=${REQUEST_ID}`;

type Block = Record<string, any>;
const blocksOf = (meta: { slack: { blocks: Block[] } } | null): Block[] => {
  expect(meta).not.toBeNull();
  return meta!.slack.blocks;
};
const elementsOf = (blocks: Block[]): Block[] =>
  blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const textOf = (blocks: Block[]): string =>
  blocks
    .filter((b) => b.type === 'section')
    .map((b) => b.text.text)
    .join('\n');

const status = (
  over: Partial<GenerationStatusResult>,
): GenerationStatusResult => ({
  requestId: REQUEST_ID,
  status: 'processing',
  files: [],
  ...over,
});

describe('isValidRequestId', () => {
  it.each([
    [REQUEST_ID, true],
    ['', false],
    ['short', false],
    ['AbCd1234EfGh56789', false],
    ['AbCd1234EfGh567!', false],
    [undefined, false],
  ])('%j → %s', (value, expected) => {
    expect(isValidRequestId(value)).toBe(expected);
  });
});

describe('toolButtonValue', () => {
  it('JSON 文字列にする', () => {
    expect(toolButtonValue({ requestId: REQUEST_ID })).toBe(
      `{"requestId":"${REQUEST_ID}"}`,
    );
  });

  it('2000 文字ちょうどは許し、超えたら null', () => {
    const overhead = '{"k":""}'.length;
    const exact = toolButtonValue({
      k: 'x'.repeat(SLACK_BUTTON_VALUE_MAX - overhead),
    });
    expect(exact).not.toBeNull();
    expect(exact!.length).toBe(SLACK_BUTTON_VALUE_MAX);
    expect(
      toolButtonValue({ k: 'x'.repeat(SLACK_BUTTON_VALUE_MAX - overhead + 1) }),
    ).toBeNull();
  });
});

describe('isAllowedLinkUrl', () => {
  it.each([
    [HISTORY_URL, true],
    ['http://re-port-flow.com/x', false],
    ['https://evil.example/x', false],
    ['https://re-port-flow.com.evil.example/x', false],
    ['https://user:pass@re-port-flow.com/x', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
    [undefined, false],
  ])('%j → %s', (url, expected) => {
    expect(isAllowedLinkUrl(url, opts.allowedLinkHosts)).toBe(expected);
  });
});

describe('buildAcceptedCard', () => {
  const accepted = (over: Partial<ExportResponse> = {}): ExportResponse => ({
    requestId: REQUEST_ID,
    url: HISTORY_URL,
    ...over,
  });

  it('生成中であることと requestId を示し、状態確認ボタンと履歴リンクを置く', () => {
    const blocks = blocksOf(buildAcceptedCard(accepted(), opts));
    expect(textOf(blocks)).toContain('受け付けました');
    expect(textOf(blocks)).toContain('まだ生成中');
    expect(textOf(blocks)).not.toContain('完了');
    expect(textOf(blocks)).toContain(REQUEST_ID);

    const [statusBtn, link] = elementsOf(blocks);
    expect(statusBtn.action_id).toBe('tool:get_generation_status');
    // value は requestId だけ (token・入力値を載せない)
    expect(JSON.parse(statusBtn.value)).toEqual({ requestId: REQUEST_ID });
    expect(link.url).toBe(HISTORY_URL);
    expect(link.action_id).toBeUndefined();
  });

  it('許可外の URL ならリンクを付けず、状態確認ボタンだけ残す', () => {
    const blocks = blocksOf(
      buildAcceptedCard(accepted({ url: 'https://evil.example/x' }), opts),
    );
    const elements = elementsOf(blocks);
    expect(elements).toHaveLength(1);
    expect(elements[0].action_id).toBe('tool:get_generation_status');
    expect(JSON.stringify(blocks)).not.toContain('evil.example');
  });

  it.each(['', 'bad id', 'x'.repeat(3000)])(
    'requestId が不正 (%j) ならカードを出さない',
    (requestId) => {
      expect(buildAcceptedCard(accepted({ requestId }), opts)).toBeNull();
    },
  );
});

describe('buildStatusCard', () => {
  it.each(['queued', 'processing'] as const)(
    '%s: 生成中で、再確認ボタンだけを置く (完了と書かない)',
    (s) => {
      const blocks = blocksOf(
        buildStatusCard(status({ status: s, retryAfterSeconds: 5 })),
      );
      expect(textOf(blocks)).toContain('生成中');
      expect(textOf(blocks)).toContain('5 秒');
      expect(textOf(blocks)).not.toContain('完了');
      const elements = elementsOf(blocks);
      expect(elements).toHaveLength(1);
      expect(elements[0].action_id).toBe('tool:get_generation_status');
      expect(JSON.parse(elements[0].value)).toEqual({ requestId: REQUEST_ID });
    },
  );

  it('completed: 完了と件数。状態確認・生成のボタンは置かない', () => {
    const blocks = blocksOf(
      buildStatusCard(
        status({
          status: 'completed',
          files: [
            { fileId: 'f1', fileName: 'a.pdf', downloadPath: '/v1/x' },
            { fileId: 'f2', fileName: 'b.pdf', downloadPath: '/v1/y' },
          ],
        }),
      ),
    );
    expect(textOf(blocks)).toContain('生成が完了しました');
    expect(textOf(blocks)).toContain('2 件');
    expect(elementsOf(blocks)).toHaveLength(0);
    // downloadPath (API の相対パス) をリンクとして出さない
    expect(JSON.stringify(blocks)).not.toContain('/v1/x');
  });

  it('completed + failedFiles: 一部失敗として成功数・失敗数と理由を示す', () => {
    const blocks = blocksOf(
      buildStatusCard(
        status({
          status: 'completed',
          files: [{ fileId: 'f1', fileName: 'a.pdf', downloadPath: '/v1/x' }],
          failedFiles: [
            {
              fileName: 'b<x>.pdf',
              code: 'RENDER_FAILED',
              message: 'bad & worse',
            },
          ],
        }),
      ),
    );
    const text = textOf(blocks);
    expect(text).toContain('一部の生成に失敗しました');
    expect(text).toContain('成功 1 件 / 失敗 1 件');
    // mrkdwn の制御文字を逃がす
    expect(text).toContain('b&lt;x&gt;.pdf');
    expect(text).toContain('bad &amp; worse');
  });

  it('failed (入力起因): 理由と、直して再生成する案内', () => {
    const text = textOf(
      blocksOf(
        buildStatusCard(
          status({
            status: 'failed',
            error: { code: 'INVALID_PARAMS', message: 'missing field' },
          }),
        ),
      ),
    );
    expect(text).toContain('生成に失敗しました');
    expect(text).toContain('INVALID_PARAMS: missing field');
    expect(text).toContain('入力を直して');
  });

  it('failed (プラン起因): 再生成では直らないと案内する', () => {
    const blocks = blocksOf(
      buildStatusCard(
        status({
          status: 'failed',
          error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: 'limit' },
        }),
      ),
    );
    expect(textOf(blocks)).toContain('再生成しても解消しません');
    expect(elementsOf(blocks)).toHaveLength(0);
  });

  it('failed (複数出力の全件失敗): failedFiles を理由つきで並べ、ファイル側の PLAN もプラン起因と判定する', () => {
    const text = textOf(
      blocksOf(
        buildStatusCard(
          status({
            status: 'failed',
            error: { code: 'FILE_GENERATION_FAILED', message: 'all failed' },
            failedFiles: [
              {
                fileName: 'a.pdf',
                code: 'PLAN_PAGE_LIMIT_EXCEEDED',
                message: 'limit',
              },
            ],
          }),
        ),
      ),
    );
    expect(text).toContain('a.pdf: PLAN_PAGE_LIMIT_EXCEEDED limit');
    expect(text).toContain('再生成しても解消しません');
    expect(text).not.toContain('入力を直してから');
  });

  it('failedFiles は 5 件まで表示し、残りは件数だけ示す', () => {
    const failedFiles = Array.from({ length: 7 }, (_, i) => ({
      fileName: `f${i}.pdf`,
      code: 'RENDER_FAILED',
      message: 'x',
    }));
    const text = textOf(
      blocksOf(
        buildStatusCard(
          status({
            status: 'failed',
            error: { code: 'FILE_GENERATION_FAILED', message: 'all failed' },
            failedFiles,
          }),
        ),
      ),
    );
    expect(text).toContain('f4.pdf');
    expect(text).not.toContain('f5.pdf');
    expect(text).toContain('ほか 2 件');
    expect(text).toContain('入力を直してから');
  });

  it('completed の一部失敗でもファイル側の PLAN はプラン起因として案内する', () => {
    const text = textOf(
      blocksOf(
        buildStatusCard(
          status({
            status: 'completed',
            files: [{ fileId: 'f1', fileName: 'a.pdf', downloadPath: '/v1/x' }],
            failedFiles: [
              {
                fileName: 'b.pdf',
                code: 'PLAN_PAGE_LIMIT_EXCEEDED',
                message: 'limit',
              },
            ],
          }),
        ),
      ),
    );
    expect(text).toContain('再生成しても解消しません');
  });

  it('failed (PLAN と入力誤りの混在): プランの案内と、それ以外は直して再生成の案内を両方出す', () => {
    const text = textOf(
      blocksOf(
        buildStatusCard(
          status({
            status: 'failed',
            error: { code: 'FILE_GENERATION_FAILED', message: 'all failed' },
            failedFiles: [
              {
                fileName: 'a.pdf',
                code: 'PLAN_PAGE_LIMIT_EXCEEDED',
                message: 'limit',
              },
              { fileName: 'b.pdf', code: 'INVALID_PARAMS', message: 'bad' },
            ],
          }),
        ),
      ),
    );
    expect(text).toContain('再生成しても解消しません');
    expect(text).toContain('プラン以外の理由で失敗したファイルは');
  });

  it('completed の一部失敗 (混在) でも両方の案内を出す', () => {
    const text = textOf(
      blocksOf(
        buildStatusCard(
          status({
            status: 'completed',
            files: [
              { fileId: 'f1', fileName: 'ok.pdf', downloadPath: '/v1/x' },
            ],
            failedFiles: [
              {
                fileName: 'a.pdf',
                code: 'PLAN_PAGE_LIMIT_EXCEEDED',
                message: 'limit',
              },
              { fileName: 'b.pdf', code: 'INVALID_PARAMS', message: 'bad' },
            ],
          }),
        ),
      ),
    );
    expect(text).toContain('再生成しても解消しません');
    expect(text).toContain('プラン以外の理由で失敗したファイルは');
  });

  it.each([
    ['<!channel>'],
    ['<https://evil.example|出力履歴を開く>'],
    [Number.NaN],
    [-1],
  ])(
    'retryAfterSeconds が契約外 (%p) なら秒数の行を出さず、文字列を埋め込まない',
    (value) => {
      const text = textOf(
        blocksOf(
          buildStatusCard(
            status({ status: 'processing', retryAfterSeconds: value as never }),
          ),
        ),
      );
      expect(text).toContain('生成中');
      expect(text).not.toContain('秒ほど');
      expect(text).not.toContain('<!channel>');
      expect(text).not.toContain('evil.example');
    },
  );

  it('すべての section は verbatim: true (Slack の自動リンク・メンション化を止める)', () => {
    const blocks = blocksOf(
      buildStatusCard(
        status({
          status: 'failed',
          error: { code: 'X', message: '@channel' },
          failedFiles: [
            { fileName: 'evil.example.com', code: 'Y', message: '#general' },
          ],
        }),
      ),
    );
    const sections = blocks.filter((b) => b.type === 'section');
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) expect(s.text.verbatim).toBe(true);
  });

  it.each([
    [
      'failed (入力起因)',
      { status: 'failed', error: { code: 'X', message: 'y'.repeat(5000) } },
      '入力を直してから',
    ],
    [
      'failed (プラン起因)',
      {
        status: 'failed',
        error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: 'y'.repeat(5000) },
      },
      '再生成しても解消しません',
    ],
    [
      'completed の一部失敗 (プラン起因)',
      {
        status: 'completed',
        files: [{ fileId: 'f1', fileName: 'ok.pdf', downloadPath: '/v1/x' }],
        failedFiles: Array.from({ length: 5 }, () => ({
          fileName: 'n'.repeat(2000),
          code: 'PLAN_PAGE_LIMIT_EXCEEDED',
          message: 'm'.repeat(2000),
        })),
      },
      '再生成しても解消しません',
    ],
  ] as const)(
    '%s: 上流の文字列が長くても次の操作の案内は消えない',
    (_l, over, guidance) => {
      const text = textOf(blocksOf(buildStatusCard(status(over as never))));
      expect(text).toContain(guidance);
      // 上流の文字列 1 つは 300 文字までに切る
      expect(text).not.toContain('y'.repeat(301));
      expect(text).not.toContain('m'.repeat(301));
    },
  );

  it('completed で失敗ファイルが 0 件なら、上位に PLAN の error があってもプランの案内を出さない', () => {
    const text = textOf(
      blocksOf(
        buildStatusCard(
          status({
            status: 'completed',
            files: [
              { fileId: 'f1', fileName: 'ok.pdf', downloadPath: '/v1/x' },
            ],
            error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: '' },
          }),
        ),
      ),
    );
    expect(text).toContain('生成が完了しました');
    expect(text).not.toContain('プランの上限');
  });

  it('completed で files が配列でなくても落ちず、成功 0 件として数える', () => {
    const text = textOf(
      blocksOf(
        buildStatusCard(
          status({ status: 'completed', files: 'oops' as never }),
        ),
      ),
    );
    expect(text).toContain('*生成が完了しました*（0 件）');
  });

  it('契約外の status はカードを出さない', () => {
    expect(buildStatusCard(status({ status: 'unknown' as never }))).toBeNull();
  });

  it('requestId が不正ならカードを出さない', () => {
    expect(buildStatusCard(status({ requestId: '' }))).toBeNull();
  });

  it('長い理由でも section の text は 3000 文字以内', () => {
    const blocks = blocksOf(
      buildStatusCard(
        status({
          status: 'failed',
          error: { code: 'X', message: 'y'.repeat(5000) },
        }),
      ),
    );
    for (const b of blocks.filter((x) => x.type === 'section')) {
      expect(b.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});

describe('safeCard', () => {
  it('組み立てが例外を投げたら null (カード無し) にする', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      safeCard(() => {
        throw new TypeError('boom');
      }),
    ).toBeNull();
    // ログに出すのは例外の名前だけ (上流の値を出さない)
    expect(errorSpy.mock.calls.join(' ')).toContain('TypeError');
    expect(errorSpy.mock.calls.join(' ')).not.toContain('boom');
    errorSpy.mockRestore();
  });
});
