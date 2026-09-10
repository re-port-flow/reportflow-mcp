import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skillPath = join(__dirname, '..', 'skills', 're-port-flow', 'SKILL.md');
const skill = readFileSync(skillPath, 'utf8');

describe('re-port-flow Agent Skill (PRJ-3-1449)', () => {
  it('has Agent Skills frontmatter and is not a copy of agents.md', () => {
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toMatch(/^name: re-port-flow$/m);
    expect(skill).toMatch(/description:/);
    expect(skill).toContain('https://mcp.re-port-flow.com/mcp');
    expect(skill).not.toContain('from huggingface_hub import MCPClient');
  });

  it('forbids inventing business data and generating on the Space MCP', () => {
    expect(skill.toLowerCase()).toContain('never invent');
    expect(skill).toContain('copy_gallery_template');
    expect(skill).toContain('get_design_parameters');
    expect(skill).toContain('generate_pdf_sync');
    expect(skill).toMatch(/not the Hugging\s+Face Space MCP/i);
    expect(skill).toMatch(/read-only/i);
  });
});
