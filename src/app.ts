import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { query } from './db/pool';
import { logger } from './lib/logger';
import { MonnifyGateway } from './lib/monnify';
import { authenticate, requireRole } from './middleware/auth';
import { errorHandler, notFoundHandler, wrap } from './middleware/errors';
import { authRouter } from './modules/auth/routes';
import { employeesRouter } from './modules/employees/routes';
import { payrollsRouter } from './modules/payrolls/routes';
import { usersRouter } from './modules/users/routes';
import { PayrollQueue } from './queue/payrollQueue';
import { monnifyWebhookRouter } from './webhooks/monnify';

export interface AppDeps {
  gateway: MonnifyGateway;
  queue: PayrollQueue;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(pinoHttp({ logger }));

  // Before the JSON parser on purpose: this route needs the raw body.
  app.use('/webhooks/monnify', monnifyWebhookRouter());

  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get(
    '/ready',
    wrap(async (_req, res) => {
      await query('SELECT 1');
      res.json({ status: 'ready' });
    }),
  );

  app.use('/api/auth', authRouter());
  app.use('/api/users', usersRouter());
  app.use('/api/employees', employeesRouter());
  app.use('/api/payrolls', payrollsRouter(deps));
  app.get(
    '/api/wallet/balance',
    authenticate,
    requireRole('PAYROLL_MANAGER'),
    wrap(async (_req, res) => res.json({ data: await deps.gateway.getWalletBalance() })),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
