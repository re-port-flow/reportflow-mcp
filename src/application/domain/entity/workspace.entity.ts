import { MemberEntity } from '@/application/domain/entity/member.entity';
import {
  WorkspacePlanEntity,
  WorkspacePlanType,
} from '@/application/domain/entity/workspace_plan.entity';

export type WorkspaceEntity = {
  id: string;
  name: string;
  overview?: string;
  icon?: string;
  stripeCustomerId?: string;
  members?: MemberEntity[];
  applicationToken?: ApplicationToken;
  workspacePlan?: WorkspacePlanEntity;
};

export type WorkspaceCreateParams = {
  name: string;
  overview?: string;
  userId: string;
};

export type WorkspacePlanParams = {
  planType: WorkspacePlanType;
  stripePlanCode?: string;
};

export type ApplicationToken = {
  token: string;
  secretToken: string;
};
