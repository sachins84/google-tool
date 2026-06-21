// Deep-dive into the "Other PMax" bucket: for each utm_campaign that falls
// into category F (asset-group name matched, but no sibling campaign was
// active anywhere in the window), dump:
//   - the utm_campaign string and its NCs
//   - which asset_group(s) it matches in the ENABLED-asset_group map
//   - the parent campaign(s), their status, and whether they spent in window
// Plus a parallel pull that includes PAUSED asset_groups, to test the
// hypothesis that some of these NCs trace to currently-paused asset_groups
// inside currently-active campaigns (which the production map excludes).
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
const BRAND_IDS = [1, 4]; // LJ, BW — the ones with meaningful F buckets

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const inr = (n: number): string => '₹' + Math.round(n).toLocaleString('en-IN');

interface CampMeta { name: string; status: string; channel_type: string }

async function fetchCampaignsMeta(customerIds: string[]): Promise<Map<string, CampMeta>> {
  const out = new Map<string, CampMeta>();
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
        out.set(id, {
          name: r.campaign?.name ?? '', status: r.campaign?.status ?? '',
          channel_type: r.campaign?.advertisingChannelType ?? '',
        });
      }
    } catch (err) {
      console.error(`  [meta] customer ${cid}:`, err instanceof Error ? err.message : String(err));
    }
  }));
  return out;
}

async function fetchWindowSpend(customerIds: string[], from: string, to: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(customerIds.map(async (cid) => {
    try {
      const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
      const rows = await search<{ campaign?: { id?: string }; metrics?: { costMicros?: string } }>({
        customerId: cid, loginCustomerId,
        query: `SELECT campaign.id, metrics.cost_micros FROM campaign
                WHERE segments.date BETWEEN '${from}' AND '${to}'`,
      });
      for (const r of rows) {
        const id = r.campaign?.id; if (!id) continue;
        out.set(id, (out.get(id) ?? 0) + Number(r.metrics?.costMicros ?? 0) / 1_000_000);
      }
    } catch (err) {
      console.error(`  [spend] customer ${cid}:`, err instanceof Error ? err.message : String(err));
    }
  }));
  return out;
}

// Mirror buildAssetGroupNameToCampaignIdMap but include ALL statuses, for the
// hypothesis test. (Production map excludes status != ENABLED.)
async function fetchAllAssetGroupsMap(customerIds: string[]): Promise<Map<string, Array<{ campaign_id: string; ag_status: string }>>> {
  const byName = new Map<string, Array<{ campaign_id: string; ag_status: string }>>();
  await Promise.all(customerIds.map(async (cid) => {
    try {
      const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
      const rows = await search<{
        campaign?: { id?: string };
        assetGroup?: { name?: string; status?: string };
      }>({
        customerId: cid, loginCustomerId,
        query: `SELECT campaign.id, asset_group.name, asset_group.status FROM asset_group`,
      });
      for (const r of rows) {
        const nm = r.assetGroup?.name?.toLowerCase(); const id = r.campaign?.id;
        if (!nm || !id) continue;
        const list = byName.get(nm) ?? [];
        list.push({ campaign_id: id, ag_status: r.assetGroup?.status ?? '' });
        byName.set(nm, list);
        const norm = nm.replace(/[^a-z0-9]+/g, '');
        if (norm !== nm) {
          const list2 = byName.get(norm) ?? [];
          if (!list2.some((x) => x.campaign_id === id)) list2.push({ campaign_id: id, ag_status: r.assetGroup?.status ?? '' });
          byName.set(norm, list2);
        }
      }
    } catch (err) {
      console.error(`  [ag-all] customer ${cid}:`, err instanceof Error ? err.message : String(err));
    }
  }));
  return byName;
}

interface CfgRow { funnel_table: string | null; utm_source_list: string | null; utm_campaign_aliases: string | null; enabled: number }

async function deepDive(brandId: number): Promise<void> {
  const brand = getBrand(brandId);
  if (!brand) return;
  console.log(`\n══════════════ ${brand.name} (brand ${brandId}) · ${FROM}..${TO} ══════════════`);
  const cfg = getDb().prepare(
    'SELECT funnel_table, utm_source_list, utm_campaign_aliases, enabled FROM brand_redshift_config WHERE brand_id = ?'
  ).get(brandId) as CfgRow | undefined;
  if (!cfg?.enabled || !cfg.funnel_table) return;

  let utmSourceList: string[] = [];
  try { utmSourceList = JSON.parse(cfg.utm_source_list ?? '[]'); } catch {/**/}
  let aliases: Record<string, string> = {};
  try {
    const raw = JSON.parse(cfg.utm_campaign_aliases ?? '{}');
    if (raw && typeof raw === 'object') aliases = Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  } catch {/**/}

  const accountIds = brand.accounts.map((a) => a.customer_id);
  const [dailyRs, agMapProd, agMapAll, meta, windowSpend, activeByDate, adMap, skuMap] = await Promise.all([
    fetchByCampaignDaily({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: FROM, dateTo: TO }),
    buildAssetGroupNameToCampaignIdMap(accountIds, FROM, TO),  // ENABLED-only (production)
    fetchAllAssetGroupsMap(accountIds),                          // ALL statuses
    fetchCampaignsMeta(accountIds),
    fetchWindowSpend(accountIds, FROM, TO),
    buildActiveByDate(accountIds, FROM, TO),
    buildAdIdToCampaignIdMap(accountIds),
    buildSkuToCampaignIdMap(accountIds, FROM, TO),
  ]);
  void activeByDate; void adMap; void skuMap; // available if we need to expand

  // Group dailyRs by utm_campaign (across all dates / sources) for the "Other PMax" investigation
  const byUtm = new Map<string, { ncs: number; amount: number; dates: Set<string>; sources: Set<string> }>();
  for (const r of dailyRs) {
    if (!r.utm_campaign || /^\d+$/.test(r.utm_campaign)) continue;  // numeric handled separately
    const aliased = aliases[r.utm_campaign.toLowerCase()] ?? r.utm_campaign;
    const entry = byUtm.get(aliased) ?? { ncs: 0, amount: 0, dates: new Set(), sources: new Set() };
    entry.ncs += r.ncs; entry.amount += r.amount; entry.dates.add(r.date); entry.sources.add(r.utm_source);
    byUtm.set(aliased, entry);
  }

  // Walk each non-numeric utm_campaign, classify into:
  //   D: ENABLED-asset-group map matches AND ≥1 sibling spent in window
  //   F: ENABLED-asset-group map matches AND no sibling spent in window  ← the bucket the user asked about
  //   ALL-MATCH-D: ALL-asset-group map matches AND ≥1 sibling spent in window  (would be recoverable if we include paused asset_groups)
  //   ALL-MATCH-F: ALL-asset-group map matches AND no sibling spent in window
  //   NO-MATCH: nothing
  interface Detail { utm: string; ncs: number; amount: number; prodMatch: string[]; allMatch: string[]; allMatchStatuses: string[] }
  const F_prod: Detail[] = [];
  const recoverableViaAll: Detail[] = [];   // currently F but ALL-map finds an active sibling

  for (const [utm, entry] of byUtm) {
    const lc = utm.toLowerCase();
    const nk = normalize(utm);
    const prodTargets = agMapProd.get(lc) ?? agMapProd.get(nk) ?? [];
    if (!prodTargets.length) continue;  // not an asset-group case
    const prodActive = prodTargets.some((cid) => (windowSpend.get(cid) ?? 0) > 0);
    if (prodActive) continue;  // D — already handled

    // F case — dig deeper using the all-status map
    const allTargets = agMapAll.get(lc) ?? agMapAll.get(nk) ?? [];
    const allCids = [...new Set(allTargets.map((x) => x.campaign_id))];
    const allStatuses = allCids.map((cid) => {
      const m = meta.get(cid); const sp = windowSpend.get(cid) ?? 0;
      const agStatus = allTargets.find((x) => x.campaign_id === cid)?.ag_status ?? '?';
      return `${(m?.name ?? cid).slice(0,30)}[c:${m?.status?.[0] ?? '?'},ag:${agStatus[0]},₹${Math.round(sp)}]`;
    });
    const detail: Detail = {
      utm, ncs: entry.ncs, amount: entry.amount,
      prodMatch: prodTargets,
      allMatch: allCids,
      allMatchStatuses: allStatuses,
    };
    F_prod.push(detail);
    if (allCids.some((cid) => (windowSpend.get(cid) ?? 0) > 0)) recoverableViaAll.push(detail);
  }

  F_prod.sort((a, b) => b.ncs - a.ncs);
  const FNcs = F_prod.reduce((s, d) => s + d.ncs, 0);
  const recoverableNcs = recoverableViaAll.reduce((s, d) => s + d.ncs, 0);
  console.log(`  Category F total: ${F_prod.length} utm_campaigns · ${Math.round(FNcs)} NCs · ${inr(F_prod.reduce((s,d)=>s+d.amount,0))}`);
  console.log(`  Of which recoverable if we included PAUSED asset_groups: ${recoverableViaAll.length} utm_campaigns · ${Math.round(recoverableNcs)} NCs (${FNcs ? Math.round((recoverableNcs/FNcs)*100) : 0}% of F)`);
  console.log();
  console.log(`  Top utm_campaigns in F (showing parent-campaign info — c:[campaign-status],ag:[asset_group-status],₹[window-spend]):`);
  console.log();
  for (const d of F_prod.slice(0, 12)) {
    console.log(`    utm_campaign='${d.utm}'  ${Math.round(d.ncs)} NCs  ${inr(d.amount)}`);
    console.log(`      ENABLED-only map → ${d.prodMatch.length} campaign(s):`);
    for (const cid of d.prodMatch) {
      const m = meta.get(cid); const sp = windowSpend.get(cid) ?? 0;
      console.log(`        ${(m?.name ?? cid).padEnd(40)} status=${m?.status ?? '?'} spend=${inr(sp)}`);
    }
    if (d.allMatch.length !== d.prodMatch.length) {
      console.log(`      ALL-statuses map → ${d.allMatch.length} campaign(s):`);
      console.log(`        ${d.allMatchStatuses.join('   ')}`);
    }
    console.log();
  }
}

(async () => {
  initDatabase();
  for (const bid of BRAND_IDS) await deepDive(bid);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
