import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { McpService } from '@/mcp/mcp.service';
import { ApiService } from '@/mcp/api.service';
import { McpController } from '@/mcp/mcp.controller';

@Module({
  imports: [HttpModule, ConfigModule],
  controllers: [McpController],
  providers: [McpService, ApiService],
})
export class McpModule {}
