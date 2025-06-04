import { VersionEntity } from 'src/application/domain/entity/version.entity';

export type DesignEntity = {
  id: string;
  label: string;
  workspaceId: string;
  thumbnail: string;
  latestVersion: number;
  updateAt: Date;
  version: VersionEntity;
};
