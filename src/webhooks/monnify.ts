import express, { Router } from 'express';
import { getEnv } from '../config/env';
import { logger } from '../lib/logger';
import { verifyMonnifySignature } from '../lib/monnify';
import { wrap } from '../middleware/errors';
import { applyDisbursementEvent } from '../modules/payrolls/service';

/**
 * Mounted before express.json(): the signature is computed over the exact bytes Monnify sent,
 * so the body must stay raw until it has been verified.
 */
export function monnifyWebhookRouter() {
  const router = Router();

  router.post(
    '/',
    express.raw({ type: '*/*', limit: '1mb' }),
    wrap(async (req, res) => {
      const raw = req.body as unknown;
      const signature = req.header('monnify-signature');

      if (!Buffer.isBuffer(raw) || !verifyMonnifySignature(raw, signature, getEnv().MONNIFY_SECRET_KEY)) {
        logger.warn({ ip: req.ip }, 'rejected webhook with invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      let event: unknown;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Body is not valid JSON' });
      }

      // Errors bubble up as 500 so Monnify retries; the dedupe key makes a retry harmless.
      const outcome = await applyDisbursementEvent(event, raw);
      res.status(200).json({ received: true, outcome });
    }),
  );

  return router;
}
