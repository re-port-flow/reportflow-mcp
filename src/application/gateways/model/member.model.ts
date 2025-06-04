import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany, // Added for potential relation to MemberInvite
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { ulid } from 'ulid';
import { UserType } from '@aws-sdk/client-cognito-identity-provider/dist-types/models/models_0';
import { MemberInviteModel } from '@/application/gateways/model/member.invite.model';
import { Workspace } from '@/application/gateways/model/workspace.model';
import { MemberEntity } from '@/application/domain/entity';

@Entity('m_member')
@Unique(['userId', 'workspaceId'])
export class Member {
  @PrimaryColumn({
    default: ulid(),
    type: 'varchar',
    length: 255,
  })
  id: string;

  @Column({
    name: 'user_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  userId?: string;

  @Column({
    name: 'workspace_id',
    type: 'varchar',
    length: 255,
  })
  workspaceId: string;

  @Column({
    name: 'auth_type_code',
    type: 'char',
    length: 3,
    default: '003', // Default to READ or as per your system's default
  })
  authTypeCode: string;

  @Column({
    name: 'approve',
    type: 'boolean',
    default: false,
    nullable: false,
  })
  approve: boolean;

  @Column({
    name: 'create_user_cd',
    default: 'system',
    type: 'varchar',
    length: 255,
    foreignKeyConstraintName: 'create_user_cd',
  })
  createUserCd: string;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @Column({
    name: 'updated_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  })
  updatedAt: Date;

  @Column({
    name: 'delete_flag',
    type: 'boolean',
    default: false,
  })
  deleteFlag: boolean;

  @Column({
    name: 'update_user_cd',
    default: 'system',
    type: 'varchar',
    length: 255,
    foreignKeyConstraintName: 'update_user_cd',
  })
  updateUserCd: string;

  @ManyToOne(() => Workspace, (workspace) => workspace.members)
  @JoinColumn({ name: 'workspace_id', referencedColumnName: 'id' })
  workspace: Workspace;

  @OneToMany(() => MemberInviteModel, (invite) => invite.member)
  invites: MemberInviteModel[];

  toEntity(user?: UserType): MemberEntity {
    return {
      id: this.id,
      userId: this.userId,
      workspaceId: this.workspaceId,
      approve: this.approve,
      authTypeCode: this.authTypeCode,
      user,
      workspace: this.workspace?.toEntity(),
    };
  }
}
