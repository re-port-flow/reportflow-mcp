import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { McpOptions, McpTransportType } from './interfaces';
import { McpExecutorService } from './services/mcp-executor.service';
import { McpRegistryService } from './services/mcp-registry.service';
import { SsePingService } from './services/sse-ping.service';
import { createSseController } from './transport/sse.controller.factory';
import { StdioService } from './transport/stdio.service';
import { createStreamableHttpController } from './transport/streamable-http.controller.factory';
import { normalizeEndpoint } from './utils/normalize-endpoint';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { McpController } from '@/mcp/mcp.controller';
import { McpService } from '@/mcp/mcp.service';
import { ApiService } from '@/mcp/api.service';
import { GreetingResource } from '@/mcp/resources/greeting.resource';
import { GreetingTool } from '@/mcp/resources/greeting.tool';
import { GreetingPrompt } from '@/mcp/resources/greeting.prompt';
import { DocumentTool } from '@/mcp/tools/document.tool';
// import { DocumentTool } from '@/mcp/tools/document.tool';

@Module({
  imports: [HttpModule, ConfigModule, DiscoveryModule],
  controllers: [McpController],
  providers: [
    McpRegistryService,
    McpExecutorService,
    McpService,
    ApiService,
    DocumentTool,
  ],
})
export class McpModule {
  static forRoot(options: McpOptions): DynamicModule {
    const defaultOptions: Partial<McpOptions> = {
      transport: [
        McpTransportType.SSE,
        McpTransportType.STREAMABLE_HTTP,
        McpTransportType.STDIO,
      ],
      sseEndpoint: 'sse',
      messagesEndpoint: 'messages',
      mcpEndpoint: 'mcp',
      guards: [],
      decorators: [],
      streamableHttp: {
        enableJsonResponse: true,
        sessionIdGenerator: undefined,
        statelessMode: true,
      },
      sse: {
        pingEnabled: true,
        pingIntervalMs: 30000,
      },
    };
    const mergedOptions = { ...defaultOptions, ...options } as McpOptions;
    mergedOptions.sseEndpoint = normalizeEndpoint(mergedOptions.sseEndpoint);
    mergedOptions.messagesEndpoint = normalizeEndpoint(
      mergedOptions.messagesEndpoint,
    );
    mergedOptions.mcpEndpoint = normalizeEndpoint(mergedOptions.mcpEndpoint);
    const providers = this.createProvidersFromOptions(mergedOptions);
    const controllers = this.createControllersFromOptions(mergedOptions);

    return {
      module: McpModule,
      controllers,
      providers,
      exports: [McpRegistryService],
    };
  }

  private static createControllersFromOptions(
    options: McpOptions,
  ): Type<any>[] {
    const sseEndpoint = options.sseEndpoint ?? 'sse';
    const messagesEndpoint = options.messagesEndpoint ?? 'messages';
    const mcpEndpoint = options.mcpEndpoint ?? 'mcp';
    const guards = options.guards ?? [];
    const transports = Array.isArray(options.transport)
      ? options.transport
      : [options.transport ?? McpTransportType.SSE];
    const controllers: Type<any>[] = [];
    const decorators = options.decorators ?? [];

    if (transports.includes(McpTransportType.SSE)) {
      const sseController = createSseController(
        sseEndpoint,
        messagesEndpoint,
        guards,
        decorators,
      );
      controllers.push(sseController);
    }

    if (transports.includes(McpTransportType.STREAMABLE_HTTP)) {
      const streamableHttpController = createStreamableHttpController(
        mcpEndpoint,
        guards,
        decorators,
      );
      controllers.push(streamableHttpController);
    }

    if (transports.includes(McpTransportType.STDIO)) {
      // STDIO transport is handled by injectable StdioService, no controller
    }

    return controllers;
  }

  private static createProvidersFromOptions(options: McpOptions): Provider[] {
    const providers: Provider[] = [
      {
        provide: 'MCP_OPTIONS',
        useValue: options,
      },
      McpRegistryService,
      McpExecutorService,
    ];

    const transports = Array.isArray(options.transport)
      ? options.transport
      : [options.transport ?? McpTransportType.SSE];

    if (transports.includes(McpTransportType.SSE)) {
      providers.push(SsePingService);
    }

    if (transports.includes(McpTransportType.STDIO)) {
      providers.push(StdioService);
    }

    return providers;
  }
}
