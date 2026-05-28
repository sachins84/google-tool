# YouTube OAuth + Uploader

Bulk-upload videos stored in Google Drive to YouTube, driven by a Google Sheet,
one channel at a time. Channels are connected through an in-app Google consent
flow (no manual token copying) and scoped to a brand.

There are two moving parts:

1. **YT Channels** — connect/disconnect YouTube channels via Google OAuth.
2. **YouTube Uploader** — point a connected channel at a Sheet of Drive links and
   it uploads each video, writing the resulting YouTube URL back into the Sheet.

---

## 1. One-time setup (admin / ops)

The web consent flow needs four things in the root `.env` (loaded by
`server/src/config.ts`):

| Env var | Purpose |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client ID from the GCP project |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret |
| `PUBLIC_BASE_URL` | Externally reachable base URL of this app, e.g. `https://google-tool.internal`. Used to build the OAuth `redirect_uri`. No trailing slash needed. |
| `OAUTH_STATE_SECRET` | Random 32+ byte hex string. Signs the OAuth `state` (CSRF + carries the brand id through Google). Generate with `openssl rand -hex 32`. |

In the **GCP OAuth client** (type: *Web application*), add this authorized
redirect URI — it must match `PUBLIC_BASE_URL` exactly:

```
<PUBLIC_BASE_URL>/api/youtube/auth/callback
```

The OAuth consent screen should be configured as an **Internal** app under the
`mosaicwellness.in` Workspace — that is the real org boundary. The flow also
passes `hd=mosaicwellness.in` as a UX hint to restrict the account chooser.

Scopes requested: `youtube.upload`, `youtube.readonly`, plus `openid`/`email`
(to record who authorized the channel).

Restart the server after editing `.env`.

> **Local dev / http:** Google allows plain `http` for loopback redirect URIs
> (`http://localhost` and `http://127.0.0.1`, any port) — only non-localhost URIs
> must be HTTPS. So http does **not** block local testing.
>
> When running `npm run dev` you use the app at **`http://localhost:5173`** (vite),
> which proxies `/api` → the server on :5011. Point the OAuth flow at the vite
> origin so the whole round-trip stays on :5173:
> - `PUBLIC_BASE_URL=http://localhost:5173`
> - Register `http://localhost:5173/api/youtube/auth/callback` in the GCP client.
>
> Google redirects to `…:5173/api/youtube/auth/callback`; vite proxies it to the
> server, which processes the token and redirects back to `…:5173/?yt_auth_connected=…`
> — so the SPA banner renders normally. No prod build needed.
>
> Note on ports: `5173` (vite) and the proxy target `5011` are hardcoded in
> `web/vite.config.ts`. The server's own port is `PORT` in `.env` (default 5011);
> if you change it, update the proxy target to match. `PUBLIC_BASE_URL` is
> independent of `PORT` — in dev it's the vite origin (`:5173`), and the port
> never appears in the OAuth redirect URI.

---

## 2. Connect a channel (YT Channels tab)

1. Open the **YT Channels** tab in the dashboard.
2. Pick the **brand** the channel belongs to.
3. Click **Connect channel via Google**. You are redirected to Google's consent
   screen — sign in as a `@mosaicwellness.in` admin and **select the Brand
   Account / channel** you want to connect (not your personal account).
4. Google redirects back; a green banner confirms `Connected: <channel title>`.

The refresh token, channel id/title/thumbnail, and the authorizing email are
stored in the `youtube_channel_auth` table, keyed by `(brand_id, channel_id)`.

- **Multiple channels per brand:** repeat the flow and pick a different channel
  each time.
- **Re-connecting:** running the flow again for the same channel overwrites the
  stored token (upsert) and clears any prior error.
- **Disconnect:** the **Disconnect** button soft-revokes (sets `revoked_at`) and
  best-effort revokes the token at Google. Uploads to that channel stop until
  it's reconnected.
- **Health column:** `healthy` normally; flips to **needs reconnect** if a token
  refresh failed (e.g. the grant was revoked at `myaccount.google.com`). Fix by
  reconnecting.

---

## 3. Prepare the Google Sheet

The Sheet must be readable by the connected Google account. The uploader
**auto-detects the Drive-link column** (the column with the most Drive URLs), so
column order doesn't matter.

Optional headers (case-insensitive, matched by name):

| Header(s) | Effect |
| --- | --- |
| `Title` / `Video Title` / `Name` | YouTube video title (falls back to the Drive file name; truncated to 100 chars) |
| `Description` / `Desc` | Video description |
| `Tags` / `Keywords` | Comma- or semicolon-separated tags |

Two columns are **appended automatically** if missing and written back as the job
runs:

- `YouTube URL` — the resulting watch URL per row.
- `Status` — `queued` → `done` (or `error: …`).

Rows whose Drive-link cell isn't a Drive/Docs URL are skipped. The header is
row 1; data starts at row 2.

---

## 4. Run an upload job (YouTube Uploader tab)

1. Open the **YouTube Uploader** tab.
2. Pick the **YouTube channel** (connected channels appear first; env ones tagged
   `(env)`).
3. Choose **Privacy**: `Unlisted (ads-ready)` (default), `Private`, or `Public`.
4. Paste the **Google Sheet URL or ID**. Optionally set a **Tab name** (blank =
   first tab).
5. Click **Start upload**.

The job is created immediately and runs in the background. The right pane shows
per-row progress (size, % uploaded, status, YouTube link), polled every 2s until
the job is `completed` or `failed`. The left pane lists recent jobs; click any to
re-open its detail.

**How it runs (internals):**
- Videos stream **directly from Drive to YouTube** using YouTube's resumable
  upload in 8 MiB chunks — nothing is buffered to disk. Chunks retry up to 6× on
  5xx/network errors.
- Rows upload **sequentially** (bandwidth is the bottleneck; parallel uploads
  mostly cause rate-limit 5xxs).
- Job + row state lives in `youtube_jobs` / `youtube_job_rows`, so progress
  survives a page refresh.

---

## 5. Rate limits & quotas

**YouTube Data API quota (Google-side — the real ceiling).**
- Each upload (`videos.insert`) costs **1600 quota units**.
- The default project quota is **10,000 units/day**, i.e. **~6 uploads/day**
  before the API starts returning `quotaExceeded` (HTTP 403).
- Quota is **per GCP project / OAuth client**, shared across every brand and
  channel using the same `GOOGLE_OAUTH_CLIENT_ID` — connecting more channels does
  not raise it.
- It resets daily at **midnight Pacific Time**. To lift it, request a quota
  increase (YouTube API compliance audit) in the Google Cloud Console.
- When exhausted, the in-flight row fails with `quotaExceeded` (written to the
  row error and the Sheet `Status`). Remaining rows keep trying and will also
  fail until quota resets — so a large batch can partially complete across days.

**Built-in retry / backoff (app-side).**
- Uploads run **sequentially**, one video at a time per job — no parallelism,
  which keeps the request rate low and avoids self-inflicted rate limiting.
- Each 8 MiB chunk is retried up to **6 attempts** on transient failures: HTTP
  **5xx**, HTTP **429** (rate limited), and network errors (`fetch failed`,
  `ECONNRESET`, `ETIMEDOUT`, `socket hang up`).
- Backoff is **exponential with jitter** (~2s, 4s, 8s, 16s, 32s, capped at 60s,
  plus up to 500ms random). Between retries the uploader re-syncs with YouTube's
  resumable session so already-accepted bytes aren't re-sent.
- Non-retryable errors (4xx other than 429, e.g. `quotaExceeded` or a bad
  request) fail that row immediately and the job moves on to the next row.

---

## 6. API reference

All `/api/youtube/*` routes require the session cookie. The OAuth `callback` is
intentionally public (Google is the caller; the signed `state` is the proof).

| Method & path | Purpose |
| --- | --- |
| `GET /api/youtube/auth/start?brand_id=` | Returns the Google consent URL (with signed state) |
| `GET /api/youtube/auth/callback` | Google redirect target; exchanges code, identifies channel, upserts token, redirects to `/?yt_auth_connected=…` |
| `GET /api/youtube/auth/channels` | List connected channels (per brand) |
| `DELETE /api/youtube/auth/channels/:id` | Soft-revoke a channel |
| `GET /api/youtube/channels` | Channels available to the uploader (DB + env) |
| `POST /api/youtube/upload` | Start a job. Body: `channel_key`, `sheet`, `sheet_tab?`, `privacy_status?` |
| `GET /api/youtube/jobs` | Recent jobs |
| `GET /api/youtube/jobs/:id` | One job + its rows |

---

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID / … must be set` on Connect | Missing OAuth env vars — see setup. |
| `PUBLIC_BASE_URL must be set` | Set it in `.env`; it builds the redirect URI. |
| `OAUTH_STATE_SECRET is required` | Add a 32+ byte hex secret to `.env`. |
| `redirect_uri_mismatch` on Google's screen | The GCP client's authorized redirect URI ≠ `<PUBLIC_BASE_URL>/api/youtube/auth/callback`. |
| "Google did not return a refresh token" | The account previously granted the scopes. Revoke at `myaccount.google.com/permissions`, then reconnect. |
| "The selected Google account has no YouTube channel" | You picked a personal account, not the Brand Account that owns the channel. |
| Channel shows **needs reconnect** | Token refresh failed (`invalid_grant`). Reconnect via the YT Channels tab. |
| "Could not auto-detect a Drive link column" | No column has Drive URLs in the data rows. Add Drive links. |
| Row error in the job table | Per-row failure (bad Drive link, permissions, YouTube quota). The Sheet's `Status` column shows `error: …`; other rows continue. |
