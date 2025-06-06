import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  CreateDocumentRequest,
  DesignTemplateRequest,
  DesignTemplateResponse,
} from '@/mcpPdf/types/mcp.types';

@Injectable()
export class ApiService {
  private apiBaseUrl: string;

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.apiBaseUrl = this.configService.get<string>(
      'API_BASE_URL',
      'http://localhost:3001',
    );
  }

  async getDesignTemplate(label: string): Promise<DesignTemplateResponse> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<DesignTemplateResponse>(
          `${this.apiBaseUrl}/v1/getDesignTemplate`,
          { label } as DesignTemplateRequest,
        ),
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        `Failed to get design template: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async createDocument(data: CreateDocumentRequest): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.apiBaseUrl}/v1/async/single`, data),
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        `Failed to create document: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
