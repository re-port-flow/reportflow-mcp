import { Module } from '@nestjs/common';
import { McpModule, McpTransportType } from '@/mcp';
import { GreetingResource } from '@/mcp/resources/greeting.resource';
import { GreetingTool } from '@/mcp/resources/greeting.tool';
import { GreetingPrompt } from '@/mcp/resources/greeting.prompt';
import { randomUUID } from 'crypto';

// Note: The stateful server exposes SSE and Streamable HTTP endpoints.
// @Module({
//   imports: [
//     McpModule.forRoot({
//       name: 'playground-mcp-server',
//       version: '0.0.1',
//       transport: [McpTransportType.STDIO, McpTransportType.SSE],
//     }),
//   ],
//   providers: [GreetingResource, GreetingTool, GreetingPrompt],
// })
// export class AppModule {}

@Module({
  imports: [
    McpModule.forRoot({
      name: 'playground-mcp-server',
      version: '0.0.1',
      streamableHttp: {
        enableJsonResponse: false,
        sessionIdGenerator: () => randomUUID(),
        statelessMode: false,
      },
    }),
  ],
})
export class AppModule {}
