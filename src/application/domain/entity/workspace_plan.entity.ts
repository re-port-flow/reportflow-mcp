export enum WorkspacePlanType {
  FREE = '01',
  STANDARD = '02',
  PREMIUM = '03',
  ENTERPRISE = '04',
}

export enum PaymentType {
  MONTHLY = '01',
  ANNUAL = '02',
}

export type WorkspacePlanEntity = {
  id: string;
  workspaceId: string;
  planType: WorkspacePlanType;
  startDate: Date;
  endDate: Date;
  paymentType: PaymentType;
  meteredUsagePrice?: string;
  meteredFixedPrice?: string;
};
export interface RateLimitDetails {
  limit: number;
  remaining: number;
}
