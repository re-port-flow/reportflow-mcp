import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  InvitationStatus,
  MemberInviteEntity,
} from '@/application/domain/entity';
import { Member } from '@/application/gateways/model/member.model';
import { Workspace } from '@/application/gateways/model/workspace.model';

@Entity('t_member_invite')
export class MemberInviteModel {
  @PrimaryColumn({
    type: 'varchar',
    length: 36,
  })
  id: string;

  @Column({ name: 'workspace_id', type: 'varchar', length: 255 })
  workspaceId: string;

  @Column({ name: 'member_id', type: 'varchar', length: 255 })
  memberId: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({
    type: 'enum',
    enum: InvitationStatus,
    default: InvitationStatus.PENDING,
  })
  status: InvitationStatus;

  @Column({
    name: 'create_user_cd',
    type: 'varchar',
    length: 255,
    default: 'system',
  })
  createUserCd: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({
    name: 'update_user_cd',
    type: 'varchar',
    length: 255,
    default: 'system',
  })
  updateUserCd: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'delete_flag', type: 'boolean', default: false })
  deleteFlag: boolean;

  @ManyToOne(() => Workspace, (workspace) => workspace.id)
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  @ManyToOne(() => Member, (member) => member.invites)
  @JoinColumn({ name: 'member_id' })
  member: Member;

  toEntity(): MemberInviteEntity {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      memberId: this.memberId,
      email: this.email,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
