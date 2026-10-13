import { Worker } from 'bullmq';
import { pool } from './db/pool';
import { logger } from './lib/logger';
import { MonnifyClient } from './lib/monnify';
import { reconcileStalePayrolls, submitPayroll } from './modules/payrolls/service';
import { QUEUE_NAME, createPayrollQueue, createRedisConnection } from './queue/payrollQueue';

const gateway = new MonnifyClient();
const connection = createRedisConnection();
const queue = createPayrollQueue();

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    switch (job.name) {
      case 'submit':
        return submitPayroll(job.data.payrollId, gateway);
      case 'reconcile-stale':
        return { reconciled: await reconcileStalePayrolls(gateway) };
      default:
        logger.warn({ name: job.name }, 'unknown job');
    }
  },
  { connection, concurrency: 2 },
);

worker.on('failed', (job, err) => logger.error({ jobId: job?.id, name: job?.name, err }, 'job failed'));
worker.on('completed', (job) => logger.info({ jobId: job.id, name: job.name }, 'job completed'));

// Sweep for payrolls stuck in PROCESSING every 10 minutes.
queue.raw
  .upsertJobScheduler('reconcile-stale', { every: 10 * 60 * 1000 }, { name: 'reconcile-stale' })
  .catch((err) => logger.error({ err }, 'could not schedule reconcile sweep'));

logger.info('worker started');

async function shutdown() {
  await worker.close();
  await queue.close();
  connection.disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
