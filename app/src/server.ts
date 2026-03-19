import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { name, version } from '../package.json';
import {
  getDesignParametersTool,
  getDesignParametersInputSchema,
  handleGetDesignParameters,
  type GetDesignParametersInput,
} from './tools/get-design-parameters.js';

export const startServer = async (): Promise<void> => {
  const server = new McpServer({
    name,
    version,
  });

  server.tool(
    getDesignParametersTool.name,
    getDesignParametersTool.description,
    getDesignParametersInputSchema.shape,
    async (input) =>
      handleGetDesignParameters(input as GetDesignParametersInput),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
};
