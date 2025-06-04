import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('m_mail_send_grid_template')
export class MailSendGridTemplateModel {
  @PrimaryColumn({ name: 'mail_type', type: 'char', length: 3 })
  mailType: string;

  @Column({ name: 'send_grid_template_id', type: 'varchar', length: 36 })
  sendGridTemplateId: string;

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
}
