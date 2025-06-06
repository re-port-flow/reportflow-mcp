import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { CreateMcpDto } from './dto/create-mcp.dto';
import { UpdateMcpDto } from './dto/update-mcp.dto';
import { CreateDocumentDto } from './dto/create-document.dto';
import { DesignTemplateResponse } from '@/mcp/types/mcp.types';

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private apiBaseUrl: string;
  private appKey: string;
  private secretKey: string;
  private templateCache = new Map<string, DesignTemplateResponse>();

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.apiBaseUrl = this.configService.get<string>(
      'API_BASE_URL',
      'http://localhost:3002',
    );
    this.appKey = this.configService.get<string>('APP_KEY', '');
    this.secretKey = this.configService.get<string>('SECRET_KEY', '');
  }

  // Core MCP functionality
  async getDesignTemplate(label: string) {
    this.logger.log(`Fetching design template for label: ${label}`);

    if (this.templateCache.has(label)) {
      this.logger.log(`Using cached template for: ${label}`);
      return this.templateCache.get(label);
    }

    try {
      const headers = this.getHeaders();
      const response = await firstValueFrom(
        this.httpService.post<DesignTemplateResponse>(
          `${this.apiBaseUrl}/v1/getDesignTemplate`,
          { label },
          { headers },
        ),
      );

      // Cache the template
      this.templateCache.set(label, response.data);
      this.logger.log(
        `Successfully fetched and cached template: ${response.data.designId}`,
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Failed to get design template: ${error.message}`);
      throw new HttpException(
        `Failed to get design template: ${error.message}`,
        error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async createDocument(data: CreateDocumentDto) {
    this.logger.log(`Creating document with designId: ${data.designId}`);

    try {
      const headers = this.getHeaders();
      const response = await firstValueFrom(
        this.httpService.post(`${this.apiBaseUrl}/v1/async/single`, data, {
          headers,
        }),
      );

      this.logger.log(
        `Successfully created document: ${response.data.id || 'success'}`,
      );
      return {
        success: true,
        result: response.data,
        message: 'Document created successfully',
      };
    } catch (error) {
      this.logger.error(`Failed to create document: ${error.message}`);
      throw new HttpException(
        `Failed to create document: ${error.message}`,
        error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async validateDocumentParams(label: string, params: Record<string, any>) {
    const template = await this.getDesignTemplate(label);
    const errors: string[] = [];
    const requiredParams = template.contents.params;

    for (const [key, type] of Object.entries(requiredParams)) {
      if (!(key in params)) {
        errors.push(`Missing required parameter: ${key}`);
        continue;
      }

      const value = params[key];
      const actualType = typeof value;

      if (type === 'number' && actualType !== 'number') {
        errors.push(`Parameter ${key} must be a number, got ${actualType}`);
      } else if (type === 'string' && actualType !== 'string') {
        errors.push(`Parameter ${key} must be a string, got ${actualType}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      template: template.contents.params,
      providedParams: params,
    };
  }

  // Standard CRUD operations (optional - for local template management)
  create(createMcpDto: CreateMcpDto) {
    // This could save templates locally if needed
    return 'This action adds a new mcp template';
  }

  findAll() {
    // Return all cached templates
    const templates = Array.from(this.templateCache.entries()).map(
      ([label, template]) => ({
        label,
        designId: template.designId,
        version: template.version,
        parameters: Object.keys(template.contents.params),
      }),
    );

    return {
      cachedTemplates: templates,
      count: templates.length,
    };
  }

  findOne(id: number) {
    return `This action returns a #${id} mcp`;
  }

  update(id: number, updateMcpDto: UpdateMcpDto) {
    return `This action updates a #${id} mcp`;
  }

  remove(id: number) {
    // Clear from cache if exists
    return `This action removes a #${id} mcp`;
  }

  // Helper methods
  private getHeaders() {
    const headers: Record<string, any> = {
      'Content-Type': 'application/json',
      appkey: this.appKey,
      secretKey: this.secretKey,
    };

    return headers;
  }
}
