import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Workspace } from '@/application/gateways/model';

@Entity({ name: 'm_application_token' })
export class ApplicationToken {
  @PrimaryColumn({
    name: 'workspace_id',
    type: 'varchar',
    length: 255,
  })
  workspaceId: string;

  @Column({
    name: 'application_key',
    type: 'varchar',
    length: 16,
  })
  applicationKey: string;

  @Column({
    name: 'secret_key',
    type: 'varchar',
    length: 16,
  })
  secretKey: string;

  @Column({
    name: 'create_user_cd',
    default: 'system',
    type: 'varchar',
    length: 255,
    nullable: false,
    foreignKeyConstraintName: 'create_user_cd',
  })
  createUserCd: string;

  @Column({
    name: 'created_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
    nullable: false,
  })
  createdAt: Date;

  @Column({
    name: 'update_user_cd',
    default: 'system',
    type: 'varchar',
    length: 255,
    nullable: false,
    foreignKeyConstraintName: 'update_user_cd',
  })
  updateUserCd: string;

  @Column({
    name: 'updated_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    nullable: false,
  })
  updatedAt: Date;

  @Column({
    name: 'delete_flag',
    default: false,
    nullable: false,
  })
  deleteFlag: boolean;

  @OneToOne(() => Workspace, (workspace) => workspace.applicationToken)
  @JoinColumn({ name: 'workspace_id', referencedColumnName: 'id' })
  workspace: Workspace;
}
