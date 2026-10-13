import { describe, expect, it } from 'vitest';
import { derivePayrollStatus } from '../src/modules/payrolls/status';

const c = (pending: number, processing: number, completed: number, failed: number) => ({ pending, processing, completed, failed });

describe('derivePayrollStatus', () => {
  it('is DRAFT when there are no items', () => expect(derivePayrollStatus(c(0, 0, 0, 0))).toBe('DRAFT'));
  it('stays PROCESSING while anything is unresolved', () => {
    expect(derivePayrollStatus(c(0, 1, 9, 0))).toBe('PROCESSING');
    expect(derivePayrollStatus(c(2, 0, 3, 1))).toBe('PROCESSING');
  });
  it('is COMPLETED when every item completed', () => expect(derivePayrollStatus(c(0, 0, 5, 0))).toBe('COMPLETED'));
  it('is FAILED when every item failed', () => expect(derivePayrollStatus(c(0, 0, 0, 5))).toBe('FAILED'));
  it('is PARTIALLY_COMPLETED for a final mix', () => expect(derivePayrollStatus(c(0, 0, 3, 2))).toBe('PARTIALLY_COMPLETED'));
});
