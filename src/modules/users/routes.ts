import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { audit } from '../../lib/audit';
import { authenticate, requireRole } from '../../middleware/auth';
import { parse, wrap } from '../../middleware/errors';

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(200),
  role: z.enum(['ADMIN', 'PAYROLL_MANAGER', 'VIEWER']),
});

export function usersRouter() {
  const router = Router();
  router.use(authenticate, requireRole()); // admin only: requireRole() with no extra roles

  router.post(
    '/',
    wrap(async (req, res) => {
      const body = parse(createSchema, req.body);
      const hash = await bcrypt.hash(body.password, 12);
      const { rows } = await query(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, is_active, created_at',
        [body.email.toLowerCase(), hash, body.role],
      );
      await audit(req.user!.id, 'user.create', 'user', rows[0].id, { role: body.role });
      res.status(201).json({ data: rows[0] });
    }),
  );

  router.get(
    '/',
    wrap(async (_req, res) => {
      const { rows } = await query('SELECT id, email, role, is_active, created_at FROM users ORDER BY created_at');
      res.json({ data: rows });
    }),
  );

  return router;
}
