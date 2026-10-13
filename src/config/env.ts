import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  MONNIFY_BASE_URL: z.string().url().default('https://sandbox.monnify.com'),
  MONNIFY_API_KEY: z.string().min(1),
  MONNIFY_SECRET_KEY: z.string().min(1),
  MONNIFY_WALLET_ACCOUNT_NUMBER: z.string().min(1),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed once, on first use, so a bad config fails fast with a readable message. */
export function getEnv(): Env {
  if (!cached) {
    const result = schema.safeParse(process.env);
    if (!result.success) {
      const problems = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid environment configuration:\n${problems}`);
    }
    cached = result.data;
  }
  return cached;
}
