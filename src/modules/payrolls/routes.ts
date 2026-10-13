import { Router } from 'express';
import { z } from 'zod';
import { MonnifyGateway } from '../../lib/monnify';
import { authenticate, requireRole } from '../../middleware/auth';
import { parse, wrap } from '../../middleware/errors';
import { PayrollQueue } from '../../queue/payrollQueue';
import * as service from './service';

const idParam = z.object({ id: z.string().uuid() });
const createSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM, for example 2026-10'),
  employeeIds: z.array(z.string().uuid()).max(5000).optional(),
});
const otpSchema = z.object({ otp: z.string().regex(/^\d{4,10}$/, 'OTP must be 4 to 10 digits') });

export function payrollsRouter(deps: { gateway: MonnifyGateway; queue: PayrollQueue }) {
  const router = Router();
  const manager = requireRole('PAYROLL_MANAGER');
  const adminOnly = requireRole(); // ADMIN always passes; no other role listed
  router.use(authenticate);

  router.post(
    '/',
    manager,
    wrap(async (req, res) => {
      const { period, employeeIds } = parse(createSchema, req.body);
      res.status(201).json({ data: await service.createPayroll(req.user!.id, period, employeeIds) });
    }),
  );

  router.get('/', wrap(async (_req, res) => res.json({ data: await service.listPayrolls() })));

  router.get(
    '/:id',
    wrap(async (req, res) => {
      const { id } = parse(idParam, req.params);
      res.json({ data: await service.getPayroll(id) });
    }),
  );

  router.post(
    '/:id/process',
    manager,
    wrap(async (req, res) => {
      const { id } = parse(idParam, req.params);
      await service.queueForProcessing(id, req.user!.id, deps.queue);
      res.status(202).json({ message: 'Payroll queued for processing' });
    }),
  );

  // Releasing money is the most sensitive step, so only admins can enter the OTP.
  router.post(
    '/:id/authorize',
    adminOnly,
    wrap(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const { otp } = parse(otpSchema, req.body);
      await service.authorizePayroll(id, otp, req.user!.id, deps.gateway);
      res.json({ message: 'Batch authorized' });
    }),
  );

  router.post(
    '/:id/retry-failed',
    manager,
    wrap(async (req, res) => {
      const { id } = parse(idParam, req.params);
      res.status(202).json({ data: await service.retryFailed(id, req.user!.id, deps.queue) });
    }),
  );

  router.post(
    '/:id/reconcile',
    manager,
    wrap(async (req, res) => {
      const { id } = parse(idParam, req.params);
      res.json({ data: await service.reconcilePayroll(id, deps.gateway) });
    }),
  );

  return router;
}
