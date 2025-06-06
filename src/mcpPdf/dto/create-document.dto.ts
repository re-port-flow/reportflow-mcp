export class CreateDocumentDto {
  designId: string;
  version: number;
  contents: {
    fileName: string;
    params: Record<string, any>;
  };
}
