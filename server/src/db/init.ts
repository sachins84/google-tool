import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config, dbPath } from '../config.js';
import { getBrandPreset } from '../config/brand-presets.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized — call initDatabase() first');
  return db;
}

export function initDatabase(): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- App layer
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Brand layer (user-managed via Settings tab)
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      rto_factor REAL DEFAULT 0,
      revenue_rto_factor REAL,
      rto_mode TEXT DEFAULT 'flat',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS brand_accounts (
      brand_id INTEGER NOT NULL,
      customer_id TEXT NOT NULL,
      customer_name TEXT,
      PRIMARY KEY (brand_id, customer_id),
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );

    -- Google Ads entity cache
    CREATE TABLE IF NOT EXISTS google_ads_campaigns (
      customer_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      name TEXT,
      status TEXT,
      channel_type TEXT,
      bidding_strategy_type TEXT,
      target_roas REAL,
      target_cpa_micros INTEGER,
      daily_budget_micros INTEGER,
      start_date TEXT,
      end_date TEXT,
      fetched_at INTEGER,
      PRIMARY KEY (customer_id, campaign_id)
    );

    CREATE TABLE IF NOT EXISTS google_ads_ad_groups (
      customer_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      ad_group_id TEXT NOT NULL,
      name TEXT,
      status TEXT,
      type TEXT,
      cpc_bid_micros INTEGER,
      target_cpa_micros INTEGER,
      fetched_at INTEGER,
      PRIMARY KEY (customer_id, ad_group_id)
    );

    CREATE TABLE IF NOT EXISTS google_ads_ads (
      customer_id TEXT NOT NULL,
      ad_group_id TEXT NOT NULL,
      ad_id TEXT NOT NULL,
      type TEXT,
      status TEXT,
      headlines_json TEXT,
      descriptions_json TEXT,
      final_urls_json TEXT,
      fetched_at INTEGER,
      PRIMARY KEY (customer_id, ad_id)
    );

    CREATE TABLE IF NOT EXISTS google_ads_keywords (
      customer_id TEXT NOT NULL,
      ad_group_id TEXT NOT NULL,
      criterion_id TEXT NOT NULL,
      text TEXT,
      match_type TEXT,
      status TEXT,
      quality_score INTEGER,
      first_page_cpc_micros INTEGER,
      top_of_page_cpc_micros INTEGER,
      fetched_at INTEGER,
      PRIMARY KEY (customer_id, ad_group_id, criterion_id)
    );

    CREATE TABLE IF NOT EXISTS google_ads_assets (
      customer_id TEXT NOT NULL,
      asset_group_id TEXT,
      ad_group_id TEXT,
      asset_id TEXT NOT NULL,
      type TEXT,
      performance_label TEXT,
      text TEXT,
      image_url TEXT,
      fetched_at INTEGER,
      PRIMARY KEY (customer_id, asset_id, asset_group_id, ad_group_id)
    );

    -- Daily metrics (level ∈ campaign | ad_group | ad | keyword | asset)
    CREATE TABLE IF NOT EXISTS google_ads_metrics_daily (
      customer_id TEXT NOT NULL,
      level TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      date TEXT NOT NULL,
      cost_micros INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      conversions REAL DEFAULT 0,
      conversions_value REAL DEFAULT 0,
      view_through_conversions REAL DEFAULT 0,
      search_impression_share REAL,
      fetched_at INTEGER,
      PRIMARY KEY (customer_id, level, entity_id, date)
    );

    -- Redshift integration (placeholder; dormant until creds + funnel table set)
    CREATE TABLE IF NOT EXISTS brand_redshift_config (
      brand_id INTEGER PRIMARY KEY,
      funnel_table TEXT,
      utm_source_list TEXT,
      utm_campaign_format TEXT,
      enabled INTEGER DEFAULT 0,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS google_ads_redshift_metrics (
      brand_id INTEGER NOT NULL,
      customer_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      ad_group_id TEXT DEFAULT '',
      ad_id TEXT DEFAULT '',
      date TEXT NOT NULL,
      new_customers INTEGER DEFAULT 0,
      total_purchases INTEGER DEFAULT 0,
      prepaid_purchases INTEGER DEFAULT 0,
      amount_inr REAL DEFAULT 0,
      prepaid_pct REAL DEFAULT 0,
      fetched_at INTEGER,
      PRIMARY KEY (brand_id, customer_id, campaign_id, ad_group_id, ad_id, date)
    );

    CREATE TABLE IF NOT EXISTS redshift_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      rows_pulled INTEGER,
      error TEXT
    );

    -- Audit log for mutations
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      brand_id INTEGER,
      customer_id TEXT,
      target_resource TEXT,
      before_json TEXT,
      after_json TEXT,
      dry_run INTEGER DEFAULT 0,
      response_json TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    -- Generic query cache
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- YouTube uploader jobs
    CREATE TABLE IF NOT EXISTS youtube_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      channel_key TEXT NOT NULL,
      channel_label TEXT,
      sheet_id TEXT NOT NULL,
      sheet_tab TEXT,
      privacy_status TEXT DEFAULT 'unlisted',
      status TEXT DEFAULT 'pending',  -- pending|running|completed|failed|cancelled
      total_rows INTEGER DEFAULT 0,
      done_rows INTEGER DEFAULT 0,
      error_rows INTEGER DEFAULT 0,
      error TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      started_at INTEGER,
      finished_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS youtube_job_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      sheet_row INTEGER NOT NULL,
      drive_link TEXT,
      drive_file_id TEXT,
      title TEXT,
      description TEXT,
      tags TEXT,
      bytes_total INTEGER,
      bytes_uploaded INTEGER DEFAULT 0,
      youtube_video_id TEXT,
      youtube_url TEXT,
      status TEXT DEFAULT 'pending', -- pending|uploading|done|error|skipped
      error TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      FOREIGN KEY (job_id) REFERENCES youtube_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_yt_rows_job ON youtube_job_rows(job_id);

    -- Cached channel metadata (channelId, snippet.title) keyed by env channel key
    CREATE TABLE IF NOT EXISTS youtube_channels (
      key TEXT PRIMARY KEY,
      channel_id TEXT,
      title TEXT,
      thumbnail TEXT,
      fetched_at INTEGER
    );

    -- ════════════════════════════════════════════════════════════════════
    -- Recommender system (portfolio = brand). All in-process, no external AI.
    -- ════════════════════════════════════════════════════════════════════

    -- One row per (brand, day) generation run. UNIQUE(brand_id, run_date) is the
    -- dedupe lock the scheduler relies on to avoid duplicate daily runs.
    CREATE TABLE IF NOT EXISTS recommendation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      run_date TEXT NOT NULL,                 -- 'YYYY-MM-DD'
      trigger TEXT DEFAULT 'scheduled',       -- scheduled | manual
      status TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
      portfolio_target_roas REAL,
      current_blended_roas REAL,
      projected_blended_roas REAL,
      target_reachable INTEGER,
      config_json TEXT,
      notes TEXT,
      error TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE (brand_id, run_date),
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );

    -- One row per candidate action. source distinguishes the raw rules engine
    -- from the adaptive (feedback-weighted) engine for the manual-vs-AI view.
    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      brand_id INTEGER NOT NULL,
      source TEXT NOT NULL,                   -- 'rules' | 'engine'
      level TEXT NOT NULL,                    -- campaign|ad_group|asset_group|ad|keyword
      customer_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_name TEXT,                       -- aggregate label only, no PII
      mutate_action TEXT NOT NULL,            -- maps to /api/mutate; 'monitor' = no-op
      mutate_payload_json TEXT NOT NULL,      -- exact POST /api/mutate body (minus dry_run)
      current_json TEXT,
      proposed_json TEXT,
      score REAL,
      confidence REAL,
      expected_impact_json TEXT,
      hard_constraints_json TEXT,
      reason_codes_json TEXT,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|overridden|executed|expired|superseded
      audit_log_id INTEGER,                   -- set when executed → joins audit_log
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (run_id) REFERENCES recommendation_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rec_run ON recommendations(run_id);
    CREATE INDEX IF NOT EXISTS idx_rec_brand_status ON recommendations(brand_id, status);

    -- Guardrails. origin='default' seeded per brand; 'manual' from the rule builder.
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER,                       -- NULL = global default
      origin TEXT NOT NULL,                   -- 'default' | 'manual'
      kind TEXT NOT NULL,                     -- floor | cap | weight | exclusion | preference
      scope_level TEXT,                       -- campaign|asset_group|keyword|ad|portfolio
      json TEXT NOT NULL,                     -- { metric, channel?, value, comparator? }
      weight REAL DEFAULT 1.0,
      enabled INTEGER DEFAULT 1,
      is_hard INTEGER DEFAULT 0,              -- 1 = inviolable; feedback never relaxes it
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rules_brand ON rules(brand_id, enabled);

    -- One row per user decision on a recommendation.
    CREATE TABLE IF NOT EXISTS recommendation_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recommendation_id INTEGER NOT NULL,
      user_id INTEGER,
      decision TEXT NOT NULL,                 -- accepted | rejected | overridden
      override_payload_json TEXT,
      reason TEXT,
      reason_codes_json TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (recommendation_id) REFERENCES recommendations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_fb_rec ON recommendation_feedback(recommendation_id);

    -- Metric snapshots — the persistence layer for trend / over-time evaluation.
    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      snapshot_date TEXT NOT NULL,            -- 'YYYY-MM-DD' the snapshot was taken
      window TEXT NOT NULL,                   -- '1d'|'7d'|'14d'|'30d'
      level TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_name TEXT,
      cost REAL, conversions REAL, conversions_value REAL,
      roas_pre_rto REAL, roas_post_rto REAL,
      ncs REAL, ncs_amount REAL, calc_roas REAL,  -- null below campaign level
      daily_budget_inr REAL, target_roas REAL, bidding_strategy_type TEXT,
      channel_type TEXT, ad_strength TEXT, search_impression_share REAL,
      search_budget_lost_impression_share REAL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE (brand_id, snapshot_date, window, level, customer_id, entity_id),
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_snap_brand_date ON metric_snapshots(brand_id, snapshot_date, level);

    -- Per-(rule, reason_code) acceptance learning state (EWMA).
    CREATE TABLE IF NOT EXISTS rule_weight_state (
      rule_id INTEGER NOT NULL,
      reason_code TEXT NOT NULL,
      accepts INTEGER DEFAULT 0,
      rejects INTEGER DEFAULT 0,
      overrides INTEGER DEFAULT 0,
      ewma_acceptance REAL DEFAULT 0.5,
      last_updated INTEGER,
      PRIMARY KEY (rule_id, reason_code),
      FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE CASCADE
    );

    -- Date-stamped comments on a recommendation, so rationale can be backtracked.
    CREATE TABLE IF NOT EXISTS recommendation_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recommendation_id INTEGER NOT NULL,
      user_id INTEGER,
      username TEXT,
      comment TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (recommendation_id) REFERENCES recommendations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reccomment_rec ON recommendation_comments(recommendation_id);
  `);

  // Recommender follow-on columns (idempotent — safe on existing DBs)
  try { db.exec("ALTER TABLE recommendations ADD COLUMN bucket TEXT"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE recommendations ADD COLUMN user_action TEXT"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE recommendations ADD COLUMN diagnosis TEXT"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE recommendation_runs ADD COLUMN eval_window_days INTEGER"); } catch { /* exists */ }

  // Idempotent column adds — safe for already-initialised DBs
  try { db.exec('ALTER TABLE brands ADD COLUMN revenue_rto_factor REAL'); } catch { /* already exists */ }
  // utm_campaign_aliases: JSON record { "IBK": "Immunity Boosting Kit", ... } —
  // maps a raw utm_campaign value to a target asset_group / campaign name.
  try { db.exec('ALTER TABLE brand_redshift_config ADD COLUMN utm_campaign_aliases TEXT'); } catch { /* already exists */ }

  bootstrapAdmin(db);
  bootstrapDefaultBrand(db);
  applyBrandPresetsToExistingBrands(db);
  seedDefaultRules(db);

  return db;
}

/**
 * Seed a baseline guardrail set for any brand that has none. Idempotent — only
 * inserts when a brand has zero rules, so manual edits are never clobbered.
 * These default rows ARE the OptimizerConfig: the portfolio target + per-level
 * ROAS floors + the per-run budget step cap. Floors/caps are is_hard=1 so the
 * feedback loop can never relax them.
 */
function seedDefaultRules(database: Database.Database): void {
  const brands = database.prepare('SELECT id FROM brands').all() as Array<{ id: number }>;
  const insert = database.prepare(
    `INSERT INTO rules (brand_id, origin, kind, scope_level, json, weight, enabled, is_hard)
     VALUES (?, 'default', ?, ?, ?, 1.0, 1, ?)`
  );
  for (const b of brands) {
    const has = database.prepare('SELECT 1 FROM rules WHERE brand_id = ? LIMIT 1').get(b.id);
    if (has) continue;
    const defaults: Array<[string, string, Record<string, unknown>, number]> = [
      ['preference', 'portfolio',   { metric: 'roas_post_rto', value: 4.0 }, 1],
      ['floor',      'campaign',    { metric: 'roas_post_rto', value: 2.0 }, 1],
      ['floor',      'asset_group', { metric: 'roas_post_rto', value: 2.0 }, 1],
      ['floor',      'keyword',     { metric: 'roas_post_rto', value: 1.5 }, 1],
      ['floor',      'ad',          { metric: 'roas_post_rto', value: 1.5 }, 1],
      ['cap',        'campaign',    { metric: 'budget_step_pct', value: 0.15 }, 1],
    ];
    for (const [kind, scope, json, isHard] of defaults) {
      insert.run(b.id, kind, scope, JSON.stringify(json), isHard);
    }
    console.log(`[init] Seeded default recommender guardrails for brand ${b.id}`);
  }
}

/**
 * Migration: walk all existing brands and (re)apply preset configs by name.
 * Idempotent — runs every server start. Lets users add a "Man Matters" brand
 * via Settings UI before the preset existed and still get auto-config.
 */
function applyBrandPresetsToExistingBrands(database: Database.Database): void {
  const brands = database.prepare('SELECT id, name, rto_mode FROM brands').all() as Array<{
    id: number; name: string; rto_mode: string;
  }>;
  for (const b of brands) {
    const preset = getBrandPreset(b.name);
    if (!preset) continue;
    database.prepare(
      `INSERT INTO brand_redshift_config (brand_id, funnel_table, utm_source_list, utm_campaign_format, enabled)
       VALUES (?, ?, ?, 'mixed', 1)
       ON CONFLICT(brand_id) DO UPDATE SET
         funnel_table = excluded.funnel_table,
         utm_source_list = excluded.utm_source_list,
         enabled = 1`
    ).run(b.id, preset.funnel_table, JSON.stringify(preset.utm_source_list));
    if (b.rto_mode === 'flat') {
      database.prepare(`UPDATE brands SET rto_mode = 'redshift' WHERE id = ?`).run(b.id);
      console.log(`[init] Auto-flipped ${b.name} → redshift mode (matched preset)`);
    }
  }
}

function bootstrapAdmin(database: Database.Database): void {
  const existing = database.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) return;

  const hash = bcrypt.hashSync(config.ADMIN_PASSWORD, 10);
  database.prepare(
    'INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, ?)'
  ).run(config.ADMIN_USERNAME, hash, 'admin', 'active');
  console.log(`[init] Admin user created: ${config.ADMIN_USERNAME}`);
}

function bootstrapDefaultBrand(database: Database.Database): void {
  const existing = database.prepare('SELECT id FROM brands LIMIT 1').get();
  if (existing) {
    // Idempotently ensure Little Joys has its Redshift config set even on existing DBs.
    const lj = database.prepare(`SELECT id FROM brands WHERE name = 'Little Joys'`).get() as
      | { id: number } | undefined;
    if (lj) {
      const cfg = database.prepare('SELECT brand_id FROM brand_redshift_config WHERE brand_id = ?').get(lj.id);
      if (!cfg) {
        database.prepare(
          `INSERT INTO brand_redshift_config (brand_id, funnel_table, utm_source_list, utm_campaign_format, enabled)
           VALUES (?, ?, ?, ?, 1)`
        ).run(
          lj.id,
          'mw_nexus.lj_google_funnel_daily',
          JSON.stringify(['google_Pmax', 'google_Search', 'google_DG', 'google_pla', 'google_Pmax_RM', 'google']),
          'mixed'
        );
        database.prepare(`UPDATE brands SET rto_mode = 'redshift' WHERE id = ?`).run(lj.id);
        console.log('[init] Migrated Little Joys to Redshift RTO mode');
      }
    }
    return;
  }

  const result = database.prepare(
    'INSERT INTO brands (name, rto_factor, rto_mode) VALUES (?, ?, ?)'
  ).run('Little Joys', 0, 'redshift');
  const brandId = result.lastInsertRowid as number;
  database.prepare(
    'INSERT INTO brand_accounts (brand_id, customer_id, customer_name) VALUES (?, ?, ?)'
  ).run(brandId, '4812797582', 'Little Joys');
  database.prepare(
    `INSERT INTO brand_redshift_config (brand_id, funnel_table, utm_source_list, utm_campaign_format, enabled)
     VALUES (?, ?, ?, ?, 1)`
  ).run(
    brandId,
    'mw_nexus.lj_google_funnel_daily',
    JSON.stringify(['google_Pmax', 'google_Search', 'google_DG', 'google_pla', 'google_Pmax_RM', 'google']),
    'mixed'
  );
  console.log('[init] Seeded Little Joys → 4812797582 with Redshift RTO mode (mw_nexus.lj_google_funnel_daily)');
}
