import pino from 'pino';
import { getEnv } from '../config/env';

export const logger = pino({
  level: getEnv().LOG_LEVEL,
  // Never write credentials or tokens to logs.
  redact: ['req.headers.authorization', 'req.headers["monnify-signature"]', '*.password', '*.otp'],
});
