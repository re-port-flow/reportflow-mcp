import { handleReportflowHelp, reportflowHelpPromptDef } from './help.js';

describe('reportflow_help prompt', () => {
  it('exposes a name and description', () => {
    expect(reportflowHelpPromptDef.name).toBe('reportflow_help');
    expect(reportflowHelpPromptDef.description.length).toBeGreaterThan(0);
  });

  it('returns a single user message summarizing the server capabilities', () => {
    const result = handleReportflowHelp();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content.type).toBe('text');
  });

  it('mentions the prompts, tools, resources and sampling sections', () => {
    const text = handleReportflowHelp().messages[0].content.text;
    expect(text).toContain('## Prompts');
    expect(text).toContain('## Tools');
    expect(text).toContain('## Resources');
    expect(text).toContain('## Sampling');
    expect(text).toContain('## Roots');
    // A few concrete anchors so a rename of the surface is caught here.
    expect(text).toContain('/generate_pdf');
    expect(text).toContain('authenticate');
    expect(text).toContain('reportflow://designs');
  });
});
