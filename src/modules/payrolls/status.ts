export const ItemStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

export const PayrollStatus = {
  DRAFT: 'DRAFT',
  QUEUED: 'QUEUED',
  AWAITING_AUTHORIZATION: 'AWAITING_AUTHORIZATION',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
  FAILED: 'FAILED',
} as const;
export type PayrollStatus = (typeof PayrollStatus)[keyof typeof PayrollStatus];

export interface ItemCounts {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

/**
 * Payroll status is always derived from its items, never set by hand once payments are moving.
 * Anything unresolved keeps the payroll in PROCESSING; once every item is final the outcome is decided.
 */
export function derivePayrollStatus(c: ItemCounts): PayrollStatus {
  const total = c.pending + c.processing + c.completed + c.failed;
  if (total === 0) return PayrollStatus.DRAFT;
  if (c.pending + c.processing > 0) return PayrollStatus.PROCESSING;
  if (c.completed === total) return PayrollStatus.COMPLETED;
  if (c.failed === total) return PayrollStatus.FAILED;
  return PayrollStatus.PARTIALLY_COMPLETED;
}
