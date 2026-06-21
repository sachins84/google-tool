// Establish the timeline: when did Search_Brand_MM last serve impressions
// in Google Ads, vs when do utm_campaign='Search_Brand_MM' rows appear in
// the Redshift funnel table? If campaign hasn't served for weeks but Redshift
// has fresh NCs every day, that's hard proof of out-of-band traffic source.
import { config } from '../src/config.js';
import { initDatabase } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';
import pg from 'pg';

const PAUSED_ID = '9250997199';   // Search_Brand_MM
const ACTIVE_ID = '22580437328';  // Search_Brand

(async () => {
  initDatabase();
  const brand = getBrand(3);
  if (!brand) return;

  console.log(`\n══════════════ Search_Brand_MM (${PAUSED_ID}) timeline ══════════════\n`);

  // 1) Pull Google Ads history: per-day spend/impressions/clicks for last 60 days
  let lastServed: string | null = null;
  let activeSpendByDate = new Map<string, number>();
  for (const acc of brand.accounts) {
    try {
      const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
      const rows = await search<{ campaign?: { id?: string }; segments?: { date?: string }; metrics?: { costMicros?: string; impressions?: string; clicks?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks
                FROM campaign
                WHERE segments.date BETWEEN '2026-04-01' AND '2026-06-20'
                  AND campaign.id IN (${PAUSED_ID}, ${ACTIVE_ID})`,
      });
      for (const r of rows) {
        const cid = r.campaign?.id; const d = r.segments?.date;
        const cost = Number(r.metrics?.costMicros ?? 0) / 1_000_000;
        const impr = Number(r.metrics?.impressions ?? 0);
        if (!cid || !d) continue;
        if (cid === PAUSED_ID && (cost > 0 || impr > 0)) {
          if (!lastServed || d > lastServed) lastServed = d;
        }
        if (cid === ACTIVE_ID) activeSpendByDate.set(d, (activeSpendByDate.get(d) ?? 0) + cost);
      }
    } catch (e) { /* */ }
  }
  console.log(`  Search_Brand_MM last day with cost > 0 OR impressions > 0: ${lastServed ?? 'NEVER in last 80 days'}`);
  // First active Search_Brand date
  const activeDates = [...activeSpendByDate.keys()].sort();
  console.log(`  Search_Brand (active replacement) first spend day in window: ${activeDates[0] ?? '?'}`);

  // 2) Redshift: utm_campaign='Search_Brand_MM' rows per day for last 30 days
  const pool = new pg.Pool({
    host: config.REDSHIFT_HOST, port: config.REDSHIFT_PORT ?? 5439,
    database: config.REDSHIFT_DB, user: config.REDSHIFT_USER, password: config.REDSHIFT_PASSWORD,
    ssl: { rejectUnauthorized: false }, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000,
  });
  const c = await pool.connect();
  try {
    const r = (await c.query(
      `SELECT dt::text AS d, utm_source, SUM(converted)::BIGINT AS ncs, SUM(COALESCE(converted_amount,0))::FLOAT AS amount
       FROM mw_nexus.mm_google_funnel_daily
       WHERE dt BETWEEN '2026-05-25' AND '2026-06-20'
         AND utm_campaign = 'Search_Brand_MM'
       GROUP BY dt, utm_source
       ORDER BY dt`,
    )).rows;
    console.log(`\n  Redshift mm_google_funnel_daily: utm_campaign='Search_Brand_MM' per day (last ~27 days):`);
    console.log(`    ${'Date'.padEnd(12)} ${'utm_source'.padEnd(14)} ${'NCs'.padStart(6)} ${'Amount'.padStart(13)}`);
    let totalNcs = 0, totalAmt = 0;
    for (const x of r) {
      totalNcs += Number(x.ncs); totalAmt += Number(x.amount);
      console.log(`    ${x.d.padEnd(12)} ${x.utm_source.padEnd(14)} ${String(x.ncs).padStart(6)} ${('₹' + Math.round(Number(x.amount)).toLocaleString('en-IN')).padStart(13)}`);
    }
    console.log(`    ${'─'.repeat(50)}`);
    console.log(`    Total over 27d: ${totalNcs} NCs / ₹${Math.round(totalAmt).toLocaleString('en-IN')}\n`);

    // Days since campaign last served (or "never" indicator)
    if (lastServed) {
      const daysSince = (Date.parse('2026-06-20') - Date.parse(lastServed)) / (1000 * 60 * 60 * 24);
      console.log(`  ⚠ DISCONNECT: campaign last served ${Math.round(daysSince)} days ago, but Redshift has ${totalNcs} NCs with that utm_campaign in the past 27 days.`);
    } else {
      console.log(`  ⚠ DISCONNECT: campaign hasn't served impressions in the last 80 days, but Redshift records ${totalNcs} new conversions with that utm_campaign.`);
    }
    console.log(`     These NCs cannot be from clicks on Search_Brand_MM ads (the campaign hasn't been serving).`);
  } finally {
    c.release(); await pool.end();
  }
})().catch((e) => { console.error('ERR', e); process.exit(1); });
