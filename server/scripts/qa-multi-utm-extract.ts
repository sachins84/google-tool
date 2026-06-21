// Investigate PMax rows for embedded multi-utm_campaign patterns. For each
// PMax Redshift row that doesn't directly resolve to a campaign, scan both
// utm_source and utm_campaign fields for embedded `utm_campaign=X` tokens
// (cases where the raw URL got concatenated into a single column). Report
// how many NCs would recover if we extracted those alternates.
import { initDatabase, getDb } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { fetchByCampaignDaily } from '../src/services/redshift.js';
import {
  buildAdIdToCampaignIdMap,
  buildSkuToCampaignIdMap,
  buildAssetGroupNameToCampaignIdMap,
  buildActiveByDate,
} from '../src/routes/performance.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';

const FROM = '2026-06-12';
const TO = '2026-06-18';
const BRAND_IDS = [1, 3, 4];
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
        byId.set(id, { id, name: r.campaign?.name ?? '', status: r.campaign?.status ?? '', channel_type: r.campaign?.advertisingChannelType ?? '' });
      }
    } catch { /* */ }
  }));
  return byId;
}

interface CfgRow { funnel_table: string | null; utm_source_list: string | null; utm_campaign_aliases: string | null; enabled: number }

/**
 * Pull out every value of utm_campaign from a raw concatenated URL/string.
 * Cases we want to handle:
 *   - "campaign_id&utm_campaign=other_id"           (multiple chained)
 *   - "name&utm_campaign=other_name&utm_term=…"     (utm_campaign starts at position N)
 *   - "google_Search&utm_campaign=724028387900"     (the LJ Search outlier we saw)
 *   - URL-encoded: %26utm_campaign%3D…
 * Returns the original value first, then any embedded extractions.
 */
function extractAllUtmCampaigns(raw: string): string[] {
  const out: string[] = [];
  if (!raw) return out;
  // Decode percent-encoded characters once (best-effort)
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
  // The first value is whatever's before any '&' (the field as-typed)
  const head = decoded.split('&')[0];
  if (head) out.push(head);
  // Any explicit utm_campaign=X tokens after the head
  const re = /[?&]utm_campaign=([^&#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decoded)) !== null) {
    if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  // Also handle leading "utm_campaign=" (no '&' prefix)
  const m2 = decoded.match(/^utm_campaign=([^&#]+)/);
  if (m2?.[1] && !out.includes(m2[1])) out.push(m2[1]);
  return out;
}

async function run(brandId: number): Promise<void> {
  const brand = getBrand(brandId);
  if (!brand) return;
  console.log(`\n════════════ ${brand.name} (brand ${brandId}) · ${FROM}..${TO} ════════════`);
  const cfg = getDb().prepare(
    'SELECT funnel_table, utm_source_list, utm_campaign_aliases, enabled FROM brand_redshift_config WHERE brand_id = ?'
  ).get(brandId) as CfgRow | undefined;
  if (!cfg?.enabled || !cfg.funnel_table) return;
  let utmSourceList: string[] = [];
  try { utmSourceList = JSON.parse(cfg.utm_source_list ?? '[]'); } catch { /* */ }

  const accountIds = brand.accounts.map((a) => a.customer_id);
  const [dailyRs, adMap, skuMap, agMap, activeByDate, meta] = await Promise.all([
    fetchByCampaignDaily({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: FROM, dateTo: TO }),
    buildAdIdToCampaignIdMap(accountIds),
    buildSkuToCampaignIdMap(accountIds, FROM, TO),
    buildAssetGroupNameToCampaignIdMap(accountIds, FROM, TO),
    buildActiveByDate(accountIds, FROM, TO),
    fetchCampaignsMeta(accountIds),
  ]);
  void skuMap;
  const nameToCampaign = new Map<string, string>();
  const normNameToCampaign = new Map<string, string>();
  for (const m of meta.values()) {
    nameToCampaign.set(m.name.toLowerCase(), m.id);
    normNameToCampaign.set(normalize(m.name), m.id);
  }

  // Walk PMax-source rows only
  let pmaxRows = 0, pmaxNcs = 0;
  let directMatch = 0, directMatchNcs = 0;
  let multiCount = 0;        // rows where extractAllUtmCampaigns returned >1 candidates
  let multiNcs = 0;
  let recoveredViaMulti = 0; // rows where direct didn't match but a 2nd extracted value did
  let recoveredViaMultiNcs = 0;
  let recoveredViaMultiAmt = 0;
  const recoveredSamples: Array<{ utm_campaign: string; utm_source: string; resolvedTo: string; ncs: number }> = [];
  let needsAssetGroup = 0;
  let needsAssetGroupNcs = 0;

  for (const r of dailyRs) {
    if (!r.utm_source.toLowerCase().includes('pmax')) continue;
    pmaxRows++; pmaxNcs += r.ncs;

    // 1) Direct check on utm_campaign field as-is
    let resolved: string | null = null;
    if (/^\d+$/.test(r.utm_campaign)) {
      const t = adMap.get(r.utm_campaign) ?? r.utm_campaign;
      if (meta.has(t)) resolved = `direct:numeric → ${meta.get(t)?.name}`;
    } else {
      const lc = r.utm_campaign.toLowerCase();
      const nk = normalize(r.utm_campaign);
      if (nameToCampaign.has(lc) && meta.has(nameToCampaign.get(lc)!)) resolved = `direct:name → ${meta.get(nameToCampaign.get(lc)!)?.name}`;
      else if (normNameToCampaign.has(nk) && meta.has(normNameToCampaign.get(nk)!)) resolved = `direct:norm-name → ${meta.get(normNameToCampaign.get(nk)!)?.name}`;
    }
    if (resolved) { directMatch++; directMatchNcs += r.ncs; continue; }

    // 2) Try extracting embedded utm_campaign values from BOTH fields
    const candidates = new Set<string>([
      ...extractAllUtmCampaigns(r.utm_campaign),
      ...extractAllUtmCampaigns(r.utm_source),
    ]);
    candidates.delete(r.utm_campaign);  // already tried
    if (candidates.size > 0) { multiCount++; multiNcs += r.ncs; }
    for (const cand of candidates) {
      if (/^\d+$/.test(cand)) {
        const t = adMap.get(cand) ?? cand;
        if (meta.has(t)) { resolved = `multi:numeric '${cand}' → ${meta.get(t)?.name}`; break; }
      } else {
        const lc = cand.toLowerCase();
        const nk = normalize(cand);
        if (nameToCampaign.has(lc) && meta.has(nameToCampaign.get(lc)!)) { resolved = `multi:name '${cand}' → ${meta.get(nameToCampaign.get(lc)!)?.name}`; break; }
        if (normNameToCampaign.has(nk) && meta.has(normNameToCampaign.get(nk)!)) { resolved = `multi:norm-name '${cand}' → ${meta.get(normNameToCampaign.get(nk)!)?.name}`; break; }
      }
    }
    if (resolved) {
      recoveredViaMulti++; recoveredViaMultiNcs += r.ncs; recoveredViaMultiAmt += r.amount;
      if (recoveredSamples.length < 12) recoveredSamples.push({
        utm_campaign: r.utm_campaign, utm_source: r.utm_source, resolvedTo: resolved, ncs: r.ncs,
      });
      continue;
    }

    // 3) Would have fallen through to asset_group resolution
    const lc = r.utm_campaign.toLowerCase();
    const nk = normalize(r.utm_campaign);
    const ag = agMap.get(lc) ?? agMap.get(nk) ?? [];
    if (ag.length) { needsAssetGroup++; needsAssetGroupNcs += r.ncs; }
  }

  console.log(`  PMax rows: ${pmaxRows}  pre-RTO NCs: ${Math.round(pmaxNcs)}`);
  console.log(`    direct utm_campaign match    : ${directMatch} rows · ${Math.round(directMatchNcs)} NCs`);
  console.log(`    rows with ≥1 alt candidates  : ${multiCount} rows · ${Math.round(multiNcs)} NCs`);
  console.log(`    ★ recovered via multi-utm    : ${recoveredViaMulti} rows · ${Math.round(recoveredViaMultiNcs)} NCs · ${inr(recoveredViaMultiAmt)}`);
  console.log(`    would fall to asset-group    : ${needsAssetGroup} rows · ${Math.round(needsAssetGroupNcs)} NCs`);
  void activeByDate;
  if (recoveredSamples.length) {
    console.log();
    console.log(`  Recovery examples (showing how the alternate utm_campaign was extracted):`);
    for (const s of recoveredSamples) {
      console.log(`    NCs ${s.ncs.toFixed(1).padStart(5)}  → ${s.resolvedTo}`);
      console.log(`      utm_campaign: "${s.utm_campaign.slice(0, 80)}"`);
      console.log(`      utm_source:   "${s.utm_source.slice(0, 80)}"`);
    }
  }
}

(async () => {
  initDatabase();
  for (const bid of BRAND_IDS) await run(bid);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
