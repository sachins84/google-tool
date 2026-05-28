# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is an npm-workspaces monorepo (`server/` + `web/`). The `package.json` at the root proxies most commands to both workspaces.

```bash
npm install                # installs both workspaces
npm run dev                # boots server (:5011) and web dev server (:5173) in parallel
npm run build              # tsc for server, then tsc + vite build for web
npm run start              # node dist/index.js (production server, serves web/dist)

# Per-workspace operations (use `yarn workspace` because packageManager is yarn@4):
yarn workspace @google-ads-tool/server tsx scripts/yt-oauth.ts   # one-off YouTube channel OAuth
yarn workspace @google-ads-tool/web build                        # web-only build
yarn workspace @google-ads-tool/server build                     # server-only build
```

The vite dev server proxies `/api` to `http://localhost:5011`, so the frontend talks to the live server when both are running. No test framework or linter is configured.

## Architecture

### Workspaces
- **`server/`** — Fastify + TypeScript (ES modules, `"type": "module"`, so internal imports use `.js` extensions even from `.ts` files). Persistent state is in `server/data/app.db` (better-sqlite3, WAL mode). All schema is created **inline in `server/src/db/init.ts`** with `CREATE TABLE IF NOT EXISTS` + idempotent `ALTER TABLE ADD COLUMN` blocks at the bottom — there is no migration tool. When you add a column, follow that pattern.
- **`web/`** — React 19 + Vite + Tailwind. Single-page app, no router; `App.tsx` swaps between `Login` and `Dashboard`, and `Dashboard.tsx` switches views via a `view` state. All API calls go through `web/src/lib/api.ts`.
- In production, the server registers `@fastify/static` for `web/dist` and serves the SPA from the same port as the API.

### Config & secrets
`server/src/config.ts` loads a **single `.env` from the project root** (not from `server/`). Schema is validated with zod and the process exits on invalid env. `projectRoot` and `dbPath` are exported from there. Never duplicate env loading elsewhere.

### Google Ads access
- OAuth is **proxied through AdYogi**: `services/token.ts` POSTs the refresh token to `ADYOGI_TOKEN_URL` to get a short-lived access token (cached for 50 min in-process). Do not add a standard Google OAuth flow for Ads — that path is intentional.
- `services/google-ads.ts` is the thin GAQL client (`search()` paginates automatically). GAQL query builders live in `services/gaql.ts`.
- `services/mcc-map.ts` is a 1-hour in-memory cache of every accessible `customer_id` → the MCC to send as `login-customer-id`. Anything that calls Google Ads for a specific customer should first call `getLoginCustomerId(customerId)` and pass it to `search()`. The cache is built by `listAccessibleCustomers` + per-MCC `customer_client` enumeration.

### Brand model
- A **brand** groups one or more Google Ads `customer_id`s (`brands` + `brand_accounts` tables). All performance and mutation routes are brand-scoped.
- Each brand has an `rto_mode` (`flat` | `redshift`). `flat` applies a constant `rto_factor` to conversions. `redshift` joins Google Ads metrics with a per-brand **funnel table** in Redshift (e.g. `mw_nexus.lj_google_funnel_daily`) via `services/redshift.ts` to compute post-RTO ROAS and new-customer metrics.
- `server/src/config/brand-presets.ts` maps normalized brand names → Redshift funnel table + utm_source filters. On every server start, `applyBrandPresetsToExistingBrands` re-applies presets to brands by name — so adding a brand named "Man Matters" via the Settings UI auto-wires its Redshift config.

### Mutations & audit log
- **All write operations go through one endpoint:** `POST /api/mutate`, with an `action` discriminator (`pause` / `enable` / `update_budget` / `add_negative_keyword` / `add_keyword` / `update_ad_group_bids` / etc.). See `server/src/routes/mutate.ts`.
- Every call — including `dry_run: true` — is recorded to the `audit_log` table by `services/audit-log.ts`. The Audit tab in the UI reads this. Preserve this invariant when adding new mutation actions.

### Recommender system (portfolio = brand)
Daily in-process pipeline for each brand. No external AI; everything runs in `server/src/services/recommender/`.
- `scheduler.ts` ticks every 15 minutes after `RECOMMENDER_RUN_HOUR`. Master switch: `ENABLE_RECOMMENDER`. Manual runs via `POST /api/recommendations/run` always work.
- `runner.ts` snapshots metrics → `optimizer.ts` produces candidate actions → `rationale.ts` writes human reasons. `UNIQUE(brand_id, run_date)` on `recommendation_runs` is the dedupe lock (survives restarts, no double-runs).
- Guardrails live in the `rules` table. `seedDefaultRules` in `db/init.ts` seeds floors/caps/portfolio target per brand on first run; `is_hard=1` rules are inviolable and the feedback loop never relaxes them. The default rules ARE the `OptimizerConfig` — `buildOptimizerConfig` reads them back.
- A recommendation's `mutate_payload_json` is the **exact body** for `POST /api/mutate` (minus `dry_run`). Acting on a recommendation reuses the mutation pipeline, so audit_log captures it the same way as a manual action.
- `metric_snapshots` is the persistence layer — live Google/Redshift fetches keep no history, so anything wanting "ROAS over a period" reads snapshots.

### YouTube uploader
- Orchestrator pattern in `services/youtube/` — a `youtube_jobs` row spawns `youtube_job_rows`, processed by a fire-and-forget background loop. Uses YouTube's **resumable upload** with 8 MiB chunks streamed directly from Drive (no buffering); retries on 5xx/network.
- Multi-channel via env: `YT_REFRESH_TOKEN` → key `"default"`, `YT_REFRESH_TOKEN_<SUFFIX>` → key `suffix.toLowerCase()`. `getYoutubeChannels()` in `config.ts` discovers them dynamically — to add a channel, just set the env var and restart.
- Refresh tokens are obtained via `server/scripts/yt-oauth.ts` (interactive: opens browser, listens on `localhost:8765/callback`). This uses **standard Google OAuth**, not the AdYogi proxy — uses `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
- Preferred path is the **in-app web consent flow** (`routes/youtube-auth.ts`, `services/youtube/{channels,oauth-state}.ts`): brand-scoped tokens stored in `youtube_channel_auth`, keyed `yt:<channel_id>`. Needs `PUBLIC_BASE_URL` + `OAUTH_STATE_SECRET` in `.env`; callback is mounted public (Google is the caller, signed `state` is the CSRF proof). `listConfiguredChannels()` merges DB + env channels. See `docs/youtube-uploader.md`.

### MCP server
`server/src/routes/mcp.ts` exposes the read-only side of the tool over MCP at `/mcp` (mounted **outside** `/api/*` so the session-cookie auth middleware doesn't block it). Token-gated via `MCP_SECRET` if set.

### Auth
Cookie-session, server-side state. `requireAuth` middleware (`middleware/auth.ts`) reads the `session` cookie, joins `sessions` → `users`. Single admin user is bootstrapped from `ADMIN_USERNAME` / `ADMIN_PASSWORD` on first DB init.
