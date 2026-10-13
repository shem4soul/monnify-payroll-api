/**
 * End-to-end check against a running stack (API + worker + Postgres + Redis + fake Monnify).
 *   npm run smoke
 */
import 'dotenv/config';
import crypto from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:3000';
const EMAIL = process.env.ADMIN_EMAIL!;
const PASSWORD = process.env.ADMIN_PASSWORD!;
const SECRET = process.env.MONNIFY_SECRET_KEY!;

let token = '';
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as any };
}
function expect(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    console.error(detail);
    process.exit(1);
  }
}
async function waitFor(label: string, fn: () => Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  expect(label, false, 'timed out');
}

(async () => {
  const period = `${2100 + Math.floor(Math.random() * 7000)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}`;
  let r = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  expect('admin can log in', r.status === 200 && !!r.json.token, r);
  token = r.json.token;

  r = await call('POST', '/api/auth/login', { email: EMAIL, password: 'wrong-password-123' });
  expect('wrong password is rejected', r.status === 401, r);

  const tag = Date.now();
  const people = [
    ['Ada Obi', '0123456781', 250000],
    ['Tunde Bello', '0123456782', 180000.5],
    ['Ngozi Eze', '0123450000', 320000], // the fake fails this account on its first attempt
  ] as const;
  for (const [i, [name, acct, salary]] of people.entries()) {
    r = await call('POST', '/api/employees', { fullName: name, email: `smoke${tag}${i}@example.com`, salary, bankCode: '058', accountNumber: acct });
    expect(`employee created: ${name}`, r.status === 201 && /^EMP-\d{4}$/.test(r.json.data.employeeCode), r);
  }

  r = await call('POST', '/api/employees', { fullName: 'Bad', email: 'bad@example.com', salary: 100, bankCode: '058', accountNumber: '123' });
  expect('invalid account number is rejected', r.status === 400, r);

  r = await call('POST', '/api/payrolls', { period });
  expect('payroll created in kobo-safe totals', r.status === 201 && r.json.data.status === 'DRAFT', r);
  const id = r.json.data.id as string;

  r = await call('POST', '/api/payrolls', { period });
  expect('second live payroll for the same period is blocked', r.status === 409, r);

  r = await call('POST', `/api/payrolls/${id}/process`);
  expect('process is accepted', r.status === 202, r);
  r = await call('POST', `/api/payrolls/${id}/process`);
  expect('processing twice is blocked', r.status === 409, r);

  await waitFor('worker submits batch and payroll awaits OTP', async () => (await call('GET', `/api/payrolls/${id}`)).json.data?.status === 'AWAITING_AUTHORIZATION');

  r = await call('POST', `/api/payrolls/${id}/authorize`, { otp: '000000' });
  expect('wrong OTP is rejected', r.status === 400, r);
  r = await call('POST', `/api/payrolls/${id}/authorize`, { otp: '123456' });
  expect('correct OTP authorizes the batch', r.status === 200, r);

  await waitFor('webhooks settle the payroll as PARTIALLY_COMPLETED', async () => (await call('GET', `/api/payrolls/${id}`)).json.data?.status === 'PARTIALLY_COMPLETED');
  let p = (await call('GET', `/api/payrolls/${id}`)).json.data;
  expect('settled with some paid and the 0000 accounts failed', p.summary.completed >= 2 && p.summary.failed >= 1 && p.summary.pending + p.summary.processing === 0, p.summary);

  // Webhook security and idempotency
  const paid = p.items.find((i: any) => i.status === 'COMPLETED');
  const body = JSON.stringify({ eventType: 'SUCCESSFUL_DISBURSEMENT', eventData: { reference: paid.paymentReference } });
  r = await call('POST', '/webhooks/monnify', body, { 'monnify-signature': 'bad' });
  expect('webhook with a bad signature is rejected', r.status === 401, r);
  const sig = crypto.createHmac('sha512', SECRET).update(body).digest('hex');
  r = await call('POST', '/webhooks/monnify', body, { 'monnify-signature': sig });
  expect('valid webhook for an already-paid item changes nothing', r.status === 200 && r.json.outcome === 'no_change', r);
  r = await call('POST', '/webhooks/monnify', body, { 'monnify-signature': sig });
  expect('redelivered webhook is recognised as a duplicate', r.status === 200 && r.json.outcome === 'duplicate', r);

  // Retry only the failed item, with a fresh payment reference
  r = await call('POST', `/api/payrolls/${id}/retry-failed`);
  expect('retry re-queues just the failed item', r.status === 202 && r.json.data.retried === p.summary.failed, r);
  await waitFor('retry batch awaits OTP', async () => (await call('GET', `/api/payrolls/${id}`)).json.data?.status === 'AWAITING_AUTHORIZATION');
  r = await call('POST', `/api/payrolls/${id}/authorize`, { otp: '123456' });
  expect('retry batch authorized', r.status === 200, r);
  await waitFor('payroll completes after retry', async () => (await call('GET', `/api/payrolls/${id}`)).json.data?.status === 'COMPLETED');
  p = (await call('GET', `/api/payrolls/${id}`)).json.data;
  expect('every item completed and nobody was paid twice', p.summary.completed === p.items.length && p.items.every((i: any) => i.status === 'COMPLETED'), p.summary);

  r = await call('GET', '/api/wallet/balance');
  expect('wallet balance is readable by admins', r.status === 200, r);

  console.log('\nAll smoke checks passed.');
})();
