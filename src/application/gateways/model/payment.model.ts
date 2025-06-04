import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Workspace } from '@/application/gateways/model/workspace.model';
@Entity('t_payment')
export class PaymentModel {
  @PrimaryColumn({
    name: 'workspace_id',
    type: 'varchar',
    length: 255,
  })
  workspaceId: string;
  @PrimaryColumn({
    name: 'payment_method_id',
    type: 'varchar',
    length: 255,
  })
  paymentMethodId: string;

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

  @ManyToOne(() => Workspace, (workspace) => workspace.payment)
  @JoinColumn({ name: 'workspace_id', referencedColumnName: 'id' })
  workspace: Workspace;
}
