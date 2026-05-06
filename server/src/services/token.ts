import { config } from '../config.js';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;
const TTL_MS = 50 * 60 * 1000;

export async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const res = await fetch(config.ADYOGI_TOKEN_URL, {
    method: 'POST',
    headers: { 'X-Refresh-Token': config.GOOGLE_ADS_REFRESH_TOKEN },
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error('Token exchange returned no access_token');
  }

  cached = { accessToken: body.access_token, expiresAt: Date.now() + TTL_MS };
  return cached.accessToken;
}

export function clearTokenCache(): void {
  cached = null;
}
