// For each non-PMax Redshift utm_source (Search / Shopping / Demand Gen),
// classify every (date, utm_campaign) row as MATCHED or UNMATCHED and dump
// the unmatched utm_campaign strings. Non-PMax shouldn't ever need a 1/N
// split — the utm_campaign is either a numeric ID or a campaign name that
// resolves 1:1.
import { initDatabase, getDb } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { fetchByCampaignDaily } from '../src/services/redshift.js';
import {
  buildAdIdToCampaignIdMap,
  buildSkuToCampaignIdMap,
} from '../src/routes/performance.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';

const FROM = '2026-06-12';
const TO = '2026-06-18';
const BRAND_IDS = [1, 3, 4]; // LJ, MM, BW
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const inr = (n: number): string => '₹' + Math.round(n).toLocaleString('en-IN');

interface CampMeta { id: string; name: string; status: string; channel_type: string }

async function fetchCampaignsMeta(customerIds: string[]): Promise<Map<string, CampMeta>> {
  const byId = new Map<string, CampMeta>();
  await Promise.all(customerIds.map(async (cid) => {
    try {
      const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
      const rows = await search<{ campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string } }>({
        customerId: cid, loginCustomerId,
        query: `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
                FROM campaign WHERE campaign.status != 'REMOVED'`,
      });
      for (const r of rows) {
        const id = r.campaign?.id; if (!id) continue;
        byId.set(id, {
          id, name: r.campaign?.name ?? '',
          status: r.campaign?.status ?? '',
          channel_type: r.campaign?.advertisingChannelType ?? '',
        });
      }
    } catch (err) { console.error(`  [meta] ${cid}:`, err instanceof Error ? err.message : String(err)); }
  }));
  return byId;
}

interface CfgRow { funnel_table: string | null; utm_source_list: string | null; utm_campaign_aliases: string | null; enabled: number }

async function run(brandId: number): Promise<void> {
  const brand = getBrand(brandId);
  if (!brand) return;
  console.log(`\n════════════ ${brand.name} (brand ${brandId}) · ${FROM}..${TO} ════════════`);
  const cfg = getDb().prepare(
    'SELECT funnel_table, utm_source_list, utm_campaign_aliases, enabled FROM brand_redshift_config WHERE brand_id = ?'
  ).get(brandId) as CfgRow | undefined;
  if (!cfg?.enabled || !cfg.funnel_table) { console.log('  (no Redshift config)'); return; }

  let utmSourceList: string[] = [];
  try { utmSourceList = JSON.parse(cfg.utm_source_list ?? '[]'); } catch {/**/}
  let aliases: Record<string, string> = {};
  try {
    const raw = JSON.parse(cfg.utm_campaign_aliases ?? '{}');
    if (raw && typeof raw === 'object') aliases = Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  } catch {/**/}

  const accountIds = brand.accounts.map((a) => a.customer_id);
  const [dailyRs, adMap, skuMap, meta] = await Promise.all([
    fetchByCampaignDaily({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: FROM, dateTo: TO }),
    buildAdIdToCampaignIdMap(accountIds),
    buildSkuToCampaignIdMap(accountIds, FROM, TO),
    fetchCampaignsMeta(accountIds),
  ]);

  // Build name lookups from current Google Ads campaigns (the production
  // mergeRedshiftMetrics path matches utm_campaign string vs row.campaign_name)
  const nameToCampaign = new Map<string, CampMeta>();
  const normNameToCampaign = new Map<string, CampMeta>();
  for (const m of meta.values()) {
    nameToCampaign.set(m.name.toLowerCase(), m);
    normNameToCampaign.set(normalize(m.name), m);
  }

  // Classify per source
  type RowDetail = { utm: string; date: string; ncs: number; amount: number; path: string; resolved_to?: string };
  const bySource = new Map<string, { matched: RowDetail[]; unmatched: RowDetail[] }>();

  for (const r of dailyRs) {
    const src = r.utm_source;
    if (!bySource.has(src)) bySource.set(src, { matched: [], unmatched: [] });
    const bucket = bySource.get(src)!;

    let path: string | null = null;
    let resolvedTo: string | undefined;

    if (/^\d+$/.test(r.utm_campaign)) {
      // numeric → either campaign_id directly OR ad_id (via {creative} → campaign_id)
      const direct = meta.get(r.utm_campaign);
      if (direct) { path = 'numeric→campaign_id'; resolvedTo = direct.name; }
      else {
        const viaAd = adMap.get(r.utm_campaign);
        if (viaAd && meta.has(viaAd)) { path = 'numeric→ad_id→campaign_id'; resolvedTo = meta.get(viaAd)?.name; }
      }
    } else {
      const aliased = aliases[r.utm_campaign.toLowerCase()] ?? r.utm_campaign;
      const lc = aliased.toLowerCase();
      const nk = normalize(aliased);
      // SKU
      const skuTarget = skuMap.get(lc);
      if (skuTarget && meta.has(skuTarget)) { path = 'SKU→Shopping'; resolvedTo = meta.get(skuTarget)?.name; }
      else if (nameToCampaign.has(lc)) { path = 'name→campaign'; resolvedTo = nameToCampaign.get(lc)?.name; }
      else if (normNameToCampaign.has(nk)) { path = 'norm-name→campaign'; resolvedTo = normNameToCampaign.get(nk)?.name; }
    }

    const detail: RowDetail = { utm: r.utm_campaign, date: r.date, ncs: r.ncs, amount: r.amount, path: path ?? 'UNMATCHED', resolved_to: resolvedTo };
    if (path) bucket.matched.push(detail); else bucket.unmatched.push(detail);
  }

  // Print summary per source
  const sorted = [...bySource.entries()].sort((a, b) => {
    const ncsA = a[1].matched.reduce((s, r) => s + r.ncs, 0) + a[1].unmatched.reduce((s, r) => s + r.ncs, 0);
    const ncsB = b[1].matched.reduce((s, r) => s + r.ncs, 0) + b[1].unmatched.reduce((s, r) => s + r.ncs, 0);
    return ncsB - ncsA;
  });

  console.log(`  ${'utm_source'.padEnd(18)} ${'rows'.padStart(6)} ${'matched NCs'.padStart(14)} ${'unmatched NCs'.padStart(16)} ${'match%'.padStart(8)} ${'unmatched amount'.padStart(18)}`);
  console.log('  ' + '-'.repeat(86));
  for (const [src, b] of sorted) {
    const matchedNcs = b.matched.reduce((s, r) => s + r.ncs, 0);
    const unmatchedNcs = b.unmatched.reduce((s, r) => s + r.ncs, 0);
    const unmatchedAmt = b.unmatched.reduce((s, r) => s + r.amount, 0);
    const totalNcs = matchedNcs + unmatchedNcs;
    const pct = totalNcs > 0 ? (matchedNcs / totalNcs) * 100 : 0;
    console.log(`  ${src.padEnd(18)} ${(b.matched.length + b.unmatched.length).toString().padStart(6)} ${Math.round(matchedNcs).toString().padStart(14)} ${Math.round(unmatchedNcs).toString().padStart(16)} ${pct.toFixed(1).padStart(7)}% ${inr(unmatchedAmt).padStart(18)}`);
  }

  // Dump unmatched details for non-PMax sources
  for (const [src, b] of sorted) {
    if (src.toLowerCase().includes('pmax')) continue;  // PMax is the messy case the user accepts
    if (!b.unmatched.length) continue;
    // Group by utm_campaign to make it readable
    const byUtm = new Map<string, { rows: number; ncs: number; amount: number; dates: Set<string> }>();
    for (const u of b.unmatched) {
      const cur = byUtm.get(u.utm) ?? { rows: 0, ncs: 0, amount: 0, dates: new Set() };
      cur.rows++; cur.ncs += u.ncs; cur.amount += u.amount; cur.dates.add(u.date);
      byUtm.set(u.utm, cur);
    }
    const list = [...byUtm.entries()].sort((a, b) => b[1].ncs - a[1].ncs);
    console.log();
    console.log(`  ── UNMATCHED for utm_source='${src}' (${list.length} distinct utm_campaigns, ${b.unmatched.length} rows) ──`);
    for (const [utm, info] of list.slice(0, 20)) {
      console.log(`    "${utm.slice(0, 60).padEnd(60)}"  ${Math.round(info.ncs).toString().padStart(5)} NCs  ${inr(info.amount).padStart(12)}  ${info.dates.size}d`);
    }
    if (list.length > 20) console.log(`    … and ${list.length - 20} more`);
  }
}

(async () => {
  initDatabase();
  for (const bid of BRAND_IDS) await run(bid);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
