import { Pool, PoolClient, QueryResultRow } from 'pg';
import { getEnv } from '../config/env';

export const pool = new Pool({ connectionString: getEnv().DATABASE_URL, max: 10 });

export type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function query<T extends QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool) {
  return db.query<T>(text, params as any[]);
}

/** Runs fn inside a transaction; commits on success, rolls back on any thrown error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
