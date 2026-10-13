/**
 * A tiny stand-in for Monnify so you can run the whole payroll flow locally without sandbox credentials.
 *
 *   MONNIFY_BASE_URL=http://localhost:4010 in your .env, then: npm run fake-monnify
 *
 * It accepts batches, wants OTP 123456, then sends signed webhooks back to the API.
 * Accounts ending in 0000 fail on their first attempt and succeed on a retry, which lets you try the retry path.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.FAKE_MONNIFY_PORT ?? 4010);
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? 'http://localhost:3000/webhooks/monnify';
const SECRET = process.env.MONNIFY_SECRET_KEY ?? '';

interface Txn { reference: string; destinationAccountNumber: string }
const batches = new Map<string, Txn[]>();
const results = new Map<string, 'SUCCESS' | 'FAILED'>();

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const ok = (responseBody: unknown) => ({ requestSuccessful: true, responseMessage: 'success', responseCode: '0', responseBody });

async function deliver(txn: Txn) {
  const shouldFail = txn.destinationAccountNumber.endsWith('0000') && txn.reference.endsWith('-1');
  results.set(txn.reference, shouldFail ? 'FAILED' : 'SUCCESS');
  const body = JSON.stringify({
    eventType: shouldFail ? 'FAILED_DISBURSEMENT' : 'SUCCESSFUL_DISBURSEMENT',
    eventData: { reference: txn.reference, status: shouldFail ? 'FAILED' : 'SUCCESS', transactionDescription: shouldFail ? 'Account could not be validated' : 'Salary payment' },
  });
  const signature = crypto.createHmac('sha512', SECRET).update(body).digest('hex');
  await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'monnify-signature': signature }, body })
    .catch((e) => console.error('webhook delivery failed:', e.message));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (url.pathname === '/api/v1/auth/login') return send(res, 200, ok({ accessToken: 'fake-token', expiresIn: 3600 }));
      if (url.pathname === '/api/v2/disbursements/batch') {
        batches.set(body.batchReference, body.transactionList);
        return send(res, 200, ok({ batchReference: body.batchReference, batchStatus: 'PENDING_AUTHORIZATION', totalTransactionsCount: body.transactionList.length }));
      }
      if (url.pathname === '/api/v2/disbursements/batch/validate-otp') {
        const txns = batches.get(body.reference);
        if (!txns) return send(res, 404, { requestSuccessful: false, responseMessage: 'Batch not found' });
        if (body.authorizationCode !== '123456') return send(res, 400, { requestSuccessful: false, responseMessage: 'Invalid OTP' });
        send(res, 200, ok({ batchStatus: 'AUTHORIZED' }));
        setTimeout(() => txns.forEach((t) => void deliver(t)), 300);
        return;
      }
      if (url.pathname === '/api/v2/disbursements/single/summary') {
        const status = results.get(url.searchParams.get('reference') ?? '');
        return status ? send(res, 200, ok({ status })) : send(res, 404, { requestSuccessful: false, responseMessage: 'Transaction not found' });
      }
      if (url.pathname === '/api/v2/disbursements/wallet-balance') return send(res, 200, ok({ availableBalance: 50_000_000 }));
      send(res, 404, { requestSuccessful: false, responseMessage: 'Unknown fake endpoint' });
    });
  })
  .listen(PORT, () => console.log(`fake Monnify listening on :${PORT}, OTP is 123456`));
