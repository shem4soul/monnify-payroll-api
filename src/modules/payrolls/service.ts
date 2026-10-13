import crypto from 'node:crypto';
import { PoolClient } from 'pg';
import { Queryable, query, withTransaction } from '../../db/pool';
import { audit } from '../../lib/audit';
import { HttpError, badRequest, conflict, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { koboToNaira } from '../../lib/money';
import { BatchTransfer, MonnifyError, MonnifyGateway } from '../../lib/monnify';
import { PayrollQueue } from '../../queue/payrollQueue';
import { ItemCounts, ItemStatus, PayrollStatus, derivePayrollStatus } from './status';

interface PayrollRow {
  id: string;
  period: string;
  status: PayrollStatus;
  employee_count: number;
  total_kobo: string;
  current_batch_reference: string | null;
  created_at: Date;
}

const presentPayroll = (p: PayrollRow) => ({
  id: p.id,
  period: p.period,
  status: p.status,
  employeeCount: p.employee_count,
  total: koboToNaira(Number(p.total_kobo)),
  currentBatchReference: p.current_batch_reference,
  createdAt: p.created_at,
});

export async function countItems(payrollId: string, db?: Queryable): Promise<ItemCounts> {
  const { rows } = await query<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')    AS pending,
            count(*) FILTER (WHERE status = 'PROCESSING') AS processing,
            count(*) FILTER (WHERE status = 'COMPLETED')  AS completed,
            count(*) FILTER (WHERE status = 'FAILED')     AS failed
       FROM payroll_items WHERE payroll_id = $1`,
    [payrollId],
    db,
  );
  const r = rows[0]!;
  return { pending: Number(r.pending), processing: Number(r.processing), completed: Number(r.completed), failed: Number(r.failed) };
}

/** Takes a row lock on the payroll until the surrounding transaction ends. */
async function lockPayroll(payrollId: string, db: Queryable) {
  await query('SELECT 1 FROM payrolls WHERE id = $1 FOR UPDATE', [payrollId], db);
}

/**
 * Recomputes the payroll's status from its items.
 * The payroll row is locked first: without it, two webhooks landing together each count items before the
 * other has committed, and the payroll can be left in a stale status even though every item is final.
 */
export async function syncPayrollStatus(payrollId: string, db?: Queryable): Promise<PayrollStatus> {
  if (!db) return withTransaction((tx) => syncPayrollStatus(payrollId, tx));
  await lockPayroll(payrollId, db);
  const status = derivePayrollStatus(await countItems(payrollId, db));
  await query('UPDATE payrolls SET status = $2, updated_at = now() WHERE id = $1', [payrollId, status], db);
  return status;
}

export async function createPayroll(actorId: string, period: string, employeeIds?: string[]) {
  return withTransaction(async (tx) => {
    const filter = employeeIds?.length ? 'AND id = ANY($1::uuid[])' : '';
    const params = employeeIds?.length ? [employeeIds] : [];

    const totals = await query<{ n: string; total: string }>(
      `SELECT count(*) AS n, COALESCE(sum(salary_kobo), 0) AS total FROM employees WHERE is_active = TRUE ${filter}`,
      params,
      tx,
    );
    const count = Number(totals.rows[0]!.n);
    if (count === 0) throw badRequest('No active employees match this payroll');
    if (employeeIds?.length && count !== new Set(employeeIds).size) {
      throw badRequest('Some employee ids are unknown or inactive');
    }

    const payroll = await query<PayrollRow>(
      `INSERT INTO payrolls (period, employee_count, total_kobo, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [period, count, totals.rows[0]!.total, actorId],
      tx,
    ).catch((err) => {
      if (err?.code === '23505') throw conflict(`A payroll for ${period} already exists`);
      throw err;
    });
    const id = payroll.rows[0]!.id;

    // One statement for all items. The payment reference is unique per item and attempt.
    await query(
      `WITH picked AS (SELECT gen_random_uuid() AS item_id, id AS employee_id, salary_kobo
                         FROM employees WHERE is_active = TRUE ${filter})
       INSERT INTO payroll_items (id, payroll_id, employee_id, amount_kobo, payment_reference)
       SELECT item_id, $${params.length + 1}, employee_id, salary_kobo,
              'PAY-' || replace(item_id::text, '-', '') || '-1'
         FROM picked`,
      [...params, id],
      tx,
    );

    await audit(actorId, 'payroll.create', 'payroll', id, { period, employees: count }, tx);
    return presentPayroll(payroll.rows[0]!);
  });
}

export async function listPayrolls() {
  const { rows } = await query<PayrollRow>('SELECT * FROM payrolls ORDER BY created_at DESC LIMIT 200');
  return rows.map(presentPayroll);
}

export async function getPayroll(id: string) {
  const { rows } = await query<PayrollRow>('SELECT * FROM payrolls WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Payroll not found');

  const items = await query<{
    id: string;
    employee_code: string;
    full_name: string;
    amount_kobo: string;
    status: ItemStatus;
    payment_reference: string;
    failure_reason: string | null;
  }>(
    `SELECT i.id, e.employee_code, e.full_name, i.amount_kobo, i.status, i.payment_reference, i.failure_reason
       FROM payroll_items i JOIN employees e ON e.id = i.employee_id
      WHERE i.payroll_id = $1 ORDER BY e.employee_code`,
    [id],
  );

  return {
    ...presentPayroll(rows[0]),
    summary: await countItems(id),
    items: items.rows.map((i) => ({
      id: i.id,
      employeeCode: i.employee_code,
      fullName: i.full_name,
      amount: koboToNaira(Number(i.amount_kobo)),
      status: i.status,
      paymentReference: i.payment_reference,
      failureReason: i.failure_reason,
    })),
  };
}

/** DRAFT -> QUEUED is a single conditional UPDATE, so two clicks can't queue the same payroll twice. */
export async function queueForProcessing(id: string, actorId: string, queue: PayrollQueue) {
  const { rows } = await query<{ id: string }>(
    `UPDATE payrolls SET status = 'QUEUED', updated_at = now() WHERE id = $1 AND status = 'DRAFT' RETURNING id`,
    [id],
  );
  if (!rows[0]) {
    const current = await query<{ status: string }>('SELECT status FROM payrolls WHERE id = $1', [id]);
    if (!current.rows[0]) throw notFound('Payroll not found');
    throw conflict(`Payroll is ${current.rows[0].status}; only DRAFT payrolls can be processed`);
  }
  try {
    await queue.enqueueSubmit(id);
  } catch (err) {
    await query(`UPDATE payrolls SET status = 'DRAFT', updated_at = now() WHERE id = $1`, [id]);
    throw new HttpError(503, 'Could not queue the payroll, please try again');
  }
  await audit(actorId, 'payroll.process', 'payroll', id);
}

/** Gives FAILED items a fresh payment reference (Monnify won't accept a reused one) and queues them again. */
export async function retryFailed(id: string, actorId: string, queue: PayrollQueue) {
  const retried = await withTransaction(async (tx) => {
    const p = await query<{ status: PayrollStatus }>('SELECT status FROM payrolls WHERE id = $1 FOR UPDATE', [id], tx);
    if (!p.rows[0]) throw notFound('Payroll not found');
    if (p.rows[0].status !== 'FAILED' && p.rows[0].status !== 'PARTIALLY_COMPLETED') {
      throw conflict(`Payroll is ${p.rows[0].status}; only FAILED or PARTIALLY_COMPLETED payrolls can be retried`);
    }
    const res = await query(
      `UPDATE payroll_items
          SET status = 'PENDING', attempt = attempt + 1, batch_reference = NULL, failure_reason = NULL, updated_at = now(),
              payment_reference = 'PAY-' || replace(id::text, '-', '') || '-' || (attempt + 1)
        WHERE payroll_id = $1 AND status = 'FAILED'`,
      [id],
      tx,
    );
    await query(`UPDATE payrolls SET status = 'QUEUED', updated_at = now() WHERE id = $1`, [id], tx).catch((err) => {
      if (err?.code === '23505') throw conflict('Another payroll for this period is already live');
      throw err;
    });
    return res.rowCount ?? 0;
  });
  await queue.enqueueSubmit(id);
  await audit(actorId, 'payroll.retry_failed', 'payroll', id, { items: retried });
  return { retried };
}

/** Called by the worker. Claims PENDING items atomically, then submits them to Monnify as one batch. */
export async function submitPayroll(payrollId: string, gateway: MonnifyGateway) {
  const batchReference = `BATCH-${payrollId.replace(/-/g, '').slice(0, 12)}-${Date.now()}`;

  const claimed = await withTransaction(async (tx) => {
    const res = await query(
      `UPDATE payroll_items SET status = 'PROCESSING', batch_reference = $2, updated_at = now()
        WHERE payroll_id = $1 AND status = 'PENDING'`,
      [payrollId, batchReference],
      tx,
    );
    if (!res.rowCount) return 0;
    await query(
      `UPDATE payrolls SET status = 'PROCESSING', current_batch_reference = $2, updated_at = now() WHERE id = $1`,
      [payrollId, batchReference],
      tx,
    );
    return res.rowCount;
  });
  if (!claimed) {
    logger.info({ payrollId }, 'nothing to submit');
    return { submitted: 0 };
  }

  const { rows } = await query<{ payment_reference: string; amount_kobo: string; account_number: string; bank_code: string }>(
    `SELECT i.payment_reference, i.amount_kobo, e.account_number, e.bank_code
       FROM payroll_items i JOIN employees e ON e.id = i.employee_id
      WHERE i.payroll_id = $1 AND i.batch_reference = $2`,
    [payrollId, batchReference],
  );
  const transfers: BatchTransfer[] = rows.map((r) => ({
    amountKobo: Number(r.amount_kobo),
    reference: r.payment_reference,
    accountNumber: r.account_number,
    bankCode: r.bank_code,
    narration: 'Salary payment',
  }));

  try {
    const { batchStatus } = await gateway.initiateBatch(batchReference, transfers);
    const awaiting = /PENDING_AUTHORI[SZ]ATION|AWAITING/i.test(batchStatus);
    await query(`UPDATE payrolls SET status = $2, updated_at = now() WHERE id = $1`, [
      payrollId,
      awaiting ? PayrollStatus.AWAITING_AUTHORIZATION : PayrollStatus.PROCESSING,
    ]);
    await audit(null, 'payroll.batch_submitted', 'payroll', payrollId, { batchReference, batchStatus, items: transfers.length });
    return { submitted: transfers.length, batchReference, batchStatus };
  } catch (err) {
    if (err instanceof MonnifyError && err.definite) {
      // Monnify clearly refused the batch, so nothing moved and it is safe to mark these failed.
      await query(
        `UPDATE payroll_items SET status = 'FAILED', failure_reason = $3, updated_at = now()
          WHERE payroll_id = $1 AND batch_reference = $2 AND status = 'PROCESSING'`,
        [payrollId, batchReference, err.message.slice(0, 500)],
      );
      await syncPayrollStatus(payrollId);
      await audit(null, 'payroll.batch_rejected', 'payroll', payrollId, { batchReference, reason: err.message });
      return { submitted: 0, rejected: true };
    }
    // We don't know whether Monnify received it. Leave the items PROCESSING and let reconciliation
    // ask Monnify, rather than retrying blindly and risking a double payment.
    logger.error({ err, payrollId, batchReference }, 'batch submission outcome unknown; reconcile before retrying');
    await audit(null, 'payroll.batch_unknown', 'payroll', payrollId, { batchReference });
    return { submitted: transfers.length, unknownOutcome: true };
  }
}

export async function authorizePayroll(id: string, otp: string, actorId: string, gateway: MonnifyGateway) {
  const { rows } = await query<{ status: PayrollStatus; current_batch_reference: string | null }>(
    'SELECT status, current_batch_reference FROM payrolls WHERE id = $1',
    [id],
  );
  const p = rows[0];
  if (!p) throw notFound('Payroll not found');
  if (p.status !== 'AWAITING_AUTHORIZATION' || !p.current_batch_reference) {
    throw conflict(`Payroll is ${p.status}; it is not waiting for an OTP`);
  }
  try {
    await gateway.authorizeBatch(p.current_batch_reference, otp);
  } catch (err) {
    if (err instanceof MonnifyError && err.definite) throw badRequest(err.message);
    throw new HttpError(502, 'Could not confirm with Monnify, check the batch status before retrying');
  }
  await query(`UPDATE payrolls SET status = 'PROCESSING', updated_at = now() WHERE id = $1`, [id]);
  await audit(actorId, 'payroll.authorize', 'payroll', id, { batchReference: p.current_batch_reference });
}

/**
 * Asks Monnify about every item still PROCESSING. This is the safety net for lost or late webhooks
 * and for batch submissions whose outcome was unknown.
 */
export async function reconcilePayroll(id: string, gateway: MonnifyGateway) {
  const p = await query<{ status: PayrollStatus }>('SELECT status FROM payrolls WHERE id = $1', [id]);
  if (!p.rows[0]) throw notFound('Payroll not found');
  if (p.rows[0].status !== 'PROCESSING') throw conflict(`Payroll is ${p.rows[0].status}; only PROCESSING payrolls are reconciled`);

  const { rows } = await query<{ id: string; payment_reference: string }>(
    `SELECT id, payment_reference FROM payroll_items WHERE payroll_id = $1 AND status = 'PROCESSING'`,
    [id],
  );
  const result = { checked: rows.length, completed: 0, failed: 0, resetToPending: 0, stillPending: 0, errors: 0 };

  for (const item of rows) {
    try {
      const outcome = await gateway.getTransferStatus(item.payment_reference);
      if (outcome === 'SUCCESS') {
        await query(`UPDATE payroll_items SET status = 'COMPLETED', failure_reason = NULL, updated_at = now() WHERE id = $1`, [item.id]);
        result.completed++;
      } else if (outcome === 'FAILED') {
        await query(
          `UPDATE payroll_items SET status = 'FAILED', failure_reason = 'Monnify reported the transfer as failed', updated_at = now() WHERE id = $1`,
          [item.id],
        );
        result.failed++;
      } else if (outcome === 'NOT_FOUND') {
        // Monnify has no record, so it never received this item and it is safe to submit again.
        await query(`UPDATE payroll_items SET status = 'PENDING', batch_reference = NULL, updated_at = now() WHERE id = $1`, [item.id]);
        result.resetToPending++;
      } else {
        result.stillPending++;
      }
    } catch (err) {
      result.errors++;
      logger.warn({ err, itemId: item.id }, 'reconcile lookup failed');
    }
  }

  await withTransaction(async (tx) => {
    await lockPayroll(id, tx);
    const counts = await countItems(id, tx);
    if (counts.pending > 0 && counts.processing === 0) {
      // Nothing is in flight any more; return to DRAFT so the remaining items can be submitted again.
      await query(`UPDATE payrolls SET status = 'DRAFT', updated_at = now() WHERE id = $1`, [id], tx);
    } else {
      await syncPayrollStatus(id, tx);
    }
  });
  return result;
}

/** Scheduled sweep: reconcile payrolls that have sat in PROCESSING for a while. */
export async function reconcileStalePayrolls(gateway: MonnifyGateway, olderThanMinutes = 15) {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM payrolls WHERE status = 'PROCESSING' AND updated_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  for (const p of rows) {
    try {
      await reconcilePayroll(p.id, gateway);
    } catch (err) {
      logger.warn({ err, payrollId: p.id }, 'stale reconcile failed');
    }
  }
  return rows.length;
}

const EVENT_OUTCOMES: Record<string, 'COMPLETED' | 'FAILED'> = {
  SUCCESSFUL_DISBURSEMENT: 'COMPLETED',
  FAILED_DISBURSEMENT: 'FAILED',
  REVERSED_DISBURSEMENT: 'FAILED',
};

/** Applies one verified Monnify disbursement event. Safe to call twice with the same body. */
export async function applyDisbursementEvent(event: any, rawBody: Buffer) {
  const target = EVENT_OUTCOMES[event?.eventType];
  const reference: unknown = event?.eventData?.reference;
  if (!target || typeof reference !== 'string') return 'ignored';

  const eventKey = crypto.createHash('sha256').update(rawBody).digest('hex');

  return withTransaction(async (tx: PoolClient) => {
    const fresh = await query(
      `INSERT INTO webhook_events (event_key, event_type, payload) VALUES ($1, $2, $3)
       ON CONFLICT (event_key) DO NOTHING RETURNING event_key`,
      [eventKey, event.eventType, JSON.stringify(event)],
      tx,
    );
    if (!fresh.rowCount) return 'duplicate';

    // Lock order is payroll, then item, everywhere in this file, so concurrent flows can't deadlock.
    const owner = await query<{ payroll_id: string }>('SELECT payroll_id FROM payroll_items WHERE payment_reference = $1', [reference], tx);
    if (!owner.rows[0]) {
      logger.warn({ reference }, 'webhook for unknown payment reference');
      return 'unknown_reference';
    }
    await lockPayroll(owner.rows[0].payroll_id, tx);
    const found = await query<{ id: string; payroll_id: string; status: ItemStatus }>(
      'SELECT id, payroll_id, status FROM payroll_items WHERE payment_reference = $1 FOR UPDATE',
      [reference],
      tx,
    );
    const item = found.rows[0]!;
    if (item.status === target) return 'no_change';

    const reason =
      target === 'FAILED'
        ? String(event.eventData.transactionDescription ?? event.eventData.paymentDescription ?? event.eventType).slice(0, 500)
        : null;
    await query(
      'UPDATE payroll_items SET status = $2, failure_reason = $3, updated_at = now() WHERE id = $1',
      [item.id, target, reason],
      tx,
    );
    await syncPayrollStatus(item.payroll_id, tx);
    await audit(null, `webhook.${event.eventType.toLowerCase()}`, 'payroll_item', item.id, { reference }, tx);
    return 'applied';
  });
}
