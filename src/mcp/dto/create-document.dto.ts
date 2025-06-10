export class CreateDocumentDto {
  designId: string;
  version: number;
  content: {
    fileName: string;
    params: Record<string, any>;
  };
}
