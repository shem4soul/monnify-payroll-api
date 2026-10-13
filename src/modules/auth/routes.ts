import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../../db/pool';
import { audit } from '../../lib/audit';
import { unauthorized } from '../../lib/errors';
import { Role, signToken } from '../../middleware/auth';
import { parse, wrap } from '../../middleware/errors';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

export function authRouter() {
  const router = Router();

  router.post(
    '/login',
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }),
    wrap(async (req, res) => {
      const { email, password } = parse(loginSchema, req.body);
      const { rows } = await query<{ id: string; password_hash: string; role: Role; is_active: boolean }>(
        'SELECT id, password_hash, role, is_active FROM users WHERE email = $1',
        [email.toLowerCase()],
      );
      const user = rows[0];
      const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok || !user.is_active) throw unauthorized('Invalid email or password');

      await audit(user.id, 'auth.login', 'user', user.id);
      res.json({ token: signToken({ id: user.id, role: user.role }), role: user.role });
    }),
  );

  return router;
}
