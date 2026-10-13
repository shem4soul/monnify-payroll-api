import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { getEnv } from '../config/env';

export const QUEUE_NAME = 'payroll';

/** What the API needs from the queue; tests provide a fake. */
export interface PayrollQueue {
  enqueueSubmit(payrollId: string): Promise<void>;
}

export function createRedisConnection() {
  // BullMQ requires maxRetriesPerRequest: null for its blocking connections.
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
}

export function createPayrollQueue(): PayrollQueue & { raw: Queue; close(): Promise<void> } {
  const connection = createRedisConnection();
  const raw = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86_400 },
    },
  });
  return {
    raw,
    async enqueueSubmit(payrollId: string) {
      await raw.add('submit', { payrollId });
    },
    async close() {
      await raw.close();
      connection.disconnect();
    },
  };
}
