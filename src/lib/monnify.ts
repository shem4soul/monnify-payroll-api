import crypto from 'node:crypto';
import { getEnv } from '../config/env';
import { koboToNaira } from './money';

export interface BatchTransfer {
  amountKobo: number;
  reference: string;
  accountNumber: string;
  bankCode: string;
  narration: string;
}

export type TransferOutcome = 'SUCCESS' | 'FAILED' | 'PENDING' | 'NOT_FOUND';

/** The only surface the rest of the app depends on, so tests can swap in a fake. */
export interface MonnifyGateway {
  initiateBatch(batchReference: string, transfers: BatchTransfer[]): Promise<{ batchStatus: string }>;
  authorizeBatch(batchReference: string, otp: string): Promise<void>;
  getTransferStatus(reference: string): Promise<TransferOutcome>;
  getWalletBalance(): Promise<unknown>;
}

/**
 * `definite` separates "Monnify clearly said no" (4xx, safe to mark failed)
 * from "we don't know what happened" (timeout, network, 5xx), where money may have moved.
 */
export class MonnifyError extends Error {
  constructor(
    message: string,
    public readonly definite: boolean,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function buildBatchPayload(batchReference: string, transfers: BatchTransfer[], walletAccountNumber: string) {
  return {
    title: 'Payroll batch',
    batchReference,
    narration: 'Payroll disbursement',
    sourceAccountNumber: walletAccountNumber,
    onValidationFailure: 'CONTINUE',
    notificationInterval: 25,
    transactionList: transfers.map((t) => ({
      amount: koboToNaira(t.amountKobo),
      reference: t.reference,
      narration: t.narration,
      destinationBankCode: t.bankCode,
      destinationAccountNumber: t.accountNumber,
      currency: 'NGN',
    })),
  };
}

/**
 * Monnify signs the raw request body with HMAC-SHA512 keyed by your client secret key
 * and sends the hex digest in the `monnify-signature` header.
 */
export function verifyMonnifySignature(rawBody: Buffer | string, signature: string | undefined, secretKey: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface Envelope<T> {
  requestSuccessful: boolean;
  responseMessage?: string;
  responseCode?: string;
  responseBody?: T;
}

const TIMEOUT_MS = 20_000;

export class MonnifyClient implements MonnifyGateway {
  private token: { value: string; expiresAt: number } | null = null;

  private get env() {
    return getEnv();
  }

  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;

    const basic = Buffer.from(`${this.env.MONNIFY_API_KEY}:${this.env.MONNIFY_SECRET_KEY}`).toString('base64');
    const body = await this.send<{ accessToken: string; expiresIn: number }>('POST', '/api/v1/auth/login', {
      headers: { Authorization: `Basic ${basic}` },
    });
    const { accessToken, expiresIn } = body.responseBody ?? ({} as any);
    if (!accessToken) throw new MonnifyError('Monnify login returned no access token', true);

    // Refresh a minute early so a token never expires mid-request.
    this.token = { value: accessToken, expiresAt: Date.now() + Math.max(expiresIn - 60, 30) * 1000 };
    return accessToken;
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { headers?: Record<string, string>; json?: unknown } = {},
  ): Promise<Envelope<T>> {
    let res: Response;
    try {
      res = await fetch(`${this.env.MONNIFY_BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout or network failure: the request may or may not have been processed.
      throw new MonnifyError(`Could not reach Monnify: ${(err as Error).message}`, false);
    }

    const payload = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (res.status >= 500) throw new MonnifyError(payload.responseMessage ?? `Monnify error ${res.status}`, false, res.status);
    if (!res.ok || payload.requestSuccessful === false) {
      throw new MonnifyError(payload.responseMessage ?? `Monnify rejected the request (${res.status})`, true, res.status);
    }
    return payload;
  }

  private async authed<T>(method: 'GET' | 'POST', path: string, json?: unknown): Promise<Envelope<T>> {
    try {
      return await this.send<T>(method, path, { json, headers: { Authorization: `Bearer ${await this.authenticate()}` } });
    } catch (err) {
      if (err instanceof MonnifyError && err.status === 401) {
        this.token = null; // stale token: log in again and retry once
        return this.send<T>(method, path, { json, headers: { Authorization: `Bearer ${await this.authenticate()}` } });
      }
      throw err;
    }
  }

  async initiateBatch(batchReference: string, transfers: BatchTransfer[]) {
    const payload = buildBatchPayload(batchReference, transfers, this.env.MONNIFY_WALLET_ACCOUNT_NUMBER);
    const res = await this.authed<{ batchStatus?: string }>('POST', '/api/v2/disbursements/batch', payload);
    return { batchStatus: res.responseBody?.batchStatus ?? 'UNKNOWN' };
  }

  async authorizeBatch(batchReference: string, otp: string) {
    await this.authed('POST', '/api/v2/disbursements/batch/validate-otp', {
      reference: batchReference,
      authorizationCode: otp,
    });
  }

  async getTransferStatus(reference: string): Promise<TransferOutcome> {
    try {
      const res = await this.authed<{ status?: string }>(
        'GET',
        `/api/v2/disbursements/single/summary?reference=${encodeURIComponent(reference)}`,
      );
      const status = (res.responseBody?.status ?? '').toUpperCase();
      if (status === 'SUCCESS') return 'SUCCESS';
      if (['FAILED', 'REVERSED', 'EXPIRED'].includes(status)) return 'FAILED';
      return 'PENDING';
    } catch (err) {
      if (err instanceof MonnifyError && err.definite && (err.status === 404 || /not found/i.test(err.message))) {
        return 'NOT_FOUND';
      }
      throw err;
    }
  }

  async getWalletBalance() {
    const res = await this.authed(
      'GET',
      `/api/v2/disbursements/wallet-balance?accountNumber=${encodeURIComponent(this.env.MONNIFY_WALLET_ACCOUNT_NUMBER)}`,
    );
    return res.responseBody;
  }
}
