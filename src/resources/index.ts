import type { McpServer } from '@modelcontextprotocol/server';
import { registerDesignsResource } from './designs.js';
import { registerDesignParametersResource } from './design-parameters.js';
import { registerErrorCatalogResource } from './error-catalog.js';
import { registerServerInfoResource } from './server-info.js';
import type { CapabilityGetter } from './server-info.js';
import type { CapabilityToggle } from '../workspace-permission.js';

/**
 * 登録済みリソースのハンドル。キーは `registerResource` の第 1 引数
 * （`RESOURCE_CAPABILITIES` のキーと一致させる）。
 *
 * ワークスペース権限に応じて `resources/list` から出し入れするため、登録して
 * 捨てずに返す（PRJ-3-1584 / ST-3）。`designs` と `design-parameters` は
 * content-service のワークスペース API を叩くので READ 以上が要る。
 */
export type RegisteredResourceHandles = Map<string, CapabilityToggle>;

export const registerResources = (
  server: McpServer,
  pkg: { name: string; version: string },
  getGranted: CapabilityGetter,
): RegisteredResourceHandles =>
  new Map<string, CapabilityToggle>([
    ['designs', registerDesignsResource(server)],
    ['design-parameters', registerDesignParametersResource(server)],
    ['errors', registerErrorCatalogResource(server)],
    ['server-info', registerServerInfoResource(server, pkg, getGranted)],
  ]);
