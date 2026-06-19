import pg from 'pg';
import { config } from '../config.js';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  if (!config.REDSHIFT_HOST || !config.REDSHIFT_DB || !config.REDSHIFT_USER || !config.REDSHIFT_PASSWORD) {
    throw new Error('Redshift not configured — set REDSHIFT_HOST/PORT/DB/USER/PASSWORD in .env');
  }
  pool = new pg.Pool({
    host: config.REDSHIFT_HOST,
    port: config.REDSHIFT_PORT ?? 5439,
    database: config.REDSHIFT_DB,
    user: config.REDSHIFT_USER,
    password: config.REDSHIFT_PASSWORD,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });
  pool.on('error', (err) => {
    console.error('[redshift] pool error:', err.message);
    pool = null;
  });
  return pool;
}

export async function testConnection(): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

export interface FunnelMetricsByCampaign {
  utm_source: string;
  utm_campaign: string;
  ncs: number;            // converted (post-RTO new customers)
  amount: number;         // converted_amount (post-RTO revenue)
  prepaid_purchases: number;
  total_purchases: number;
  prepaid_pct: number;
}

export interface FunnelMetricsTotal {
  ncs: number;
  amount: number;
  prepaid_purchases: number;
  total_purchases: number;
  prepaid_pct: number;
  rows: number;
}

export interface FetchOptions {
  funnelTable: string;             // e.g. 'mw_nexus.lj_google_funnel_daily'
  utmSourceList: string[];         // e.g. ['google_Pmax','google_Search','google_DG','google_pla','google']
  dateFrom: string;                // 'YYYY-MM-DD'
  dateTo: string;                  // 'YYYY-MM-DD'
}

/**
 * Build a SQL fragment that matches any utm_source pattern in the list.
 * Patterns containing '%' or '_' are treated as ILIKE; otherwise as exact match.
 * Falls back to a plain `false` clause when the list is empty so callers don't
 * accidentally fetch all rows.
 */
function utmSourceClause(list: string[], paramOffset: number): { sql: string; params: string[] } {
  if (!list.length) return { sql: 'false', params: [] };
  const parts = list.map((_, i) => `utm_source ILIKE $${paramOffset + i}`);
  return { sql: '(' + parts.join(' OR ') + ')', params: list };
}

/** Fetch per-(utm_source, utm_campaign) metrics aggregated over the date range. */
export async function fetchByCampaign(opts: FetchOptions): Promise<FunnelMetricsByCampaign[]> {
  const client = await getPool().connect();
  try {
    const { sql: srcSql, params: srcParams } = utmSourceClause(opts.utmSourceList, 3);
    const sql = `
      SELECT
        utm_source,
        utm_campaign,
        SUM(converted)::BIGINT                                                   AS ncs,
        SUM(COALESCE(converted_amount, 0))::FLOAT                                AS amount,
        SUM(CASE WHEN payment_mode <> 'checkmo' AND payment_mode IS NOT NULL THEN converted ELSE 0 END)::BIGINT AS prepaid_purchases,
        SUM(converted)::BIGINT                                                   AS total_purchases,
        CASE WHEN SUM(converted) > 0
             THEN SUM(CASE WHEN payment_mode <> 'checkmo' AND payment_mode IS NOT NULL THEN converted ELSE 0 END)::FLOAT / SUM(converted)
             ELSE 0 END                                                          AS prepaid_pct
      FROM ${opts.funnelTable}
      WHERE dt BETWEEN $1 AND $2
        AND ${srcSql}
      GROUP BY utm_source, utm_campaign
    `;
    const result = await client.query(sql, [opts.dateFrom, opts.dateTo, ...srcParams]);
    return result.rows.map((r) => ({
      utm_source: String(r.utm_source),
      utm_campaign: String(r.utm_campaign),
      ncs: Number(r.ncs ?? 0),
      amount: Number(r.amount ?? 0),
      prepaid_purchases: Number(r.prepaid_purchases ?? 0),
      total_purchases: Number(r.total_purchases ?? 0),
      prepaid_pct: Number(r.prepaid_pct ?? 0),
    }));
  } finally {
    client.release();
  }
}

/** Fetch per-day brand-wide aggregates — used by the Daily view. */
export async function fetchDaily(opts: FetchOptions): Promise<Array<{ date: string; ncs: number; amount: number }>> {
  const client = await getPool().connect();
  try {
    const { sql: srcSql, params: srcParams } = utmSourceClause(opts.utmSourceList, 3);
    const sql = `
      SELECT
        dt::text                                                                 AS date,
        SUM(converted)::BIGINT                                                   AS ncs,
        SUM(COALESCE(converted_amount, 0))::FLOAT                                AS amount
      FROM ${opts.funnelTable}
      WHERE dt BETWEEN $1 AND $2
        AND ${srcSql}
      GROUP BY dt
      ORDER BY dt
    `;
    const r = await client.query(sql, [opts.dateFrom, opts.dateTo, ...srcParams]);
    return r.rows.map((x) => ({ date: String(x.date), ncs: Number(x.ncs ?? 0), amount: Number(x.amount ?? 0) }));
  } finally {
    client.release();
  }
}

/** Fetch a single brand-wide total (no grouping). */
export async function fetchTotal(opts: FetchOptions): Promise<FunnelMetricsTotal> {
  const client = await getPool().connect();
  try {
    const { sql: srcSql, params: srcParams } = utmSourceClause(opts.utmSourceList, 3);
    const sql = `
      SELECT
        SUM(converted)::BIGINT                                                   AS ncs,
        SUM(COALESCE(converted_amount, 0))::FLOAT                                AS amount,
        SUM(CASE WHEN payment_mode <> 'checkmo' AND payment_mode IS NOT NULL THEN converted ELSE 0 END)::BIGINT AS prepaid_purchases,
        SUM(converted)::BIGINT                                                   AS total_purchases,
        COUNT(*)::BIGINT                                                         AS rows
      FROM ${opts.funnelTable}
      WHERE dt BETWEEN $1 AND $2
        AND ${srcSql}
    `;
    const r = (await client.query(sql, [opts.dateFrom, opts.dateTo, ...srcParams])).rows[0];
    const ncs = Number(r?.ncs ?? 0);
    const prepaid = Number(r?.prepaid_purchases ?? 0);
    return {
      ncs,
      amount: Number(r?.amount ?? 0),
      prepaid_purchases: prepaid,
      total_purchases: ncs,
      prepaid_pct: ncs > 0 ? prepaid / ncs : 0,
      rows: Number(r?.rows ?? 0),
    };
  } finally {
    client.release();
  }
}
