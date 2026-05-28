# YouTube OAuth — Web Consent Flow + Per-Brand Multi-Channel Token Storage

**Status:** Draft for review
**Author:** planned with Claude on 2026-05-27

## Goal

Replace the current "manually paste a refresh token into `.env`" flow with a web-based OAuth consent flow. Channel admins (all `@mosaicwellness.in` users) click "Connect a YouTube channel", go through Google's consent screen, and the resulting refresh token is stored in the DB keyed by (brand, channel). One brand can have many channels. Uploads then source the refresh token from the DB instead of env.

## Decisions locked in

| Topic | Decision |
|---|---|
| OAuth app verification | Skipped — Internal app within `mosaicwellness.in` Workspace. Only `@mosaicwellness.in` accounts can authorize. Refresh tokens are long-lived (no 7-day expiry). |
| Database | **SQLite** (existing `server/data/app.db` via `better-sqlite3`). MySQL migration will be planned separately. |
| Token encryption at rest | **Plaintext** for now. Same trust level as current `.env`. Can add encryption later. |
| Env-var fallback | **Keep `YT_REFRESH_TOKEN_*` working** during rollout. DB-sourced tokens take priority; env vars used only for channel keys not yet migrated. |
| UI placement | **Standalone YouTube settings page** (not per-brand-row). One table listing all brand → channel connections. |
| Callback URL | App reads `PUBLIC_BASE_URL` from env. User will provide the production hostname; that URL gets registered as an Authorized Redirect URI in GCP Console. |

## Architecture

```
                                      ┌────────────────────────┐
  Admin (@mosaicwellness.in)           │  GCP Console           │
       │                               │  Internal OAuth app    │
       │ 1. Click "Connect channel"    │  Redirect URI:         │
       │                               │  ${PUBLIC_BASE_URL}/   │
       ▼                               │   api/youtube/auth/    │
  ┌────────────────────────┐           │   callback             │
  │  /youtube/auth page    │           └────────────────────────┘
  │  (frontend)            │
  └─────────┬──────────────┘
            │ 2. GET /api/youtube/auth/start?brand_id=X
            ▼
  ┌────────────────────────┐  3. 302 to Google consent URL with
  │  Fastify server        │     state = signed{brand_id, user_id, nonce}
  │                        │
  │  /api/youtube/auth/    │  4. User picks Brand Account, grants scopes
  │    - start             │
  │    - callback ◄────────────────────────── 5. Redirect back with code + state
  │    - channels          │
  │    - disconnect        │  6. Exchange code → refresh_token
  └─────────┬──────────────┘  7. channels.list?mine=true → channel_id, title, thumb
            │                 8. UPSERT into youtube_channel_auth
            ▼
  ┌────────────────────────┐
  │  SQLite                │
  │  youtube_channel_auth  │
  └────────────────────────┘
            │
            │ At upload time: lookup refresh_token by (brand_id, channel_id)
            ▼
  ┌────────────────────────┐
  │  YouTube uploader      │  → reuses existing auth.ts (getAccessToken)
  │  (existing)            │     and upload.ts unchanged
  └────────────────────────┘
```

## Schema change

New table in `server/src/db/init.ts` (mirrors existing `CREATE TABLE IF NOT EXISTS` pattern):

```sql
CREATE TABLE IF NOT EXISTS youtube_channel_auth (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,              -- YT channel ID (UCxxxx)
  channel_title TEXT NOT NULL,
  channel_thumbnail TEXT,
  refresh_token TEXT NOT NULL,
  scopes TEXT NOT NULL,                  -- space-separated; what Google actually granted
  granted_by_email TEXT NOT NULL,        -- which @mosaicwellness.in user authorized
  granted_at INTEGER NOT NULL,
  last_used_at INTEGER,
  last_refresh_error TEXT,               -- null = healthy; populated on invalid_grant
  revoked_at INTEGER,                    -- soft delete
  UNIQUE(brand_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_yt_auth_brand ON youtube_channel_auth(brand_id);
```

Why one row per (brand, channel) not per brand: a single Google account authorization picks ONE Brand Account/channel. To connect N channels under one brand, the admin runs the consent flow N times, each time selecting a different Brand Account. Each yields its own refresh token. Keeping rows granular makes revocation and per-channel error tracking cleaner.

## New OAuth routes

File: `server/src/routes/youtube-auth.ts` (new), registered alongside existing `/api/youtube/*` in `server/src/index.ts`.

### `GET /api/youtube/auth/start?brand_id=<id>`

- Requires session auth (existing middleware).
- Validates `brand_id` exists.
- Builds the Google consent URL:
  ```
  https://accounts.google.com/o/oauth2/v2/auth?
    client_id={GOOGLE_OAUTH_CLIENT_ID}
    &redirect_uri={PUBLIC_BASE_URL}/api/youtube/auth/callback
    &response_type=code
    &scope=https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly
    &access_type=offline
    &prompt=consent              ← forces refresh_token in response even on re-auth
    &include_granted_scopes=true
    &state={SIGNED_STATE}
    &hd=mosaicwellness.in        ← restricts the account chooser to your Workspace
  ```
- `SIGNED_STATE` = HMAC-signed JSON `{brand_id, user_id, nonce, ts}`. HMAC secret from `OAUTH_STATE_SECRET` env var. Prevents CSRF + carries `brand_id` through the round-trip.
- Returns `{ url }` so the frontend can `window.open(url)` (or 302 redirect, depending on UX choice — popup is friendlier).

### `GET /api/youtube/auth/callback?code=&state=`

- **No session auth required** (Google is the caller). Security comes from the signed state.
- Verify state HMAC + timestamp (reject if older than 10 minutes).
- Exchange `code` at `https://oauth2.googleapis.com/token` with grant_type=authorization_code.
  - Required response fields: `refresh_token`, `access_token`, `expires_in`, `scope`.
  - If `refresh_token` is missing (happens if user previously authorized and we didn't include `prompt=consent`), error out with a clear message.
- Call `GET https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true` with the access token.
  - Read `items[0].id` → channel_id, `items[0].snippet.title` → channel_title, `items[0].snippet.thumbnails.default.url` → channel_thumbnail.
  - If `items` is empty → user authorized but has no channel under the picked Brand Account; surface error.
- `INSERT OR REPLACE INTO youtube_channel_auth ...` keyed by `(brand_id, channel_id)`. Sets `granted_by_email` from the user's session, `granted_at = now`, clears `revoked_at` and `last_refresh_error`.
- Redirect back to `/youtube/auth?connected=<channel_title>` so the page can show a success toast and refresh the list.

### `GET /api/youtube/auth/channels`

Returns all connected channels grouped by brand:
```json
[
  {
    "brand": { "id": 1, "name": "Brand A" },
    "channels": [
      { "id": 12, "channel_id": "UC...", "channel_title": "...", "granted_by_email": "...", "granted_at": ..., "last_used_at": ..., "last_refresh_error": null }
    ]
  }
]
```

### `DELETE /api/youtube/auth/channels/:id`

- Soft-delete: set `revoked_at = now`.
- Optionally also POST to `https://oauth2.googleapis.com/revoke?token=<refresh_token>` to revoke Google-side. Best effort — log failures, don't block.

## Refactor existing code to read from DB

### `server/src/services/youtube/auth.ts`

No changes to `getAccessToken(refreshToken)` itself — it stays a pure function over a refresh token. We just call it with the token sourced from DB.

Add a new helper `getRefreshTokenForChannel(channelKey: string): Promise<string>`:
1. First try DB: lookup `youtube_channel_auth` where `channel_id = channelKey AND revoked_at IS NULL`. If found, return `refresh_token` and update `last_used_at`.
2. Fallback to env: `YT_REFRESH_TOKEN_<NORMALIZED_KEY>` or `YT_REFRESH_TOKEN`. (Coexistence rollout.)
3. On `invalid_grant` from a subsequent `getAccessToken` call, write `last_refresh_error` to the DB row so it shows up in the UI.

### `server/src/services/youtube/upload.ts`

No change — already takes refresh token as a parameter.

### `server/src/routes/youtube.ts`

`GET /channels` currently lists channels from config (env-var-driven). Update to:
1. Union: DB-connected channels + env-configured channels.
2. Tag each with `source: "db" | "env"` so the UI can show which are migrated.
3. Existing `POST /upload` route accepts a channel key — resolve it through the new `getRefreshTokenForChannel` helper.

### `server/src/config.ts`

- Add `PUBLIC_BASE_URL` (required for callback URL construction).
- Add `OAUTH_STATE_SECRET` (required for HMAC signing). Document in `.env.example`.
- Existing `YT_REFRESH_TOKEN_*` parsing stays for fallback.

## Frontend

New page: `client/src/pages/YoutubeAuth.tsx` (path follows existing conventions — check the client folder structure).

Layout:
```
YouTube Channel Connections
──────────────────────────────────────────────────────────────
Brand           Channel         Connected by      Last used     [Status] [Actions]
──────────────────────────────────────────────────────────────
Brand A         Channel X       user@mw.in        2 days ago    ✓        [Disconnect]
Brand A         Channel Y       user@mw.in        —             ⚠ needs   [Reconnect]
                                                                  re-auth
Brand B         Channel Z       admin@mw.in       1 hour ago    ✓        [Disconnect]

[+ Connect a channel]  (opens dropdown to pick brand, then redirects)
```

"Connect a channel" flow:
1. User picks brand from dropdown.
2. Frontend calls `GET /api/youtube/auth/start?brand_id=X` → gets `url`.
3. `window.open(url, "_blank")` (or full-page redirect).
4. After Google redirects back to callback, server redirects to `/youtube/auth?connected=...`, page refreshes the channel list.

Add a sidebar/nav link "YouTube Channels" pointing to `/youtube/auth`.

## GCP Console setup checklist (one-time, manual)

1. OAuth consent screen → User Type = **Internal** (only visible if the GCP project lives under the `mosaicwellness.in` Workspace org — verify this is the case).
2. Scopes: add `.../auth/youtube.upload` and `.../auth/youtube.readonly`.
3. OAuth Client (Web application):
   - Authorized redirect URIs: `${PUBLIC_BASE_URL}/api/youtube/auth/callback` (production) and `http://localhost:<port>/api/youtube/auth/callback` (local dev).
4. Confirm `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in env match this OAuth client.

## Env vars to add

```
PUBLIC_BASE_URL=https://<your-stable-hostname>
OAUTH_STATE_SECRET=<random 32+ byte hex>
```

Update `.env.example` with both.

## File-level change list

| File | Action |
|---|---|
| `server/src/db/init.ts` | ADD `youtube_channel_auth` table block |
| `server/src/routes/youtube-auth.ts` | NEW — 4 routes (start, callback, channels, disconnect) |
| `server/src/services/youtube/auth.ts` | ADD `getRefreshTokenForChannel` helper |
| `server/src/services/youtube/oauth-state.ts` | NEW — HMAC sign/verify for `state` param |
| `server/src/routes/youtube.ts` | UPDATE `GET /channels` to merge DB+env sources; UPDATE upload to resolve via helper |
| `server/src/index.ts` | REGISTER new `/api/youtube/auth/*` route group |
| `server/src/config.ts` | ADD `PUBLIC_BASE_URL`, `OAUTH_STATE_SECRET` |
| `.env.example` | DOCUMENT new vars |
| `client/src/pages/YoutubeAuth.tsx` | NEW — connection management page |
| `client/src/<nav>` | ADD sidebar link |
| `server/scripts/yt-oauth.ts` | KEEP for now (deprecated) — useful for break-glass / local dev without server |

## Edge cases worth flagging during implementation

1. **`prompt=consent` is critical** — without it, re-authorizing the same Google account won't return a `refresh_token` (Google withholds it on subsequent auths). Always set it.
2. **`hd=mosaicwellness.in`** restricts the consent screen to Workspace accounts — but it's UX, not security. The Internal app type is what enforces the org boundary.
3. **Brand Account channel selection** — when an admin manages multiple Brand Accounts, Google shows them a channel chooser during consent. The `channels.list?mine=true` after the callback returns whichever they picked. If they pick the wrong one, they can disconnect and reconnect.
4. **`invalid_grant` over time** — refresh tokens can die if (a) the admin's Workspace account is deleted, (b) admin revokes access at myaccount.google.com, (c) admin password reset on some setups. The `last_refresh_error` column surfaces this so someone can reconnect.
5. **Concurrent uploads to the same channel** — the existing in-memory access-token cache in `auth.ts` handles this. No change needed.
6. **Callback URL host mismatch** — if `PUBLIC_BASE_URL` doesn't exactly match a registered Authorized Redirect URI in GCP Console, Google returns `redirect_uri_mismatch`. Document this loudly in the setup steps.
7. **State expiry** — 10-minute window between `start` and `callback` is generous; tighten if needed.
8. **Job concurrency vs revoked tokens** — if a channel is disconnected mid-upload, in-flight jobs should fail cleanly with a clear error rather than hanging.

## Out of scope (intentionally)

- Token encryption at rest (deferred — plaintext now, matches `.env` trust level).
- Hard migration of existing `YT_REFRESH_TOKEN_*` env vars (coexistence path chosen).
- Multi-Workspace support (single `hd=mosaicwellness.in` assumed).
- Audit log of who authorized/disconnected (could add later via a `youtube_auth_events` table).

## Rollout plan

1. Land schema + routes + helper + minimal UI behind a feature flag (env var `YOUTUBE_OAUTH_DB_ENABLED=true`).
2. Have one admin connect one channel through the UI; verify upload works using the DB-sourced token.
3. Connect remaining channels brand-by-brand.
4. Once all channels are in DB, remove the env-var fallback and the deprecated `yt-oauth.ts` CLI.
