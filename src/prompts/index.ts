import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  generatePdfPromptDef,
  handleGeneratePdfPrompt,
} from './generate-pdf-recipe.js';
import {
  generatePdfsPromptDef,
  handleGeneratePdfsPrompt,
} from './batch-generate-recipe.js';
import { reportflowHelpPromptDef, handleReportflowHelp } from './help.js';

export const registerPrompts = (server: McpServer): void => {
  server.prompt(
    generatePdfPromptDef.name,
    generatePdfPromptDef.description,
    generatePdfPromptDef.argsSchema,
    (args) => handleGeneratePdfPrompt(args),
  );
  server.prompt(
    generatePdfsPromptDef.name,
    generatePdfsPromptDef.description,
    generatePdfsPromptDef.argsSchema,
    (args) => handleGeneratePdfsPrompt(args),
  );
  server.prompt(
    reportflowHelpPromptDef.name,
    reportflowHelpPromptDef.description,
    () => handleReportflowHelp(),
  );
};
