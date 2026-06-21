// Trace why Search_Brand_MM (PAUSED, ₹0 spend) is showing 154 NCs.
// Find all MM Search campaigns by name pattern, query Redshift for rows
// attributing to them, and surface what utm_campaign / utm_source values
// are driving the leak.
import { config } from '../src/config.js';
import { initDatabase, getDb } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';
import pg from 'pg';

const FROM = '2026-06-12';
const TO = '2026-06-20';

(async () => {
  initDatabase();
  const brand = getBrand(3); // MM
  if (!brand) { console.log('MM brand not found'); process.exit(1); }
  console.log(`\n══════════════ MM Search campaigns (status + id) ══════════════`);
  console.log(`Window: ${FROM}..${TO}\n`);

  // Find all MM Search campaigns
  const allSearch: Array<{ id: string; name: string; status: string; channel: string }> = [];
  for (const acc of brand.accounts) {
    try {
      const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
      const rows = await search<{ campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
                FROM campaign
                WHERE campaign.advertising_channel_type = 'SEARCH'
                  AND campaign.status != 'REMOVED'`,
      });
      for (const r of rows) {
        const name = (r.campaign?.name ?? '').toLowerCase();
        if (!r.campaign?.id) continue;
        if (!name.includes('brand')) continue;
        allSearch.push({
          id: r.campaign.id, name: r.campaign?.name ?? '',
          status: r.campaign?.status ?? '', channel: r.campaign?.advertisingChannelType ?? '',
        });
      }
    } catch (err) {
      console.error(`  account ${acc.customer_id}:`, err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`  Found ${allSearch.length} MM Search campaigns with 'Brand' in name:`);
  for (const c of allSearch) {
    console.log(`    ${c.id.padStart(12)}  ${c.name.padEnd(40)}  ${c.status}`);
  }

  // Also query window spend per these campaigns to know which are spending
  const spendByCid = new Map<string, number>();
  for (const acc of brand.accounts) {
    try {
      const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
      const ids = allSearch.map((c) => c.id);
      if (!ids.length) continue;
      const rows = await search<{ campaign?: { id?: string }; metrics?: { costMicros?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, metrics.cost_micros
                FROM campaign
                WHERE segments.date BETWEEN '${FROM}' AND '${TO}'
                  AND campaign.id IN (${ids.join(',')})`,
      });
      for (const r of rows) {
        const id = r.campaign?.id; if (!id) continue;
        spendByCid.set(id, (spendByCid.get(id) ?? 0) + Number(r.metrics?.costMicros ?? 0) / 1_000_000);
      }
    } catch { /* */ }
  }
  console.log(`\n  Window spend per campaign:`);
  for (const c of allSearch) {
    const sp = spendByCid.get(c.id) ?? 0;
    console.log(`    ${c.name.padEnd(40)}  ${c.status.padEnd(8)}  ${'₹' + Math.round(sp).toLocaleString('en-IN')}`);
  }

  // Get adIdToCampaignId map (Search uses {creative} → ad id → campaign)
  const ads = new Map<string, string>();
  for (const acc of brand.accounts) {
    try {
      const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
      const rows = await search<{ campaign?: { id?: string }; adGroupAd?: { ad?: { id?: string } } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, ad_group_ad.ad.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'`,
      });
      for (const r of rows) {
        const adId = r.adGroupAd?.ad?.id; const cid = r.campaign?.id;
        if (adId && cid) ads.set(adId, cid);
      }
    } catch { /* */ }
  }

  // Now query Redshift directly
  const pool = new pg.Pool({
    host: config.REDSHIFT_HOST, port: config.REDSHIFT_PORT ?? 5439,
    database: config.REDSHIFT_DB, user: config.REDSHIFT_USER, password: config.REDSHIFT_PASSWORD,
    ssl: { rejectUnauthorized: false }, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000,
  });
  const c = await pool.connect();
  try {
    // For each brand-Search campaign, look up Redshift rows where utm_campaign:
    //   (a) equals its campaign_id (numeric direct)
    //   (b) equals an ad_id whose campaign is this campaign
    //   (c) equals its name (byName)
    for (const camp of allSearch) {
      // Build the set of utm_campaign values that would attribute to THIS campaign
      const candidates = new Set<string>([camp.id, camp.name, camp.name.toLowerCase()]);
      for (const [adId, cid] of ads) if (cid === camp.id) candidates.add(adId);

      const placeholders = [...candidates].map((_, i) => `$${i + 3}`).join(',');
      const sql = `
        SELECT dt::text AS dt, utm_source, utm_campaign,
               SUM(converted)::BIGINT AS ncs,
               SUM(COALESCE(converted_amount,0))::FLOAT AS amount
        FROM mw_nexus.mm_google_funnel_daily
        WHERE dt BETWEEN $1 AND $2
          AND utm_campaign IN (${placeholders})
        GROUP BY dt, utm_source, utm_campaign
        ORDER BY ncs DESC
      `;
      const r = (await c.query(sql, [FROM, TO, ...candidates])).rows;
      if (!r.length) continue;
      const totalNcs = r.reduce((s, x) => s + Number(x.ncs), 0);
      const totalAmt = r.reduce((s, x) => s + Number(x.amount), 0);
      console.log(`\n  ── ${camp.name} (${camp.id}, ${camp.status}) ──`);
      console.log(`     Total attributed NCs: ${totalNcs}   Total amount: ₹${Math.round(totalAmt).toLocaleString('en-IN')}`);
      console.log(`     Window spend on this campaign: ₹${Math.round(spendByCid.get(camp.id) ?? 0).toLocaleString('en-IN')}`);
      console.log(`     Breakdown by (utm_source, utm_campaign):`);
      for (const x of r.slice(0, 15)) {
        const isAdId = ads.has(x.utm_campaign);
        const isCampId = x.utm_campaign === camp.id;
        const isName = x.utm_campaign === camp.name || x.utm_campaign === camp.name.toLowerCase();
        const tag = isCampId ? '[campaign_id]' : isAdId ? '[ad_id]' : isName ? '[name]' : '[?]';
        console.log(`       ${x.dt}  ${(x.utm_source || '').slice(0, 24).padEnd(24)}  utm_campaign="${(x.utm_campaign || '').slice(0, 32).padEnd(32)}"  ${tag}  ncs=${x.ncs}  amt=₹${Math.round(Number(x.amount)).toLocaleString('en-IN')}`);
      }
      if (r.length > 15) console.log(`       … and ${r.length - 15} more rows`);
    }
  } finally {
    c.release(); await pool.end();
  }
})().catch((e) => { console.error('ERR', e); process.exit(1); });
