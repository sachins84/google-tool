import { getDb } from '../../db/init.js';
import { getYoutubeChannels, type YoutubeChannelConfig } from '../../config.js';
import { getAccessToken } from './auth.js';

export interface YoutubeChannelInfo {
  key: string;
  label: string;
  channelId?: string;
  title?: string;
  thumbnail?: string;
}

/**
 * Look up the YouTube channel that a refresh token is authorised against.
 * Cached in SQLite per channel key. Caller decides when to refresh
 * (force=true) — first call after a token rotation should pass force.
 */
export async function describeChannel(
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

  return { key: cfg.key, label: cfg.label, channelId, title, thumbnail };
}

export async function listConfiguredChannels(): Promise<YoutubeChannelInfo[]> {
  const cfgs = getYoutubeChannels();
  const out: YoutubeChannelInfo[] = [];
  for (const c of cfgs) {
    try {
      out.push(await describeChannel(c));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.push({ key: c.key, label: `${c.label} (auth error: ${msg})` });
    }
  }
  return out;
}

export function getChannelConfig(key: string): YoutubeChannelConfig | undefined {
  return getYoutubeChannels().find((c) => c.key === key);
}
