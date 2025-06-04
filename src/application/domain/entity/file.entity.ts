import { DesignEntity } from 'src/application/domain/entity/design.entity';

export type FileEntity = {
  id: string;
  designId: string;
  version: number;
  exportSize: number;
  exportDate: Date;
  design: DesignEntity;
};

export type FileListParams = {
  userId: string;
  workspaceId: string;
  limit?: number;
  offset?: number;
  designs: FileDesignParams[];
};

type FileDesignParams = {
  designId: string;
  version: number[];
};

export type FileListResults = {
  results: FileEntity[];
  count: number;
};
