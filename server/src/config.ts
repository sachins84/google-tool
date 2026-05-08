import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env from project root (server/src/ → ../../.env)
loadEnv({ path: path.resolve(__dirname, '..', '..', '.env') });

const schema = z.object({
  PORT: z.coerce.number().default(5011),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SESSION_SECRET: z.string().min(16),

  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default('admin'),

  ADYOGI_TOKEN_URL: z.string().url(),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().min(1),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().min(1),
  GOOGLE_ADS_API_VERSION: z.string().default('v21'),

  REDSHIFT_HOST: z.string().optional(),
  REDSHIFT_PORT: z.coerce.number().optional(),
  REDSHIFT_DB: z.string().optional(),
  REDSHIFT_USER: z.string().optional(),
  REDSHIFT_PASSWORD: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

// project root (../../ from server/src/)
export const projectRoot = path.resolve(__dirname, '..', '..');
export const dbPath = path.join(projectRoot, 'server', 'data', 'app.db');
