export interface DesignTemplateRequest {
  label: string;
}

export interface DesignTemplateResponse {
  designId: string;
  version: number;
  contents: {
    fileName: string;
    params: Record<string, string>;
  };
}

export interface CreateDocumentRequest {
  designId: string;
  version: number;
  contents: {
    fileName: string;
    params: Record<string, any>;
  };
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}
