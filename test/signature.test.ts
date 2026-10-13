import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMonnifySignature } from '../src/lib/monnify';

const secret = 'client-secret';
const body = JSON.stringify({ eventType: 'SUCCESSFUL_DISBURSEMENT', eventData: { reference: 'PAY-1' } });
const sign = (b: string, s = secret) => crypto.createHmac('sha512', s).update(b).digest('hex');

describe('verifyMonnifySignature', () => {
  it('accepts a correctly signed body', () => {
    expect(verifyMonnifySignature(Buffer.from(body), sign(body), secret)).toBe(true);
  });

  it('rejects a body changed after signing', () => {
    const tampered = body.replace('PAY-1', 'PAY-2');
    expect(verifyMonnifySignature(Buffer.from(tampered), sign(body), secret)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyMonnifySignature(Buffer.from(body), sign(body, 'other-secret'), secret)).toBe(false);
  });

  it('rejects missing or wrong-length signatures without throwing', () => {
    expect(verifyMonnifySignature(Buffer.from(body), undefined, secret)).toBe(false);
    expect(verifyMonnifySignature(Buffer.from(body), 'abc', secret)).toBe(false);
  });

  it('is case-insensitive about the hex digest', () => {
    expect(verifyMonnifySignature(Buffer.from(body), sign(body).toUpperCase(), secret)).toBe(true);
  });
});
