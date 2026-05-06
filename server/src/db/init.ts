import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config, dbPath } from '../config.js';

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
  `);

  bootstrapAdmin(db);
  bootstrapDefaultBrand(db);

  return db;
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
  if (existing) return;

  const result = database.prepare(
    'INSERT INTO brands (name, rto_factor, rto_mode) VALUES (?, ?, ?)'
  ).run('Little Joys', 0, 'flat');
  database.prepare(
    'INSERT INTO brand_accounts (brand_id, customer_id, customer_name) VALUES (?, ?, ?)'
  ).run(result.lastInsertRowid, '4812797582', 'Little Joys');
  console.log('[init] Seeded default brand: Little Joys → 4812797582');
}
