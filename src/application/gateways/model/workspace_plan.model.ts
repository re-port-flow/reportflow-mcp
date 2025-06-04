import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { PlanLimit } from '@/application/gateways/model/plan.limits.model';
import {
  PaymentType,
  WorkspacePlanEntity,
  WorkspacePlanType,
} from '@/application/domain/entity/workspace_plan.entity';
import { Workspace } from '@/application/gateways/model/workspace.model';

@Entity('t_workspace_plan')
export class WorkspacePlan {
  @PrimaryColumn({
    name: 'id',
    type: 'varchar',
    length: 255,
  })
  id: string;

  @Column({
    name: 'workspace_id',
    type: 'varchar',
    length: 255,
  })
  workspaceId: string;

  @Column({
    name: 'plan_type',
    type: 'enum',
    enum: WorkspacePlanType,
  })
  planType: WorkspacePlanType;

  @Column({
    name: 'start_date',
    type: 'date',
    nullable: false,
  })
  startDate: Date;

  @Column({
    name: 'end_date',
    type: 'date',
    nullable: true,
  })
  endDate: Date;

  @Column({
    name: 'payment_type',
    type: 'enum',
    enum: PaymentType,
  })
  paymentType: PaymentType;

  @Column({
    name: 'metered_fixed_price',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  meteredFixedPrice?: string;

  @Column({
    name: 'metered_usage_price',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  meteredUsagePrice?: string;

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

  @ManyToOne(() => Workspace, (workspace) => workspace.id)
  @JoinColumn({ name: 'workspace_id', referencedColumnName: 'id' })
  workspace: Workspace;

  @ManyToOne(() => PlanLimit)
  @JoinColumn({ name: 'plan_type', referencedColumnName: 'planType' })
  planLimit: PlanLimit;
  toEntity(): WorkspacePlanEntity {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      planType: this.planType,
      startDate: this.startDate,
      endDate: this.endDate,
      paymentType: this.paymentType,
      meteredUsagePrice: this.meteredUsagePrice,
      meteredFixedPrice: this.meteredFixedPrice,
    };
  }
}
