/**
 * HMAC-signed `state` parameter for the YouTube OAuth flow.
 *
 * The state survives a round-trip through Google's consent screen, so we use
 * it for two things at once: CSRF protection (signature) and carrying the
 * brand_id the admin clicked "Connect" from. A signed payload is preferable
 * to a server-side state cache because the callback handler is stateless.
 */
import crypto from 'node:crypto';
import { config } from '../../config.js';

export interface OAuthStatePayload {
  brandId: number;
  userId: number | null;
  nonce: string;
  ts: number;
}

const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function getSecret(): string {
  if (!config.OAUTH_STATE_SECRET) {
    throw new Error(
      'OAUTH_STATE_SECRET is required for the YouTube OAuth consent flow. Add a random 32+ byte hex string to .env.'
    );
  }
  return config.OAUTH_STATE_SECRET;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signState(input: { brandId: number; userId: number | null }): string {
  const payload: OAuthStatePayload = {
    brandId: input.brandId,
    userId: input.userId,
    nonce: crypto.randomBytes(16).toString('hex'),
    ts: Date.now(),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyState(token: string): OAuthStatePayload {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Malformed state');
  const [body, sig] = parts as [string, string];
  const expected = b64url(crypto.createHmac('sha256', getSecret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid state signature');
  }
  const payload = JSON.parse(fromB64url(body).toString('utf8')) as OAuthStatePayload;
  if (Date.now() - payload.ts > MAX_AGE_MS) {
    throw new Error('State expired');
  }
  return payload;
}
