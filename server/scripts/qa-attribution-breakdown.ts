// One-off classifier: walks per-(date, utm_campaign) Redshift rows for each
// brand, runs the same attribution logic as mergeRedshiftMetrics, and counts
// NCs falling into each category — with explicit focus on the asset-group
// 1/N split's "no sibling active on this date" bucket the user asked about.
//
// Run:  yarn workspace @google-ads-tool/server tsx scripts/qa-attribution-breakdown.ts
import { initDatabase, getDb } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { fetchByCampaignDaily } from '../src/services/redshift.js';
import {
  buildActiveByDate,
  buildAdIdToCampaignIdMap,
  buildSkuToCampaignIdMap,
  buildAssetGroupNameToCampaignIdMap,
} from '../src/routes/performance.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';

const FROM = '2026-06-12';
const TO = '2026-06-18';
const BRAND_IDS = [1, 3, 4]; // LJ, MM, BW

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

interface Category {
  rows: number;
  ncs: number;
  amount: number;
  samples: string[];
}
const newCat = (): Category => ({ rows: 0, ncs: 0, amount: 0, samples: [] });
const addCat = (c: Category, ncs: number, amount: number, sample: string) => {
  c.rows++; c.ncs += ncs; c.amount += amount;
  if (c.samples.length < 5 && !c.samples.includes(sample)) c.samples.push(sample);
};
const inr = (n: number): string => '₹' + Math.round(n).toLocaleString('en-IN');

async function fetchKnownCampaignIds(customerIds: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  await Promise.all(customerIds.map(async (cid) => {
    try {
      const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
      const rows = await search<{ campaign?: { id?: string } }>({
        customerId: cid, loginCustomerId,
        query: `SELECT campaign.id FROM campaign WHERE campaign.status != 'REMOVED'`,
      });
      for (const r of rows) if (r.campaign?.id) ids.add(r.campaign.id);
    } catch (err) {
      console.error(`  [known] customer ${cid}:`, err instanceof Error ? err.message : String(err));
    }
  }));
  return ids;
}

async function fetchWindowActive(customerIds: string[], from: string, to: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const q = `SELECT campaign.id, metrics.cost_micros
             FROM campaign
             WHERE segments.date BETWEEN '${from}' AND '${to}'
               AND metrics.cost_micros > 0`;
  await Promise.all(customerIds.map(async (cid) => {
    try {
      const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
      const rows = await search<{ campaign?: { id?: string }; metrics?: { costMicros?: string } }>({
        customerId: cid, loginCustomerId, query: q,
      });
      for (const r of rows) {
        if (r.campaign?.id && Number(r.metrics?.costMicros ?? 0) > 0) ids.add(r.campaign.id);
      }
    } catch (err) {
      console.error(`  [active-win] customer ${cid}:`, err instanceof Error ? err.message : String(err));
    }
  }));
  return ids;
}

interface BrandCfg { funnel_table: string | null; utm_source_list: string | null; utm_campaign_aliases: string | null; enabled: number }

async function classify(brandId: number): Promise<void> {
  const brand = getBrand(brandId);
  if (!brand) { console.log(`Brand ${brandId} not found`); return; }
  console.log(`\n══════════════ ${brand.name} (brand ${brandId}) · ${FROM}..${TO} ══════════════`);

  const cfg = getDb().prepare(
    'SELECT funnel_table, utm_source_list, utm_campaign_aliases, enabled FROM brand_redshift_config WHERE brand_id = ?'
  ).get(brandId) as BrandCfg | undefined;
  if (!cfg?.enabled || !cfg.funnel_table) { console.log('  (no Redshift config)'); return; }

  let utmSourceList: string[] = [];
  try { utmSourceList = JSON.parse(cfg.utm_source_list ?? '[]'); } catch { /* */ }
  let aliases: Record<string, string> = {};
  try {
    const raw = JSON.parse(cfg.utm_campaign_aliases ?? '{}');
    if (raw && typeof raw === 'object') {
      aliases = Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
    }
  } catch { /* */ }

  const accountIds = brand.accounts.map((a) => a.customer_id);
  const [dailyRs, adMap, skuMap, agMap, activeByDate, knownIds, windowActive] = await Promise.all([
    fetchByCampaignDaily({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: FROM, dateTo: TO }),
    buildAdIdToCampaignIdMap(accountIds),
    buildSkuToCampaignIdMap(accountIds, FROM, TO),
    buildAssetGroupNameToCampaignIdMap(accountIds, FROM, TO),
    buildActiveByDate(accountIds, FROM, TO),
    fetchKnownCampaignIds(accountIds),
    fetchWindowActive(accountIds, FROM, TO),
  ]);

  const cats = {
    A_numeric_attributed: newCat(),
    B_numeric_removed:    newCat(),  // numeric id not in knownIds — campaign deleted
    C_sku:                newCat(),
    D_ag_split_per_date_ok:           newCat(),  // ≥1 sibling active on r.date → per-date split happens
    E_ag_no_active_today_window_yes:  newCat(),  // 0 siblings active that day BUT ≥1 active somewhere in window
                                                  //   → THIS is the delta the user asked about
                                                  //   → previously credited (window-level), now Other
    F_ag_no_active_window:            newCat(),  // 0 siblings active anywhere in window (all paused/zero-spend)
                                                  //   → was always Other, still Other
    G_ag_no_known_sibling:            newCat(),  // ag map matched but none of those campaign_ids exist (deleted)
    H_byname_match:                   newCat(),
    I_no_match_at_all:                newCat(),
  };
  let totalNcs = 0;

  for (const r of dailyRs) {
    totalNcs += r.ncs;
    if (/^\d+$/.test(r.utm_campaign)) {
      const target = adMap.get(r.utm_campaign) ?? r.utm_campaign;
      if (knownIds.has(target)) addCat(cats.A_numeric_attributed, r.ncs, r.amount, r.utm_campaign);
      else                       addCat(cats.B_numeric_removed,    r.ncs, r.amount, r.utm_campaign);
      continue;
    }
    const aliased = aliases[r.utm_campaign.toLowerCase()] ?? r.utm_campaign;
    const lcKey = aliased.toLowerCase();
    const normKey = normalize(aliased);
    const skuTarget = skuMap.get(lcKey);
    if (skuTarget && knownIds.has(skuTarget)) {
      addCat(cats.C_sku, r.ncs, r.amount, r.utm_campaign); continue;
    }
    const agTargets = agMap.get(lcKey) ?? agMap.get(normKey);
    if (agTargets && agTargets.length) {
      const knownAgTargets = agTargets.filter((cid) => knownIds.has(cid));
      if (!knownAgTargets.length) { addCat(cats.G_ag_no_known_sibling, r.ncs, r.amount, r.utm_campaign); continue; }
      const activeToday = activeByDate.get(r.date) ?? new Set<string>();
      const activeNow = knownAgTargets.filter((cid) => activeToday.has(cid));
      if (activeNow.length) { addCat(cats.D_ag_split_per_date_ok, r.ncs, r.amount, r.utm_campaign); continue; }
      // No sibling active on r.date — was at least one active SOMEWHERE in the window?
      const activeInWindow = knownAgTargets.some((cid) => windowActive.has(cid));
      if (activeInWindow) addCat(cats.E_ag_no_active_today_window_yes, r.ncs, r.amount, r.utm_campaign);
      else                addCat(cats.F_ag_no_active_window,           r.ncs, r.amount, r.utm_campaign);
      continue;
    }
    // byName path: would attribute if any campaign name matches lcKey or normKey
    // (we don't fetch all campaign names here, but counting it lets us bound
    //  "would attribute" at the rough order of magnitude.)
    addCat(cats.H_byname_match, r.ncs, r.amount, r.utm_campaign); continue;
  }

  // mark byName-vs-no-match unknown without name list; simplify by leaving H as
  // "non-numeric, non-SKU, no asset-group hit" — these reach the byName fallback.
  cats.I_no_match_at_all = cats.H_byname_match;
  cats.H_byname_match = newCat();

  // Output
  const order: Array<[keyof typeof cats, string]> = [
    ['A_numeric_attributed',          'Numeric utm_campaign → known campaign (paused or not)'],
    ['B_numeric_removed',             'Numeric utm_campaign → REMOVED campaign (→ Other)'],
    ['C_sku',                         'SKU → Shopping campaign'],
    ['D_ag_split_per_date_ok',        'Asset-group split: ≥1 sibling ACTIVE THAT DATE  (credit splits OK)'],
    ['E_ag_no_active_today_window_yes', '★ Asset-group: NO sibling active that date but ≥1 active later/earlier in window'],
    ['F_ag_no_active_window',         'Asset-group: NO sibling active anywhere in window (already Other)'],
    ['G_ag_no_known_sibling',         'Asset-group: no known sibling (campaigns removed)'],
    ['I_no_match_at_all',             'Fallback / no match → Other [Channel]'],
  ];
  const tot = Object.values(cats).reduce((s, c) => s + c.ncs, 0);
  console.log(`  Total dailyRs rows: ${dailyRs.length} · Pre-RTO NCs: ${Math.round(tot)}`);
  console.log();
  console.log(`  ${'Category'.padEnd(78)} ${'rows'.padStart(6)} ${'NCs'.padStart(8)} ${'%'.padStart(7)} ${'Amount'.padStart(12)}`);
  console.log('  ' + '-'.repeat(78 + 6 + 8 + 7 + 12 + 4));
  for (const [k, label] of order) {
    const c = cats[k];
    const pct = tot > 0 ? (c.ncs / tot) * 100 : 0;
    console.log(`  ${label.padEnd(78)} ${c.rows.toString().padStart(6)} ${Math.round(c.ncs).toString().padStart(8)} ${pct.toFixed(1).padStart(6)}% ${inr(c.amount).padStart(12)}`);
  }
  // Drill into the user's exact question
  const E = cats.E_ag_no_active_today_window_yes;
  const pctOfTotal = tot > 0 ? (E.ncs / tot) * 100 : 0;
  console.log();
  console.log(`  ★ THE BUCKET YOU ASKED ABOUT:`);
  console.log(`     "Asset-group name where no sibling was active that day"`);
  console.log(`     ${Math.round(E.ncs)} NCs (${pctOfTotal.toFixed(2)}% of total) · ${inr(E.amount)} revenue (pre-RTO)`);
  console.log(`     Sample utm_campaigns: ${E.samples.join(', ') || '(none)'}`);
}

(async () => {
  initDatabase();
  for (const bid of BRAND_IDS) await classify(bid);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
