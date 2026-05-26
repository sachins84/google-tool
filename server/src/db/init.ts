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
  `);

  // Idempotent column adds — safe for already-initialised DBs
  try { db.exec('ALTER TABLE brands ADD COLUMN revenue_rto_factor REAL'); } catch { /* already exists */ }
  // utm_campaign_aliases: JSON record { "IBK": "Immunity Boosting Kit", ... } —
  // maps a raw utm_campaign value to a target asset_group / campaign name.
  try { db.exec('ALTER TABLE brand_redshift_config ADD COLUMN utm_campaign_aliases TEXT'); } catch { /* already exists */ }

  bootstrapAdmin(db);
  bootstrapDefaultBrand(db);
  applyBrandPresetsToExistingBrands(db);

  return db;
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
          'mw_nexus.lj_funnel_daily',
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
    'mw_nexus.lj_funnel_daily',
    JSON.stringify(['google_Pmax', 'google_Search', 'google_DG', 'google_pla', 'google_Pmax_RM', 'google']),
    'mixed'
  );
  console.log('[init] Seeded Little Joys → 4812797582 with Redshift RTO mode (mw_nexus.lj_funnel_daily)');
}
