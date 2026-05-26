/**
 * One-time CLI helper to mint a Google OAuth refresh token for the YouTube uploader.
 *
 * Usage:
 *   yarn workspace @google-ads-tool/server tsx scripts/yt-oauth.ts
 *
 * Steps:
 *   1. Reads GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET from .env
 *   2. Spins up a local server on http://localhost:8765/callback
 *   3. Opens (or prints) the Google consent URL
 *   4. After consent, exchanges the code for a refresh token and prints it
 *
 * Paste the printed token into your .env as:
 *     YT_REFRESH_TOKEN=...                # default channel
 *   or
 *     YT_REFRESH_TOKEN_MYCHANNEL=...      # named channel
 * then restart the server.
 *
 * IMPORTANT: In your GCP OAuth client (Web application type), add
 *   http://localhost:8765/callback
 * to the authorised redirect URIs.
 */
import http from 'node:http';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '..', '..', '.env') });

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8765/callback';
const PORT = 8765;

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES.join(' '));
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent'); // force refresh_token in response
authUrl.searchParams.set('include_granted_scopes', 'true');

console.log('\nOpen this URL in a browser logged into the target Google account:\n');
console.log(authUrl.toString());
console.log('\nWaiting for callback on', REDIRECT_URI, '…\n');

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404).end('Not found');
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (err) {
    res.writeHead(400).end(`OAuth error: ${err}`);
    console.error('OAuth error:', err);
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400).end('Missing code');
    return;
  }

  try {
    const body = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tok = (await tokRes.json()) as {
      refresh_token?: string;
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (tok.error || !tok.refresh_token) {
      const detail = tok.error_description ?? tok.error ?? 'no refresh_token returned';
      res.writeHead(500).end(`Token exchange failed: ${detail}`);
      console.error('Token exchange failed:', tok);
      process.exit(1);
    }

    let channelTitle: string | undefined;
    if (tok.access_token) {
      try {
        const chRes = await fetch(
          'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
          { headers: { Authorization: `Bearer ${tok.access_token}` } }
        );
        const j = (await chRes.json()) as {
          items?: Array<{ snippet?: { title?: string } }>;
        };
        channelTitle = j.items?.[0]?.snippet?.title;
      } catch { /* non-fatal */ }
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body style="font-family: sans-serif;">
        <h2>Refresh token issued${channelTitle ? ` for "${channelTitle}"` : ''}.</h2>
        <p>Copy it from the terminal and paste into your <code>.env</code> as <code>YT_REFRESH_TOKEN</code> (or <code>YT_REFRESH_TOKEN_&lt;CHANNEL&gt;</code>). You can close this tab.</p>
      </body></html>
    `);

    console.log('\n=== SUCCESS ===');
    if (channelTitle) console.log(`Channel: ${channelTitle}`);
    console.log(`\nPaste this into your .env:\n`);
    console.log(`YT_REFRESH_TOKEN=${tok.refresh_token}`);
    console.log(`\n(or YT_REFRESH_TOKEN_<CHANNEL_KEY>=${tok.refresh_token} for multi-channel)\n`);
    setTimeout(() => process.exit(0), 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500).end(`Error: ${msg}`);
    console.error(e);
    process.exit(1);
  }
});

server.listen(PORT);
