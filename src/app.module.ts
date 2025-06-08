import { Module } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { McpModule, McpTransportType } from '@/mcp';
import { GreetingResource } from '@/resources/greeting.resource';
import { GreetingTool } from '@/resources/greeting.tool';
import { GreetingPrompt } from '@/resources/greeting.prompt';

// Note: The stateful server exposes SSE and Streamable HTTP endpoints.
@Module({
  imports: [
    McpModule.forRoot({
      name: 'playground-mcp-server',
      version: '0.0.1',
      transport: McpTransportType.STDIO,
    }),
  ],
  providers: [GreetingResource, GreetingTool, GreetingPrompt],
})
export class AppModule {}
