import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { CreateDocumentDto } from './dto/create-document.dto';
import { DesignTemplateResponse } from '@/mcp/types/mcp.types';
import { AxiosError, AxiosResponse } from 'axios';

import { config as dotenvConfig } from 'dotenv';
import * as process from 'node:process';

dotenvConfig({ path: '.env' });

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly apiBaseUrl: string;
  private readonly appKey: string;
  private readonly secretKey: string;
  private templateCache = new Map<string, DesignTemplateResponse>();

  constructor(private readonly httpService: HttpService) {
    this.apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3002';
    this.appKey = process.env.APP_KEY || '';
    this.secretKey = process.env.SECRET_KEY || '';
  }

  async getDesignTemplate(label: string) {
    this.logger.log(`Fetching design template for label: ${label}`);

    if (this.templateCache.has(label)) {
      this.logger.log(`Using cached template for: ${label}`);
      return this.templateCache.get(label);
    }

    try {
      const response =
        await this.httpService.axiosRef.post<DesignTemplateResponse>(
          `${this.apiBaseUrl}/v1/getDesignTemplate`,
          { label: label },
          {
            headers: this.getHeaders(),
          },
        );

      // Cache the template
      this.templateCache.set(label, response.data);
      this.logger.log(
        `Successfully fetched and cached template: ${response.data.designId}`,
      );

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      const message = axiosError.message || 'Unknown error occurred';

      this.logger.error(`Failed to get design template: ${message}`);
      throw new HttpException(
        `Failed to get design template: ${message}`,
        axiosError.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async createDocument(data: CreateDocumentDto, label: string) {
    const validation = await this.validateDocumentParams(
      label,
      data.content.params,
    );

    if (!validation.valid) {
      throw new HttpException(
        {
          message: '文档参数验证失败',
          errors: validation.errors,
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const response = await this.httpService.axiosRef.post<AxiosResponse>(
        `${this.apiBaseUrl}/v1/async/single`,
        data,
        {
          headers: this.getHeaders(),
        },
      );

      return {
        success: true,
        result: response.data,
        message: 'Document created successfully',
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      const message = axiosError.message || 'Unknown error occurred';

      this.logger.error(`Failed to create document: ${message}`);
      throw new HttpException(
        `Failed to create document: ${message}`,
        axiosError.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
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

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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

  // Helper methods
  private getHeaders() {
    return {
      'Content-Type': 'application/json',
      AppKey: this.appKey,
      SecretKey: this.secretKey,
    };
  }
}
