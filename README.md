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

The "YT Upload" tab uploads Drive videos to YouTube (unlisted by default) from a Google Sheet, so they can be used as creative for Google Ads video campaigns.

### Setup (one-time)

1. In your GCP project enable: **YouTube Data API v3**, **Drive API**, **Sheets API**.
2. Create an OAuth client (type *Web application*) with redirect `http://localhost:8765/callback`.
3. Paste client id/secret into `.env` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
4. For each YouTube channel you want to upload to, run:
   ```bash
   yarn workspace @google-ads-tool/server tsx scripts/yt-oauth.ts
   ```
   Sign in with the Google account that owns/manages the channel, pick the brand channel on the consent screen. Paste the printed token into `.env`:
   - `YT_REFRESH_TOKEN=...` for the default channel
   - `YT_REFRESH_TOKEN_MANMATTERS=...` for a named channel (key = `manmatters`)
5. Restart the server.

### Sheet format

- The tool auto-detects the column containing Drive links (any cell matching a `drive.google.com` URL).
- Optional headers (case-insensitive): `Title`, `Description`, `Tags` (comma-separated).
- The tool appends `YouTube URL` and `Status` columns if missing and writes results back per row.

### Large files

Uploads use YouTube's resumable upload protocol with 8 MiB chunks streamed directly from Drive via Range reads. No file is buffered to memory or disk, retries on 5xx/network errors are automatic, and progress survives transient failures. Multi-GB / multi-hour videos are supported.
