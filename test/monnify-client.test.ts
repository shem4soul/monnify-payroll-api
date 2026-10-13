import { describe, expect, it } from 'vitest';
import { buildBatchPayload } from '../src/lib/monnify';
import { koboToNaira, nairaToKobo } from '../src/lib/money';

describe('buildBatchPayload', () => {
  const payload = buildBatchPayload(
    'BATCH-1',
    [{ amountKobo: 5_000_050, reference: 'PAY-1', accountNumber: '0123456789', bankCode: '058', narration: 'Salary payment' }],
    '9999999999',
  );

  it('converts kobo to naira and maps bank fields', () => {
    expect(payload.transactionList[0]).toMatchObject({
      amount: 50000.5,
      reference: 'PAY-1',
      destinationAccountNumber: '0123456789',
      destinationBankCode: '058',
      currency: 'NGN',
    });
  });

  it('funds the batch from the wallet account and continues past invalid accounts', () => {
    expect(payload.sourceAccountNumber).toBe('9999999999');
    expect(payload.onValidationFailure).toBe('CONTINUE');
    expect(payload.batchReference).toBe('BATCH-1');
  });
});

describe('money helpers', () => {
  it('round-trips amounts without floating point drift', () => {
    expect(nairaToKobo(19.99)).toBe(1999);
    expect(nairaToKobo(0.1 + 0.2)).toBe(30);
    expect(koboToNaira(1999)).toBe(19.99);
  });
});
