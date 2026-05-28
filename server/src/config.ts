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
  // picked up dynamically by getYoutubeChannels() below. Both are legacy env-based
  // sources; the web consent flow stores refresh tokens in youtube_channel_auth.
  YT_REFRESH_TOKEN: z.string().optional(),
  // Optional override for default-channel display label
  YT_DEFAULT_CHANNEL_LABEL: z.string().optional(),
  // Base URL used to build the OAuth redirect_uri. Must exactly match an
  // Authorized Redirect URI registered on the OAuth client in GCP Console
  // (e.g. https://tool.mosaicwellness.in). No trailing slash.
  PUBLIC_BASE_URL: z.string().url().optional(),
  // HMAC secret for the OAuth `state` param (CSRF protection + brand_id transport).
  // Required only when the web consent flow is used.
  OAUTH_STATE_SECRET: z.string().min(16).optional(),

  // ── Recommender system ──────────────────────────────────────────────
  // Master switch for the daily scheduler. Routes work regardless; this only
  // controls the background timer (manual POST /run always works).
  ENABLE_RECOMMENDER: z.coerce.boolean().default(false),
  // Hour of day (0-23, server local) after which the daily run is allowed —
  // gives upstream Google/Redshift data time to settle.
  RECOMMENDER_RUN_HOUR: z.coerce.number().min(0).max(23).default(6),
  // Max budget / tROAS step per single run (fraction of current). Caps how
  // aggressively we change a campaign so Google's bid algo stays stable.
  // Scale-ups are additionally hard-capped at 15% in the optimizer.
  RECOMMENDER_MAX_BUDGET_STEP_PCT: z.coerce.number().min(0.01).max(1).default(0.15),
  // Min conversions in the window before an action is allowed (noise guard).
  RECOMMENDER_MIN_DATA_CONV: z.coerce.number().min(0).default(15),
  // Days a campaign is treated as "in learning" after a structural change.
  RECOMMENDER_LEARNING_PHASE_DAYS: z.coerce.number().min(0).default(14),
  // Cooldown: don't re-touch a campaign mutated within this many days.
  RECOMMENDER_COOLDOWN_DAYS: z.coerce.number().min(0).default(7),
  // Default evaluation window (days) when the user doesn't pick one.
  RECOMMENDER_DEFAULT_WINDOW_DAYS: z.coerce.number().min(1).max(90).default(7),
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
