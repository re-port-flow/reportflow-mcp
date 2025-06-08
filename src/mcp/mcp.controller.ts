import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { McpService } from '@/mcp/mcp.service';
import { CreateMcpDto } from '@/mcp/dto/create-mcp.dto';
import { CreateDocumentDto } from '@/mcp/dto/create-document.dto';

@Controller('mcp')
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  /**
   * Endpoint for the LLM to fetch a design template using a label.
   */
  @Post('template')
  @HttpCode(HttpStatus.OK)
  async getTemplate(@Body() createMcpDto: CreateMcpDto) {
    return this.mcpService.getDesignTemplate(createMcpDto.label);
  }

  /**
   * Endpoint for the LLM to submit structured data to create a document.
   */
  @Post('document')
  @HttpCode(HttpStatus.CREATED)
  async createDocument(@Body() createDocumentDto: CreateDocumentDto) {
    return this.mcpService.createDocument(createDocumentDto);
  }
}
