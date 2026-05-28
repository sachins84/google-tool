# Google Ads Tool

Local-first Google Ads dashboard with brand-grouped accounts, post-RTO ROAS, and safe mutations.

## Quick start

```bash
# 1. Install deps (both workspaces)
npm install

# 2. Copy and edit .env
cp .env.example .env
# fill in GOOGLE_ADS_REFRESH_TOKEN and GOOGLE_ADS_DEVELOPER_TOKEN

# 3. Start dev servers (backend on :5011, web on :5173)
npm run dev
```

Open http://localhost:5173 — login with the admin credentials from `.env`.

## Architecture

- **server/** — Fastify + TypeScript + SQLite. REST API on port 5011.
- **web/** — React + Vite + TypeScript + Tailwind. Dev on port 5173.

In production, the server serves the built web bundle from a single port.

## YouTube Uploader

The "YT Upload" tab uploads Drive videos to YouTube (unlisted by default) from a Google Sheet, so they can be used as creative for Google Ads video campaigns. Channels are connected per-brand through an in-app Google consent flow.

See [docs/youtube-uploader.md](docs/youtube-uploader.md) for the full guide.

### Setup (one-time)

1. In your GCP project enable: **YouTube Data API v3**, **Drive API**, **Sheets API**.
2. Create an OAuth client (type *Web application*). Add redirect `<PUBLIC_BASE_URL>/api/youtube/auth/callback` for the web flow (and `http://localhost:8765/callback` if you also use the CLI helper).
3. In `.env` set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `PUBLIC_BASE_URL`, and `OAUTH_STATE_SECRET` (a random 32+ byte hex string, e.g. `openssl rand -hex 32`), then restart the server.

### Connect a channel

Open the **YT Channels** tab, pick a brand, and click **Connect channel via Google** — sign in as a `@mosaicwellness.in` admin and select the Brand Account/channel on the consent screen. Tokens are stored in the DB, scoped to the brand. Repeat per channel.

> Legacy alternative: mint a refresh token with `yarn workspace @google-ads-tool/server tsx scripts/yt-oauth.ts` and paste it into `.env` as `YT_REFRESH_TOKEN=...` (default channel) or `YT_REFRESH_TOKEN_<NAME>=...` (named channel, key lowercased). Env channels still work and appear tagged `(env)`.

### Sheet format

- The tool auto-detects the column containing Drive links (any cell matching a `drive.google.com` URL).
- Optional headers (case-insensitive): `Title`, `Description`, `Tags` (comma-separated).
- The tool appends `YouTube URL` and `Status` columns if missing and writes results back per row.

### Large files

Uploads use YouTube's resumable upload protocol with 8 MiB chunks streamed directly from Drive via Range reads. No file is buffered to memory or disk, retries on 5xx/network errors are automatic, and progress survives transient failures. Multi-GB / multi-hour videos are supported.
