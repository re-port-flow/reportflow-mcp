import { HttpError } from '../http';
import { isSyncGenerationTimeout, SYNC_TIMEOUT_GUIDANCE } from './sync-timeout';

describe('isSyncGenerationTimeout (PRJ-3-2016)', () => {
  it.each([504, 524])('HttpError %d は時間切れ', (status) => {
    expect(isSyncGenerationTimeout(new HttpError(status, 'timeout'))).toBe(
      true,
    );
  });

  it('MCP 側のタイムアウト (http.ts の文言) は時間切れ', () => {
    expect(
      isSyncGenerationTimeout(new Error('Request timed out after 125000ms')),
    ).toBe(true);
  });

  // 取りすぎの側: 入力の誤りや他の 5xx を時間切れ扱いすると、
  // 「入力を照合して」という正しい案内が消える。
  it.each([400, 401, 404, 429, 500, 502, 503])(
    'HttpError %d は時間切れではない',
    (status) => {
      expect(isSyncGenerationTimeout(new HttpError(status, 'x'))).toBe(false);
    },
  );

  it('通信断などの一般的なエラーと Error 以外は時間切れではない', () => {
    expect(isSyncGenerationTimeout(new Error('fetch failed'))).toBe(false);
    expect(isSyncGenerationTimeout('Request timed out after 1ms')).toBe(false);
    expect(isSyncGenerationTimeout(undefined)).toBe(false);
  });
});

describe('SYNC_TIMEOUT_GUIDANCE (PRJ-3-2016)', () => {
  // 生成し直しは同期でも async でもページを消費する。最初の生成が完了していれば
  // 二重消費になるので、出力履歴の確認 → 未生成なら了承を得て async、の順を固定する。
  it('出力履歴の確認が生成し直しより前にあり、生成し直しには利用者の了承を求める', () => {
    const historyAt = SYNC_TIMEOUT_GUIDANCE.indexOf('出力履歴');
    const asyncAt = SYNC_TIMEOUT_GUIDANCE.indexOf('generate_pdfs_async');
    expect(historyAt).toBeGreaterThanOrEqual(0);
    expect(asyncAt).toBeGreaterThan(historyAt);
    expect(SYNC_TIMEOUT_GUIDANCE).toContain('了承を得てから');
    expect(SYNC_TIMEOUT_GUIDANCE).toContain('生成済みでなかった場合に限り');
  });
});
