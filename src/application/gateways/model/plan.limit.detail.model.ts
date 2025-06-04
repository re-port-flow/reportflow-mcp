import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { PlanLimit } from '@/application/gateways/model/plan.limits.model';
import { WorkspacePlanType } from '@/application/domain/entity/workspace_plan.entity';
import { InvoiceCategory } from '@/application/domain/entity';
import { PlanLimitDetailEntity } from '@/application/domain/entity/plan.limit.detail.entity';

@Entity('m_plan_limit_detail')
export class PlanLimitDetail {
  @PrimaryColumn({
    name: 'plan_type',
    type: 'enum',
    enum: WorkspacePlanType,
    nullable: false,
  })
  planType: WorkspacePlanType; // 実際のenum値に合わせて修正してください

  @PrimaryColumn({
    name: 'invoice_category',
    type: 'enum',
    enum: InvoiceCategory,
    nullable: false,
  })
  invoiceCategory: InvoiceCategory; // 実際のenum値に合わせて修正してください

  @Column({ name: 'price', type: 'int', default: 0 })
  price: number;

  @Column({
    name: 'stripe_plan_code',
    type: 'varchar',
    length: 36,
    nullable: true,
  })
  stripePlanCode: string;

  @Column({
    name: 'create_user_cd',
    default: 'system',
    type: 'varchar',
    length: 255,
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
    name: 'update_user_cd',
    default: 'system',
    type: 'varchar',
    length: 255,
  })
  updateUserCd: string;

  @Column({
    name: 'delete_flag',
    type: 'boolean',
    default: false,
  })
  deleteFlag: boolean;

  @ManyToOne(() => PlanLimit, (planLimit) => planLimit.planLimitDetails)
  @JoinColumn({ name: 'plan_type', referencedColumnName: 'planType' })
  planLimit: PlanLimit;
  toEntity(): PlanLimitDetailEntity {
    return {
      planType: this.planType,
      invoiceCategory: this.invoiceCategory,
      price: this.price,
      stripePlanCode: this.stripePlanCode,
    };
  }
}
