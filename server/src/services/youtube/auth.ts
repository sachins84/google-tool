/**
 * Standard Google OAuth refresh→access token exchange.
 * Distinct from the AdYogi-proxied Google Ads flow used elsewhere in the app —
 * those tokens carry the adwords scope and won't work for youtube/drive/sheets.
 */
import { config } from '../../config.js';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

const cache = new Map<string, CachedToken>();

export interface GoogleAccessToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Exchange a refresh token for an access token. Cached per refresh token
 * with a 60s safety buffer before expiry.
 */
export async function getAccessToken(refreshToken: string): Promise<GoogleAccessToken> {
  const now = Date.now();
  const cached = cache.get(refreshToken);
  if (cached && cached.expiresAt > now + 60_000) {
    return { accessToken: cached.accessToken, expiresAt: cached.expiresAt };
  }

  if (!config.GOOGLE_OAUTH_CLIENT_ID || !config.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are required for the YouTube uploader. Add them to .env.'
    );
  }

  const body = new URLSearchParams({
    client_id: config.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: config.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google OAuth token exchange failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = now + json.expires_in * 1000;
  cache.set(refreshToken, { accessToken: json.access_token, expiresAt });
  return { accessToken: json.access_token, expiresAt };
}

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];
