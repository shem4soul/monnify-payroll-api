import { createApp } from './app';
import { getEnv } from './config/env';
import { pool } from './db/pool';
import { logger } from './lib/logger';
import { MonnifyClient } from './lib/monnify';
import { createPayrollQueue } from './queue/payrollQueue';

const env = getEnv();
const queue = createPayrollQueue();
const app = createApp({ gateway: new MonnifyClient(), queue });

const server = app.listen(env.PORT, () => logger.info(`API listening on :${env.PORT} (${env.NODE_ENV})`));

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await queue.close();
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
