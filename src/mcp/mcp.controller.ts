import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { McpService } from '@/mcp/mcp.service';
import { CreateMcpDto } from '@/mcp/dto/create-mcp.dto';
import { CreateDocumentDto } from '@/mcp/dto/create-document.dto';

@Controller('mcp')
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  // REST endpoints for testing MCP functionality via HTTP
  @Post('template')
  @HttpCode(HttpStatus.OK)
  async getTemplate(@Body() getTemplateDto: CreateMcpDto) {
    return this.mcpService.getDesignTemplate(getTemplateDto.label);
  }

  @Post('document')
  @HttpCode(HttpStatus.CREATED)
  async createDocument(@Body() createDocumentDto: CreateDocumentDto) {
    return this.mcpService.createDocument(createDocumentDto);
  }

  // @Post('validate')
  // @HttpCode(HttpStatus.OK)
  // async validateParams(
  //   @Body() body: { label: string; params: Record<string, any> },
  // ) {
  //   return this.mcpService.validateDocumentParams(body.label, body.params);
  // }
}
