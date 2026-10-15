import {
  generatePdfsPromptDef,
  handleGeneratePdfsPrompt,
} from './batch-generate-recipe.js';

describe('generate_pdfs prompt', () => {
  it('declares its name and args schema', () => {
    expect(generatePdfsPromptDef.name).toBe('generate_pdfs');
    expect(Object.keys(generatePdfsPromptDef.argsSchema)).toEqual([
      'designId',
      'source',
      'outputDir',
      'zipFileName',
    ]);
  });

  it('uses provided designId and skips the template-selection flow', () => {
    const text = handleGeneratePdfsPrompt({ designId: 'design-9' })
      .messages[0].content.text;
    expect(text).toContain('design-9');
    expect(text).not.toContain('list_templates から選ぶ');
  });

  it('falls back to the template-selection instruction when designId omitted', () => {
    const text = handleGeneratePdfsPrompt({}).messages[0].content.text;
    expect(text).toContain('list_templates');
    expect(text).toContain('get_design_parameters');
  });

  it('embeds a provided data source description', () => {
    const text = handleGeneratePdfsPrompt({
      source: './data.csv の各行',
    }).messages[0].content.text;
    expect(text).toContain('./data.csv の各行');
  });

  it('gives the generic data-source instruction when source omitted', () => {
    const text = handleGeneratePdfsPrompt({}).messages[0].content.text;
    expect(text).toContain('各行を `{ fileName, params }` の形に展開');
  });

  it('mentions outputDir and zipFileName when provided', () => {
    const text = handleGeneratePdfsPrompt({
      outputDir: './out',
      zipFileName: 'bundle.zip',
    }).messages[0].content.text;
    expect(text).toContain('./out');
    expect(text).toContain('bundle.zip');
  });

  it('tells Claude to omit outputDir/zipFileName when not provided', () => {
    const text = handleGeneratePdfsPrompt({}).messages[0].content.text;
    expect(text).toContain('outputDir はユーザーが明示した場合のみ指定');
    expect(text).not.toContain('zipFileName は');
  });

  // PRJ-3-2016: 同期生成は 60 秒で 504 になる。根拠の無い件数 (旧「〜数十件」) ではなく
  // 60 秒の上限で sync / async を選ばせる。
  it('chooses sync vs async by the 60-second sync limit, not by a fixed count', () => {
    const text = handleGeneratePdfsPrompt({}).messages[0].content.text;
    expect(text).toContain('60 秒');
    expect(text).toContain('generate_pdfs_async');
    expect(text).not.toContain('数十件');
  });

  it('always reminds about re-authentication', () => {
    const text = handleGeneratePdfsPrompt({}).messages[0].content.text;
    expect(text).toContain('authenticate');
  });
});
