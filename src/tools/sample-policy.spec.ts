import { SAMPLE_GENERATION_POLICY } from './sample-policy';
import { getDesignParametersTool } from './get-design-parameters';
import { generatePdfSyncTool } from './generate-pdf-sync';
import { SERVER_INSTRUCTIONS } from '../instructions';

// PRJ-3-2280: ツール説明の「架空値の生成は禁止」と、接続時の案内 (instructions) の
// 「明示ラベル付きのサンプルを先に 1 枚作ってよい」が逆向きだったのを、1 文にそろえた。
describe('試用時のサンプル生成の方針（PRJ-3-2280）', () => {
  const tools = [getDesignParametersTool, generatePdfSyncTool];

  it.each(tools)('$name の説明に方針の文がそのまま入る', (tool) => {
    expect(tool.description).toContain(SAMPLE_GENERATION_POLICY);
  });

  it.each(tools)(
    '$name の説明に、サンプルを一律に禁じる旧文言が残っていない',
    (tool) => {
      expect(tool.description).not.toContain('架空値の生成は禁止');
      expect(tool.description).not.toContain('架空の値を勝手に生成しないこと');
    },
  );

  it('実データを推測で埋めない方針は維持する', () => {
    expect(SAMPLE_GENERATION_POLICY).toContain(
      '実データを推測やプレースホルダーで埋めないこと',
    );
  });

  it('サンプルは了承後に 1 枚だけ、サンプルと明記し、実データで作り直す前提で許す', () => {
    expect(SAMPLE_GENERATION_POLICY).toContain('1 枚だけ');
    expect(SAMPLE_GENERATION_POLICY).toContain('ユーザーが了承したときに限り');
    expect(SAMPLE_GENERATION_POLICY).toContain('サンプルであることを明記');
    expect(SAMPLE_GENERATION_POLICY).toContain('実データで作り直す');
    expect(SAMPLE_GENERATION_POLICY).toContain('出力ページを消費する');
  });

  it('instructions 側も同じ方針（サンプルを先に 1 枚・実データで作り直す）のまま', () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      'offer to generate one clearly-labelled sample first and redo it with real data',
    );
  });

  it('ツール名は変わらない', () => {
    expect(getDesignParametersTool.name).toBe('get_design_parameters');
    expect(generatePdfSyncTool.name).toBe('generate_pdf_sync');
  });
});
