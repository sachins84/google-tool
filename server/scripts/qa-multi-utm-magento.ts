// The Google Ads Expanded-Landing-Page report for PMax_Brain and Calcium Gummies-02
// (campaign_id 23847924713) shows that the URL Google appends carries BOTH:
//   utm_campaign=Calcium_Gummies           (asset_group name, position 1)
//   utm_campaign=23847924713               (campaign_id, position 2)
// Standard query-string parsing keeps the LAST value (campaign_id), but some
// parsers (PHP/Magento's default) keep the FIRST. This script queries Redshift
// directly to see which value Magento actually wrote to the funnel table for
// THIS campaign across THIS window. Tells us if we have a parser-side issue.
import { config } from '../src/config.js';
import pg from 'pg';

const FROM = '2026-06-12';
const TO = '2026-06-20';
const TARGET_CAMPAIGN_ID = '23847924713';                 // PMax_Brain and Calcium Gummies-02
const TARGET_ASSET_GROUP = 'Calcium_Gummies';

const pool = new pg.Pool({
  host: config.REDSHIFT_HOST,
  port: config.REDSHIFT_PORT ?? 5439,
  database: config.REDSHIFT_DB,
  user: config.REDSHIFT_USER,
  password: config.REDSHIFT_PASSWORD,
  ssl: { rejectUnauthorized: false }, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000,
});

const inr = (n: number): string => '₹' + Math.round(n).toLocaleString('en-IN');

(async () => {
  const c = await pool.connect();
  try {
    console.log(`\n════════════ LJ funnel: rows for PMax_Brain and Calcium Gummies-02 ════════════`);
    console.log(`Target campaign_id: ${TARGET_CAMPAIGN_ID}`);
    console.log(`Target asset_group: ${TARGET_ASSET_GROUP}`);
    console.log(`Window: ${FROM}..${TO}\n`);

    // 1) Does Magento ever write the campaign_id form?
    const byId = (await c.query(
      `SELECT dt::text AS d, utm_source, utm_campaign,
              SUM(converted)::BIGINT AS ncs,
              SUM(COALESCE(converted_amount,0))::FLOAT AS amount,
              COUNT(*) AS rows
       FROM mw_nexus.lj_google_funnel_daily
       WHERE dt BETWEEN $1 AND $2
         AND utm_campaign = $3
       GROUP BY dt, utm_source, utm_campaign
       ORDER BY dt`,
      [FROM, TO, TARGET_CAMPAIGN_ID]
    )).rows;
    console.log(`── Rows where utm_campaign = '${TARGET_CAMPAIGN_ID}' (numeric campaign_id form) ──`);
    if (!byId.length) { console.log('  NONE — Magento never writes the campaign_id to utm_campaign for these orders.\n'); }
    else {
      for (const r of byId) console.log(`  ${r.d}  ${r.utm_source.padEnd(20)} ncs=${r.ncs} amount=${inr(Number(r.amount))}`);
      console.log();
    }

    // 2) Does it write the asset_group form?
    const byAg = (await c.query(
      `SELECT dt::text AS d, utm_source, utm_campaign,
              SUM(converted)::BIGINT AS ncs,
              SUM(COALESCE(converted_amount,0))::FLOAT AS amount,
              COUNT(*) AS rows
       FROM mw_nexus.lj_google_funnel_daily
       WHERE dt BETWEEN $1 AND $2
         AND utm_campaign = $3
       GROUP BY dt, utm_source, utm_campaign
       ORDER BY dt`,
      [FROM, TO, TARGET_ASSET_GROUP]
    )).rows;
    console.log(`── Rows where utm_campaign = '${TARGET_ASSET_GROUP}' (asset_group-name form) ──`);
    if (!byAg.length) console.log('  NONE.\n');
    else {
      for (const r of byAg) console.log(`  ${r.d}  ${r.utm_source.padEnd(20)} ncs=${r.ncs} amount=${inr(Number(r.amount))}`);
      console.log();
    }

    // 3) Look for any pattern with the campaign_id embedded
    const embedded = (await c.query(
      `SELECT utm_source, utm_campaign, SUM(converted)::BIGINT AS ncs
       FROM mw_nexus.lj_google_funnel_daily
       WHERE dt BETWEEN $1 AND $2
         AND (utm_campaign LIKE '%' || $3 || '%' OR utm_source LIKE '%' || $3 || '%')
         AND utm_campaign <> $3
       GROUP BY utm_source, utm_campaign
       ORDER BY ncs DESC LIMIT 20`,
      [FROM, TO, TARGET_CAMPAIGN_ID]
    )).rows;
    console.log(`── Rows with '${TARGET_CAMPAIGN_ID}' embedded somewhere (concatenated URL artefact) ──`);
    if (!embedded.length) console.log('  NONE — campaign_id never appears as a substring in either field.\n');
    else {
      for (const r of embedded) console.log(`  src="${(r.utm_source || '').slice(0, 60)}"  utm="${(r.utm_campaign || '').slice(0, 60)}"  ncs=${r.ncs}`);
      console.log();
    }

    // 4) Distinct utm_campaign value sample sizes for THIS campaign's pattern
    // (does Magento split out multiple utm_campaign values into separate rows
    //  somehow? e.g. one row with the first value and another with the second?)
    const allLjUtmShape = (await c.query(
      `SELECT
         SUM(CASE WHEN utm_campaign ~ '^[0-9]+$' THEN 1 ELSE 0 END) AS numeric_rows,
         SUM(CASE WHEN utm_campaign ~ '^[0-9]+$' THEN converted ELSE 0 END) AS numeric_ncs,
         SUM(CASE WHEN utm_campaign !~ '^[0-9]+$' THEN 1 ELSE 0 END) AS non_numeric_rows,
         SUM(CASE WHEN utm_campaign !~ '^[0-9]+$' THEN converted ELSE 0 END) AS non_numeric_ncs
       FROM mw_nexus.lj_google_funnel_daily
       WHERE dt BETWEEN $1 AND $2
         AND utm_source ILIKE 'google_Pmax%'`,
      [FROM, TO]
    )).rows[0];
    console.log(`── Brand-wide LJ PMax shape ──`);
    console.log(`  numeric (campaign_id form):     ${allLjUtmShape.numeric_rows} rows · ${allLjUtmShape.numeric_ncs} NCs`);
    console.log(`  non-numeric (name/asset_group): ${allLjUtmShape.non_numeric_rows} rows · ${allLjUtmShape.non_numeric_ncs} NCs`);

    // 5) Top non-numeric values — proof of what Magento writes
    const topNames = (await c.query(
      `SELECT utm_campaign, SUM(converted)::BIGINT AS ncs, SUM(COALESCE(converted_amount,0))::FLOAT AS amount
       FROM mw_nexus.lj_google_funnel_daily
       WHERE dt BETWEEN $1 AND $2
         AND utm_source ILIKE 'google_Pmax%'
         AND utm_campaign !~ '^[0-9]+$'
       GROUP BY utm_campaign
       ORDER BY ncs DESC LIMIT 15`,
      [FROM, TO]
    )).rows;
    console.log(`\n── Top non-numeric utm_campaign values landing in LJ PMax (the asset-group form Magento picked) ──`);
    for (const r of topNames) {
      console.log(`  utm_campaign="${(r.utm_campaign || '').slice(0,40).padEnd(40)}"  ncs=${String(r.ncs).padStart(4)}  ${inr(Number(r.amount)).padStart(12)}`);
    }
  } finally {
    c.release(); await pool.end();
  }
})().catch((e) => { console.error('ERR', e); process.exit(1); });
