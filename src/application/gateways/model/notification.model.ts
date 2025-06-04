import {
  Column,
  Entity,
  CreateDateColumn,
  PrimaryColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Workspace } from '@/application/gateways/model/workspace.model';
import { NotificationEntity } from '@/application/domain/entity/notification.entity';

@Entity('t_notification')
export class NotificationModel {
  @PrimaryColumn({
    type: 'varchar',
    length: 255,
  })
  id: string;

  @Column({
    type: 'varchar',
    length: 80,
    nullable: false,
  })
  subject: string;

  @Column({
    name: 'notification_type_code',
    type: 'char',
    length: 3,
    nullable: false,
  })
  notificationTypeCode: string;

  @Column({
    type: 'mediumtext',
    nullable: true,
  })
  body: string;

  @Column({
    name: 'workspace_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  workspaceId: string;

  @Column({
    name: 'user_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  userId: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    nullable: false,
  })
  createAt: Date;

  @Column({
    name: 'create_user_cd',
    type: 'varchar',
    length: 255,
    nullable: false,
  })
  createUserCd: string;

  @Column({
    name: 'updated_at',
    type: 'timestamp',
    nullable: false,
  })
  updatedAt: Date;

  @Column({
    name: 'update_user_cd',
    type: 'varchar',
    length: 255,
    nullable: false,
  })
  updateUserCd: string;

  @Column({
    name: 'delete_flag',
    type: 'boolean',
    default: false,
    nullable: false,
  })
  deleteFlag: boolean;

  @ManyToOne(() => Workspace, (workspace) => workspace.id)
  @JoinColumn({ name: 'workspace_id', referencedColumnName: 'id' })
  workspace: Workspace;

  toEntity(isRead?: boolean): NotificationEntity {
    return {
      id: this.id,
      subject: this.subject,
      notificationTypeCode: this.notificationTypeCode,
      body: this.body,
      workspaceId: this.workspaceId,
      userId: this.userId,
      createAt: this.createAt,
      isRead: isRead ?? false,
    };
  }
}
