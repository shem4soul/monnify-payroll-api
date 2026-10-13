import bcrypt from 'bcryptjs';
import { getEnv } from '../config/env';
import { pool } from './pool';

async function main() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = getEnv();
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ chars) first');

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const res = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'ADMIN')
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [ADMIN_EMAIL.toLowerCase(), hash],
  );
  console.log(res.rowCount ? `admin created: ${ADMIN_EMAIL}` : `admin already exists: ${ADMIN_EMAIL}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
