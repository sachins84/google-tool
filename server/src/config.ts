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

  // YouTube uploader — OAuth client (standard Google OAuth, not AdYogi proxy)
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  // Single-channel shortcut. Multi-channel uses YT_REFRESH_TOKEN_<KEY>=... pattern,
  // picked up dynamically by getYoutubeChannels() below.
  YT_REFRESH_TOKEN: z.string().optional(),
  // Optional override for default-channel display label
  YT_DEFAULT_CHANNEL_LABEL: z.string().optional(),
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

export interface YoutubeChannelConfig {
  key: string;           // url-safe slug; what the UI sends back on upload
  label: string;         // human label (env or discovered channel name)
  refreshToken: string;
}

/**
 * Discover configured YouTube channels from env. Two forms:
 *   YT_REFRESH_TOKEN=<token>                          → key="default"
 *   YT_REFRESH_TOKEN_<SUFFIX>=<token>                 → key=suffix.toLowerCase()
 * Suffix becomes the channel key; the human label is filled in from a
 * channels.list call lazily by the channels service.
 */
export function getYoutubeChannels(): YoutubeChannelConfig[] {
  const out: YoutubeChannelConfig[] = [];
  if (config.YT_REFRESH_TOKEN) {
    out.push({
      key: 'default',
      label: config.YT_DEFAULT_CHANNEL_LABEL ?? 'Default',
      refreshToken: config.YT_REFRESH_TOKEN,
    });
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    const m = k.match(/^YT_REFRESH_TOKEN_(.+)$/);
    if (!m || !m[1]) continue;
    const suffix = m[1];
    const key = suffix.toLowerCase();
    if (out.some((c) => c.key === key)) continue;
    out.push({ key, label: suffix, refreshToken: v });
  }
  return out;
}
