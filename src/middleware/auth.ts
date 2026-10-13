import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getEnv } from '../config/env';
import { forbidden, unauthorized } from '../lib/errors';

export type Role = 'ADMIN' | 'PAYROLL_MANAGER' | 'VIEWER';

export interface AuthUser {
  id: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function signToken(user: AuthUser): string {
  const { JWT_SECRET, JWT_EXPIRES_IN } = getEnv();
  return jwt.sign({ role: user.role }, JWT_SECRET, { subject: user.id, expiresIn: JWT_EXPIRES_IN as any });
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  try {
    const payload = jwt.verify(header.slice(7), getEnv().JWT_SECRET) as jwt.JwtPayload;
    if (!payload.sub || !payload.role) return next(unauthorized('Invalid token'));
    req.user = { id: payload.sub, role: payload.role as Role };
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

/** Use after authenticate(). Admins can do everything a listed role can. */
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === 'ADMIN' || allowed.includes(req.user.role)) return next();
    next(forbidden());
  };
}
