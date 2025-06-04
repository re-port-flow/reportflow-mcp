import { AuthType } from '@/application/domain/entity/member.entity';

export enum InvitationStatus {
  PENDING = '01',
  ACCEPT = '02',
}

export type MemberInviteEntity = {
  id: string;
  workspaceId: string;
  memberId: string;
  email: string;
  status: InvitationStatus;
  createdAt?: Date;
  updatedAt?: Date;
};

export type MemberInviteCreateParams = {
  workspaceId: string;
  memberId: string;
  email: string;
  invitationToken: string;
  authTypeCode: AuthType;
  expiresAt: Date;
  status: InvitationStatus;
  inviterUserId: string;
};
