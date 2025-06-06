import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { McpService } from '@/mcpPdf/mcp.service';
import { ApiService } from '@/mcpPdf/api.service';
import { McpController } from '@/mcpPdf/mcp.controller';
import { DocumentTool } from '@/mcpPdf/tools/document.tool';

@Module({
  imports: [HttpModule, ConfigModule],
  controllers: [McpController],
  providers: [McpService, ApiService, DocumentTool],
  exports: [McpService, ApiService],
})
export class McpModule {}
