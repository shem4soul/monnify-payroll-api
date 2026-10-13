import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { signToken } from '../src/middleware/auth';

// None of these paths reach the database: they are rejected by middleware first.
const app = createApp({
  gateway: {
    initiateBatch: async () => ({ batchStatus: 'x' }),
    authorizeBatch: async () => {},
    getTransferStatus: async () => 'PENDING',
    getWalletBalance: async () => ({}),
  },
  queue: { enqueueSubmit: async () => {} },
});

const tokenFor = (role: 'ADMIN' | 'PAYROLL_MANAGER' | 'VIEWER') => signToken({ id: '11111111-1111-1111-1111-111111111111', role });

describe('authentication and roles', () => {
  it('requires a token', async () => {
    await request(app).get('/api/employees').expect(401);
    await request(app).get('/api/payrolls').expect(401);
  });

  it('rejects a garbage token', async () => {
    await request(app).get('/api/employees').set('Authorization', 'Bearer nope').expect(401);
  });

  it('stops read-only users from creating employees or running payroll', async () => {
    const viewer = `Bearer ${tokenFor('VIEWER')}`;
    await request(app).post('/api/employees').set('Authorization', viewer).send({}).expect(403);
    await request(app).post('/api/payrolls').set('Authorization', viewer).send({}).expect(403);
    await request(app).post('/api/payrolls/11111111-1111-1111-1111-111111111111/process').set('Authorization', viewer).expect(403);
  });

  it('keeps OTP authorization and user management admin-only', async () => {
    const manager = `Bearer ${tokenFor('PAYROLL_MANAGER')}`;
    await request(app).post('/api/payrolls/11111111-1111-1111-1111-111111111111/authorize').set('Authorization', manager).send({ otp: '123456' }).expect(403);
    await request(app).get('/api/users').set('Authorization', manager).expect(403);
  });

  it('validates input before touching the database', async () => {
    const manager = `Bearer ${tokenFor('PAYROLL_MANAGER')}`;
    const res = await request(app).post('/api/employees').set('Authorization', manager).send({ fullName: 'A' }).expect(400);
    expect(res.body.error).toBe('Validation failed');
    await request(app).post('/api/payrolls').set('Authorization', manager).send({ period: 'October' }).expect(400);
  });

  it('rejects a malformed login body', async () => {
    await request(app).post('/api/auth/login').send({ email: 'not-an-email' }).expect(400);
  });
});

describe('Monnify webhook endpoint', () => {
  const body = JSON.stringify({ eventType: 'SUCCESSFUL_DISBURSEMENT', eventData: { reference: 'PAY-1' } });

  it('rejects requests without a signature', async () => {
    await request(app).post('/webhooks/monnify').set('Content-Type', 'application/json').send(body).expect(401);
  });

  it('rejects a bad signature', async () => {
    await request(app).post('/webhooks/monnify').set('Content-Type', 'application/json').set('monnify-signature', 'deadbeef').send(body).expect(401);
  });

  it('verifies against the raw bytes, not re-serialized JSON', async () => {
    // Same data, different whitespace: a signature over the pretty version must not validate the compact one.
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    const sig = crypto.createHmac('sha512', process.env.MONNIFY_SECRET_KEY!).update(pretty).digest('hex');
    await request(app).post('/webhooks/monnify').set('Content-Type', 'application/json').set('monnify-signature', sig).send(body).expect(401);
  });
});
