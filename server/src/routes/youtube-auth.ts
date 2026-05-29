/**
 * Web-based YouTube OAuth consent flow.
 *
 * Replaces the manual `server/scripts/yt-oauth.ts` CLI: a brand admin clicks
 * "Connect a channel", goes through Google's consent screen, and the resulting
 * refresh token is stored in `youtube_channel_auth` keyed by (brand_id, channel_id).
 *
 * Flow:
 *   GET  /api/youtube/auth/start?brand_id=X   → build consent URL with signed state
 *   GET  /api/youtube/auth/callback           → exchange code, identify channel, persist
 *   GET  /api/youtube/auth/channels           → list connected channels (per brand)
 *   DELETE /api/youtube/auth/channels/:id     → soft-revoke
 *
 * Callback is intentionally NOT behind session auth — Google is the caller.
 * The signed `state` is what binds the callback to the admin who started it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db/init.js';
import { config } from '../config.js';
import { signState, verifyState } from '../services/youtube/oauth-state.js';

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  // Drive: download the source video files referenced in the sheet (read-only).
  'https://www.googleapis.com/auth/drive.readonly',
  // Sheets: read the upload manifest AND write back the YouTube URL / Status
  // columns — needs full spreadsheets, not the .readonly variant.
  'https://www.googleapis.com/auth/spreadsheets',
  // openid + email so we can stamp granted_by_email (the Google account that
  // authorized — not necessarily the same as the app session user).
  'openid',
  'email',
];

function requireOauthConfig(): { clientId: string; clientSecret: string; baseUrl: string } {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, PUBLIC_BASE_URL } = config;
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET must be set in .env');
  }
  if (!PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL must be set in .env (used to build the OAuth redirect_uri)');
  }
  return {
    clientId: GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
    baseUrl: PUBLIC_BASE_URL.replace(/\/+$/, ''),
  };
}

function redirectUri(baseUrl: string): string {
  return `${baseUrl}/api/youtube/auth/callback`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  id_token?: string;
  token_type: string;
}

interface ChannelsListItem {
  id: string;
  snippet?: { title?: string; thumbnails?: { default?: { url?: string } } };
}

function decodeIdTokenEmail(idToken: string): string | undefined {
  // Best-effort — Google ID tokens are signed JWTs; for our purposes we only
  // need the email claim, which we trust because the token came back over TLS
  // direct from the token endpoint we just authenticated against.
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payloadJson = Buffer.from(
      parts[1].replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    const payload = JSON.parse(payloadJson) as { email?: string };
    return payload.email;
  } catch {
    return undefined;
  }
}

export async function youtubeAuthRoutes(app: FastifyInstance): Promise<void> {
  // ─── GET /start ─────────────────────────────────────────────────────────
  app.get('/start', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { brand_id?: string };
    const brandId = Number(q.brand_id);
    if (!Number.isFinite(brandId)) {
      return reply.code(400).send({ error: 'brand_id required' });
    }
    const brand = getDb()
      .prepare('SELECT id, name FROM brands WHERE id = ?')
      .get(brandId) as { id: number; name: string } | undefined;
    if (!brand) return reply.code(404).send({ error: 'Brand not found' });

    let oauth: { clientId: string; baseUrl: string };
    try {
      oauth = requireOauthConfig();
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const state = signState({ brandId, userId: req.user?.id ?? null });
    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: redirectUri(oauth.baseUrl),
      response_type: 'code',
      scope: YOUTUBE_SCOPES.join(' '),
      access_type: 'offline',
      // Force refresh_token in the response even when the admin re-authorizes
      // an account that already granted the scopes once before.
      prompt: 'consent',
      include_granted_scopes: 'true',
      // UX hint — restricts the account chooser to the Workspace. Real org
      // boundary comes from the Internal app type on the OAuth consent screen.
      hd: 'mosaicwellness.in',
      state,
    });
    return {
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      brand: { id: brand.id, name: brand.name },
    };
  });

  // ─── GET /callback ──────────────────────────────────────────────────────
  // Public (no session auth) — Google is the caller. Signed state is the proof.
  app.get('/callback', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) {
      return reply.redirect(`/?yt_auth_error=${encodeURIComponent(q.error)}`);
    }
    if (!q.code || !q.state) {
      return reply.code(400).send({ error: 'Missing code or state' });
    }

    let payload;
    try {
      payload = verifyState(q.state);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Bad state' });
    }

    let oauth: ReturnType<typeof requireOauthConfig>;
    try {
      oauth = requireOauthConfig();
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }

    // 1. Exchange authorization code for tokens
    const tokenBody = new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      code: q.code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(oauth.baseUrl),
    });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return reply.redirect(
        `/?yt_auth_error=${encodeURIComponent(`Token exchange failed: ${text}`)}`
      );
    }
    const tokens = (await tokenRes.json()) as TokenResponse;
    if (!tokens.refresh_token) {
      // Happens when prompt=consent is missing OR when Google decides not to
      // re-issue. Tell the admin to disconnect at myaccount.google.com first.
      return reply.redirect(
        `/?yt_auth_error=${encodeURIComponent(
          'Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and try again.'
        )}`
      );
    }

    // 2. Identify the channel that was selected during consent
    const chRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );
    if (!chRes.ok) {
      const text = await chRes.text();
      return reply.redirect(
        `/?yt_auth_error=${encodeURIComponent(`channels.list failed: ${text}`)}`
      );
    }
    const chJson = (await chRes.json()) as { items?: ChannelsListItem[] };
    const item = chJson.items?.[0];
    if (!item?.id || !item.snippet?.title) {
      return reply.redirect(
        `/?yt_auth_error=${encodeURIComponent(
          'The selected Google account has no YouTube channel. Pick a Brand Account with a channel.'
        )}`
      );
    }

    // 3. granted_by_email — from the id_token email claim
    const grantedByEmail = tokens.id_token ? decodeIdTokenEmail(tokens.id_token) : undefined;

    // 4. UPSERT
    const db = getDb();
    db.prepare(
      `INSERT INTO youtube_channel_auth
         (brand_id, channel_id, channel_title, channel_thumbnail, refresh_token,
          scopes, granted_by_email, granted_at, revoked_at, last_refresh_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (brand_id, channel_id) DO UPDATE SET
         channel_title = excluded.channel_title,
         channel_thumbnail = excluded.channel_thumbnail,
         refresh_token = excluded.refresh_token,
         scopes = excluded.scopes,
         granted_by_email = excluded.granted_by_email,
         granted_at = excluded.granted_at,
         revoked_at = NULL,
         last_refresh_error = NULL`
    ).run(
      payload.brandId,
      item.id,
      item.snippet.title,
      item.snippet.thumbnails?.default?.url ?? null,
      tokens.refresh_token,
      tokens.scope,
      grantedByEmail ?? 'unknown@mosaicwellness.in',
      Math.floor(Date.now() / 1000)
    );

    return reply.redirect(
      `/?yt_auth_connected=${encodeURIComponent(item.snippet.title)}`
    );
  });

  // ─── GET /channels (list connected, per brand) ──────────────────────────
  app.get('/channels', { preHandler: requireAuth }, async () => {
    interface Row {
      id: number;
      brand_id: number;
      brand_name: string | null;
      channel_id: string;
      channel_title: string;
      channel_thumbnail: string | null;
      granted_by_email: string;
      granted_at: number;
      last_used_at: number | null;
      last_refresh_error: string | null;
    }
    const rows = getDb()
      .prepare(
        `SELECT a.id, a.brand_id, b.name AS brand_name,
                a.channel_id, a.channel_title, a.channel_thumbnail,
                a.granted_by_email, a.granted_at, a.last_used_at, a.last_refresh_error
           FROM youtube_channel_auth a
           LEFT JOIN brands b ON b.id = a.brand_id
          WHERE a.revoked_at IS NULL
          ORDER BY b.name, a.channel_title`
      )
      .all() as Row[];
    return { channels: rows };
  });

  // ─── DELETE /channels/:id ───────────────────────────────────────────────
  app.delete('/channels/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Bad id' });
    const db = getDb();
    const row = db
      .prepare('SELECT refresh_token FROM youtube_channel_auth WHERE id = ? AND revoked_at IS NULL')
      .get(id) as { refresh_token: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Not found' });

    db.prepare('UPDATE youtube_channel_auth SET revoked_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000), id);

    // Best-effort revoke at Google. Failure shouldn't block the soft-delete.
    void fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(row.refresh_token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    ).catch(() => { /* ignore */ });

    return { ok: true };
  });
}
