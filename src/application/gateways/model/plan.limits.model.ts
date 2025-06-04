import { Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import { WorkspacePlanType } from '@/application/domain/entity/workspace_plan.entity';
import { PlanLimitDetail } from '@/application/gateways/model/plan.limit.detail.model';
import { PlanLimitEntity } from '@/application/domain/entity';

@Entity('m_plan_limits')
export class PlanLimit {
  @PrimaryColumn({
    type: 'enum',
    enum: WorkspacePlanType,
    name: 'plan_type',
  })
  planType: WorkspacePlanType;

  @Column({
    name: 'name',
    type: 'varchar',
    nullable: false,
    length: 80,
    comment: 'プラン名',
  })
  name?: string;

  @Column({
    name: 'max_design_file',
    type: 'int',
    nullable: true,
    comment: '最大設計ファイル数',
  })
  maxDesignFile?: number;

  @Column({
    name: 'max_file_times',
    type: 'int',
    nullable: true,
    comment: 'ファイル最大利用回数',
  })
  maxFileTimes?: number;

  @Column({
    name: 'fixed_unit_price',
    type: 'int',
    nullable: true,
    comment: '固定単価',
  })
  fixedUnitPrice?: number;

  @Column({
    name: 'fixed_year_unit_price',
    type: 'int',
    nullable: false,
    default: 0,
    comment: '年額固定単価',
  })
  fixedYearUnitPrice: number;

  @Column({
    name: 'per_unit_price',
    type: 'int',
    nullable: true,
  })
  perUnitPrice?: number;

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

  @OneToMany(() => PlanLimitDetail, (detail) => detail.planLimit)
  planLimitDetails: PlanLimitDetail[];

  toEntity(): PlanLimitEntity {
    return {
      planType: this.planType,
      name: this.name,
      maxDesignFile: this.maxDesignFile,
      maxFileTimes: this.maxFileTimes,
      details: this.planLimitDetails.map((detail) => detail.toEntity()),
    };
  }
}
