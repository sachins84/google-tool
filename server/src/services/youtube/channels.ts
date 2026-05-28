import { getDb } from '../../db/init.js';
import { getYoutubeChannels, type YoutubeChannelConfig } from '../../config.js';
import { getAccessToken } from './auth.js';

/**
 * Channels come from two sources during the rollout:
 *   1. DB rows in `youtube_channel_auth` written by the web consent flow.
 *      Their key is `yt:<channel_id>` — stable across UI relabels.
 *   2. Legacy `YT_REFRESH_TOKEN_*` env vars. Their key is the env suffix
 *      lowercased (or `default` for the single-channel form).
 *
 * UI lists both; uploader resolves a key back to a refresh token via
 * `getChannelConfig`. Source tag lets the UI flag which are migrated.
 */
export type ChannelSource = 'db' | 'env';
const DB_PREFIX = 'yt:';

export interface YoutubeChannelInfo {
  key: string;
  label: string;
  source: ChannelSource;
  channelId?: string;
  title?: string;
  thumbnail?: string;
  brandId?: number;
  brandName?: string;
  grantedByEmail?: string;
  grantedAt?: number;
  lastUsedAt?: number;
  lastRefreshError?: string | null;
}

interface DbAuthRow {
  id: number;
  brand_id: number;
  brand_name: string | null;
  channel_id: string;
  channel_title: string;
  channel_thumbnail: string | null;
  refresh_token: string;
  granted_by_email: string;
  granted_at: number;
  last_used_at: number | null;
  last_refresh_error: string | null;
}

function loadDbChannels(): DbAuthRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT a.id, a.brand_id, b.name AS brand_name,
              a.channel_id, a.channel_title, a.channel_thumbnail,
              a.refresh_token, a.granted_by_email, a.granted_at,
              a.last_used_at, a.last_refresh_error
         FROM youtube_channel_auth a
         LEFT JOIN brands b ON b.id = a.brand_id
        WHERE a.revoked_at IS NULL
        ORDER BY b.name, a.channel_title`
    )
    .all() as DbAuthRow[];
}

function dbRowToInfo(r: DbAuthRow): YoutubeChannelInfo {
  return {
    key: `${DB_PREFIX}${r.channel_id}`,
    label: r.channel_title,
    source: 'db',
    channelId: r.channel_id,
    title: r.channel_title,
    thumbnail: r.channel_thumbnail ?? undefined,
    brandId: r.brand_id,
    brandName: r.brand_name ?? undefined,
    grantedByEmail: r.granted_by_email,
    grantedAt: r.granted_at,
    lastUsedAt: r.last_used_at ?? undefined,
    lastRefreshError: r.last_refresh_error,
  };
}

/**
 * Resolve an env channel to its metadata via the existing `youtube_channels`
 * cache, falling back to a channels.list call on first use.
 */
async function describeEnvChannel(
  cfg: YoutubeChannelConfig,
  force = false
): Promise<YoutubeChannelInfo> {
  const db = getDb();
  if (!force) {
    const row = db
      .prepare('SELECT channel_id, title, thumbnail FROM youtube_channels WHERE key = ?')
      .get(cfg.key) as
      | { channel_id: string | null; title: string | null; thumbnail: string | null }
      | undefined;
    if (row?.title) {
      return {
        key: cfg.key,
        label: cfg.label,
        source: 'env',
        channelId: row.channel_id ?? undefined,
        title: row.title,
        thumbnail: row.thumbnail ?? undefined,
      };
    }
  }

  const { accessToken } = await getAccessToken(cfg.refreshToken);
  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`channels.list failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      id: string;
      snippet?: { title?: string; thumbnails?: { default?: { url?: string } } };
    }>;
  };
  const item = json.items?.[0];
  const channelId = item?.id;
  const title = item?.snippet?.title;
  const thumbnail = item?.snippet?.thumbnails?.default?.url;

  db.prepare(
    `INSERT INTO youtube_channels (key, channel_id, title, thumbnail, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       channel_id = excluded.channel_id,
       title = excluded.title,
       thumbnail = excluded.thumbnail,
       fetched_at = excluded.fetched_at`
  ).run(cfg.key, channelId ?? null, title ?? null, thumbnail ?? null, Math.floor(Date.now() / 1000));

  return { key: cfg.key, label: cfg.label, source: 'env', channelId, title, thumbnail };
}

/**
 * Public list shown in the uploader dropdown and the YouTube Auth page.
 * DB-sourced channels first (production path), env channels appended.
 */
export async function listConfiguredChannels(): Promise<YoutubeChannelInfo[]> {
  const out: YoutubeChannelInfo[] = loadDbChannels().map(dbRowToInfo);
  // Skip env channels whose channel_id already appears in DB (avoid dupes after migration).
  const dbChannelIds = new Set(out.map((c) => c.channelId).filter(Boolean) as string[]);
  for (const c of getYoutubeChannels()) {
    try {
      const info = await describeEnvChannel(c);
      if (info.channelId && dbChannelIds.has(info.channelId)) continue;
      out.push(info);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.push({ key: c.key, label: `${c.label} (auth error: ${msg})`, source: 'env' });
    }
  }
  return out;
}

/**
 * Resolve a channel key (DB or env) to an uploader-ready config.
 * Returns undefined when the key is unknown / revoked.
 *
 * DB-sourced lookups also bump `last_used_at` so the UI can show channel freshness.
 */
export async function getChannelConfig(key: string): Promise<YoutubeChannelConfig | undefined> {
  if (key.startsWith(DB_PREFIX)) {
    const channelId = key.slice(DB_PREFIX.length);
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, channel_title, refresh_token
           FROM youtube_channel_auth
          WHERE channel_id = ? AND revoked_at IS NULL
          LIMIT 1`
      )
      .get(channelId) as
      | { id: number; channel_title: string; refresh_token: string }
      | undefined;
    if (!row) return undefined;
    db.prepare(`UPDATE youtube_channel_auth SET last_used_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000), row.id);
    return { key, label: row.channel_title, refreshToken: row.refresh_token };
  }
  return getYoutubeChannels().find((c) => c.key === key);
}

/**
 * Persist a token-refresh failure against a DB-sourced channel so the UI can
 * surface "needs reconnect". No-op for env-sourced keys.
 */
export function markChannelRefreshError(key: string, error: string): void {
  if (!key.startsWith(DB_PREFIX)) return;
  const channelId = key.slice(DB_PREFIX.length);
  getDb()
    .prepare(
      `UPDATE youtube_channel_auth
          SET last_refresh_error = ?
        WHERE channel_id = ? AND revoked_at IS NULL`
    )
    .run(error, channelId);
}
