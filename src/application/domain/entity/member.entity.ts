import { UserType } from '@aws-sdk/client-cognito-identity-provider/dist-types/models/models_0';
import { WorkspaceEntity } from '@/application/domain/entity/workspace.entity';

export type MemberEntity = {
  id: string;
  userId?: string;
  workspaceId: string;
  authTypeCode: string;
  approve: boolean;
  user?: UserType;
  workspace?: WorkspaceEntity;
};

export type MemberCreateParams = {
  userId?: string;
  email?: string;
  workspaceId: string;
  authTypeCode: string;
  inviterUserId: string;
};

export enum AuthType {
  ADMIN = '001',
  WRITE = '002',
  READ = '003',
  UNREAD = '004',
}
