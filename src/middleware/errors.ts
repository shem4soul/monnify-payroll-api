import { NextFunction, Request, Response } from 'express';
import { ZodError, ZodTypeAny, z } from 'zod';
import { HttpError, badRequest } from '../lib/errors';
import { logger } from '../lib/logger';

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'Validation failed',
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Route not found' });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed' });
  }
  // Postgres unique violation
  if ((err as { code?: string })?.code === '23505') {
    return res.status(409).json({ error: 'That record already exists' });
  }
  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}

/** Lets async route handlers throw without try/catch in every one. */
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);
