import { Module } from '@nestjs/common';
import { McpModule } from './mcp/mcp.module';
import { McpModule as McpDecModule, McpTransportType } from '@rekog/mcp-nest';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    McpModule,
    McpDecModule.forRoot({
      name: 'document-generation-mcp',
      version: '1.0.0',
      transport: McpTransportType.SSE, // or McpTransportType.STDIO for command-line usage
    }),
  ],
  providers: [],
})
export class AppModule {}
