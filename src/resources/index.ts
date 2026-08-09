import type { McpServer } from '@modelcontextprotocol/server';
import { registerDesignsResource } from './designs.js';
import { registerDesignParametersResource } from './design-parameters.js';
import { registerErrorCatalogResource } from './error-catalog.js';
import { registerServerInfoResource } from './server-info.js';

export const registerResources = (
  server: McpServer,
  pkg: { name: string; version: string },
): void => {
  registerDesignsResource(server);
  registerDesignParametersResource(server);
  registerErrorCatalogResource(server);
  registerServerInfoResource(server, pkg);
};
