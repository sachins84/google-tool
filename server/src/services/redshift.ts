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
  funnelTable: string;             // e.g. 'mw_nexus.lj_funnel_daily'
  utmSourceList: string[];         // e.g. ['google_Pmax','google_Search','google_DG','google_pla','google']
  dateFrom: string;                // 'YYYY-MM-DD'
  dateTo: string;                  // 'YYYY-MM-DD'
}

/** Fetch per-utm_campaign metrics aggregated over the date range. */
export async function fetchByCampaign(opts: FetchOptions): Promise<FunnelMetricsByCampaign[]> {
  const client = await getPool().connect();
  try {
    const placeholders = opts.utmSourceList.map((_, i) => `$${i + 3}`).join(', ');
    const sql = `
      SELECT
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
        AND utm_source IN (${placeholders})
        AND utm_campaign IS NOT NULL AND utm_campaign <> ''
      GROUP BY utm_campaign
    `;
    const result = await client.query(sql, [opts.dateFrom, opts.dateTo, ...opts.utmSourceList]);
    return result.rows.map((r) => ({
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

/** Fetch a single brand-wide total (no grouping). */
export async function fetchTotal(opts: FetchOptions): Promise<FunnelMetricsTotal> {
  const client = await getPool().connect();
  try {
    const placeholders = opts.utmSourceList.map((_, i) => `$${i + 3}`).join(', ');
    const sql = `
      SELECT
        SUM(converted)::BIGINT                                                   AS ncs,
        SUM(COALESCE(converted_amount, 0))::FLOAT                                AS amount,
        SUM(CASE WHEN payment_mode <> 'checkmo' AND payment_mode IS NOT NULL THEN converted ELSE 0 END)::BIGINT AS prepaid_purchases,
        SUM(converted)::BIGINT                                                   AS total_purchases,
        COUNT(*)::BIGINT                                                         AS rows
      FROM ${opts.funnelTable}
      WHERE dt BETWEEN $1 AND $2
        AND utm_source IN (${placeholders})
    `;
    const r = (await client.query(sql, [opts.dateFrom, opts.dateTo, ...opts.utmSourceList])).rows[0];
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
