import { PlanLimitDetailEntity } from '@/application/domain/entity/plan.limit.detail.entity';

export type PlanLimitEntity = {
  planType: string;
  name: string;
  maxDesignFile: number;
  maxFileTimes: number;
  details: PlanLimitDetailEntity[];
};
