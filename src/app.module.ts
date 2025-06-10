import { Module } from '@nestjs/common';
import { McpModule, McpTransportType } from '@/mcp';
// Note: The stateful server exposes SSE and Streamable HTTP endpoints.
@Module({
  imports: [
    McpModule.forRoot({
      name: 'playground-mcp-server',
      version: '0.0.1',
      transport: McpTransportType.STDIO,
    }),
  ],
})
export class AppModule {}

// @Module({
//   imports: [
//     McpModule.forRoot({
//       name: 'playground-mcp-server',
//       version: '0.0.1',
//       streamableHttp: {
//         enableJsonResponse: false,
//         sessionIdGenerator: () => randomUUID(),
//         statelessMode: false,
//       },
//     }),
//   ],
// })
// export class AppModule {}
