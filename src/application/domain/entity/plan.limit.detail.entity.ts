import { WorkspacePlanType } from '@/application/domain/entity/workspace_plan.entity';
import { InvoiceCategory } from '@/application/domain/entity/invoice.entity';

export type PlanLimitDetailEntity = {
  planType: WorkspacePlanType;
  invoiceCategory: InvoiceCategory;
  price: number;
  stripePlanCode?: string;
};
