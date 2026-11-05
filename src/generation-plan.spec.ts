import { failedFilesOf, planCauseOf } from './generation-plan';

describe('planCauseOf !== none (プラン起因が 1 件でもあるか) (PRJ-3-2563)', () => {
  it.each([
    [{ error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: '' } }, true],
    [{ error: { code: 'ACTIVE_PLAN_NOT_FOUND', message: '' } }, true],
    [{ error: { code: 'INVALID_PARAMS', message: '' } }, false],
    // PLAN を語として含まないものは対象外
    [{ error: { code: 'PLANNER_ERROR', message: '' } }, false],
    [
      {
        error: { code: 'FILE_GENERATION_FAILED', message: '' },
        failedFiles: [
          { fileName: 'a.pdf', code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: '' },
        ],
      },
      true,
    ],
    [
      {
        error: { code: 'FILE_GENERATION_FAILED', message: '' },
        failedFiles: [
          { fileName: 'a.pdf', code: 'RENDER_FAILED', message: '' },
        ],
      },
      false,
    ],
    [{}, false],
  ])('%j → %s', (status, expected) => {
    expect(planCauseOf(status) !== 'none').toBe(expected);
  });
});

describe('planCauseOf (PRJ-3-2563)', () => {
  const f = (code: string) => ({ fileName: `${code}.pdf`, code, message: '' });
  it.each([
    [
      '単一出力の PLAN',
      { error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: '' } },
      'all',
    ],
    [
      '単一出力の入力誤り',
      { error: { code: 'INVALID_PARAMS', message: '' } },
      'none',
    ],
    [
      '全件 PLAN',
      {
        error: { code: 'FILE_GENERATION_FAILED', message: '' },
        failedFiles: [
          f('PLAN_PAGE_LIMIT_EXCEEDED'),
          f('ACTIVE_PLAN_NOT_FOUND'),
        ],
      },
      'all',
    ],
    [
      'PLAN と入力誤りの混在',
      {
        error: { code: 'FILE_GENERATION_FAILED', message: '' },
        failedFiles: [f('PLAN_PAGE_LIMIT_EXCEEDED'), f('INVALID_PARAMS')],
      },
      'mixed',
    ],
    [
      '全件入力誤り',
      {
        error: { code: 'FILE_GENERATION_FAILED', message: '' },
        failedFiles: [f('INVALID_PARAMS')],
      },
      'none',
    ],
    [
      '上位 PLAN + ファイル側は別理由',
      {
        error: { code: 'PLAN_PAGE_LIMIT_EXCEEDED', message: '' },
        failedFiles: [f('RENDER_FAILED')],
      },
      'mixed',
    ],
    ['何も無い', {}, 'none'],
  ] as const)('%s → %s', (_l, status, expected) => {
    expect(planCauseOf(status as Parameters<typeof planCauseOf>[0])).toBe(
      expected,
    );
  });
});

describe('failedFilesOf', () => {
  it.each([
    ['undefined', undefined, 0],
    ['配列でない', {}, 0],
    [
      'null の要素を捨てる',
      [null, { fileName: 'a', code: 'X', message: '' }],
      1,
    ],
  ])('%s', (_l, failedFiles, expected) => {
    expect(
      failedFilesOf({ failedFiles } as Parameters<typeof failedFilesOf>[0]),
    ).toHaveLength(expected);
  });
});
