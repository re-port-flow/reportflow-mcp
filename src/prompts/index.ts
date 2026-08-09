import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
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
  server.registerPrompt(
    generatePdfPromptDef.name,
    {
      description: generatePdfPromptDef.description,
      argsSchema: z.object(generatePdfPromptDef.argsSchema),
    },
    (args) => handleGeneratePdfPrompt(args),
  );
  server.registerPrompt(
    generatePdfsPromptDef.name,
    {
      description: generatePdfsPromptDef.description,
      argsSchema: z.object(generatePdfsPromptDef.argsSchema),
    },
    (args) => handleGeneratePdfsPrompt(args),
  );
  server.registerPrompt(
    reportflowHelpPromptDef.name,
    { description: reportflowHelpPromptDef.description },
    () => handleReportflowHelp(),
  );
};
