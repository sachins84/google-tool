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
