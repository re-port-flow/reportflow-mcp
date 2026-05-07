import { handleGeneratePdfPrompt } from './generate-pdf-recipe.js';

describe('handleGeneratePdfPrompt', () => {
  it('uses provided designId in instructions', () => {
    const result = handleGeneratePdfPrompt({ designId: 'design-123' });
    expect(result.messages).toHaveLength(1);
    const text = result.messages[0].content.text;
    expect(text).toContain('design-123');
    expect(text).not.toContain('list_templates を呼んでデザイン一覧');
  });

  it('falls back to list_templates flow when designId omitted', () => {
    const result = handleGeneratePdfPrompt({});
    const text = result.messages[0].content.text;
    expect(text).toContain('list_templates');
    expect(text).toContain('get_design_parameters');
  });

  it('embeds description verbatim', () => {
    const result = handleGeneratePdfPrompt({
      description: '請求書、宛先A社、合計1万円',
    });
    expect(result.messages[0].content.text).toContain(
      '請求書、宛先A社、合計1万円',
    );
  });

  it('mentions outputDir when provided, else tells Claude to omit', () => {
    const withDir = handleGeneratePdfPrompt({ outputDir: './out' });
    expect(withDir.messages[0].content.text).toContain('./out');

    const without = handleGeneratePdfPrompt({});
    expect(without.messages[0].content.text).toContain(
      'ユーザーが明示した場合のみ',
    );
  });
});
