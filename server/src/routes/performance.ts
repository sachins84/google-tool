import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getBrand } from '../services/brands.js';
import {
  buildCampaignsQuery,
  buildAdGroupsQuery,
  buildAssetGroupsQuery,
  buildAdsQuery,
  buildKeywordsQuery,
  buildSearchTermsQuery,
  type Level,
} from '../services/gaql.js';
import { search } from '../services/google-ads.js';
import {
  addRaw,
  applyFlatRto,
  attachRedshiftMetrics,
  deriveMetrics,
  emptyRaw,
  parseRawFromGoogle,
  type DerivedMetrics,
  type RawMetrics,
} from '../services/metrics.js';
import { fetchByCampaign, fetchTotal } from '../services/redshift.js';
import { getDb } from '../db/init.js';
import { getLoginCustomerId } from '../services/mcc-map.js';

const querySchema = z.object({
  brand_id: z.coerce.number(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  compare_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compare_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  campaign_id: z.string().optional(),
  ad_group_id: z.string().optional(),
  asset_group_id: z.string().optional(),
});

interface Row {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  ad_group_id?: string;
  ad_group_name?: string;
  asset_group_id?: string;
  asset_group_name?: string;
  ad_strength?: string;
  path1?: string;
  path2?: string;
  ad_id?: string;
  ad_name?: string;
  ad_type?: string;
  status?: string;
  channel_type?: string;
  bidding_strategy_type?: string;
  daily_budget_inr?: number;
  cpc_bid_inr?: number;
  headlines?: string[];
  descriptions?: string[];
  final_urls?: string[];
  // keyword / search_term fields
  criterion_id?: string;
  keyword_text?: string;
  match_type?: string;
  quality_score?: number;
  search_term?: string;
  // synthetic flag for "Other PMax" / "Other Search" rows holding residual NCs
  // not attributable to any specific Google Ads campaign
  synthetic?: boolean;
  synthetic_samples?: string[]; // sample utm_campaigns rolled up here, for transparency
  metrics: DerivedMetrics;
  comparison?: DerivedMetrics;
}

const MICROS = 1_000_000;

function pickRowKey(level: Level, raw: GoogleAdsRow): string {
  if (level === 'campaign') return `${raw.campaign?.id}`;
  if (level === 'ad_group') return `${raw.adGroup?.id}`;
  if (level === 'asset_group') return `${raw.assetGroup?.id}`;
  if (level === 'ad') return `${raw.adGroupAd?.ad?.id}`;
  if (level === 'keyword') return `${raw.adGroup?.id}|${raw.adGroupCriterion?.criterionId}`;
  if (level === 'search_term') return `${raw.adGroup?.id}|${raw.searchTermView?.searchTerm}`;
  return `${raw.adGroupCriterion?.criterionId}`;
}

interface GoogleAdsRow {
  campaign?: {
    id?: string;
    name?: string;
    status?: string;
    advertisingChannelType?: string;
    biddingStrategyType?: string;
  };
  adGroup?: {
    id?: string;
    name?: string;
    status?: string;
    type?: string;
    cpcBidMicros?: string;
  };
  adGroupAd?: {
    status?: string;
    ad?: {
      id?: string;
      name?: string;
      type?: string;
      finalUrls?: string[];
      responsiveSearchAd?: {
        headlines?: Array<{ text?: string }>;
        descriptions?: Array<{ text?: string }>;
      };
    };
  };
  adGroupCriterion?: {
    criterionId?: string;
    status?: string;
    keyword?: { text?: string; matchType?: string };
    qualityInfo?: { qualityScore?: number };
  };
  searchTermView?: {
    searchTerm?: string;
    status?: string;
  };
  segments?: {
    searchTermMatchType?: string;
  };
  campaignBudget?: { amountMicros?: string };
  assetGroup?: {
    id?: string;
    name?: string;
    status?: string;
    adStrength?: string;
    finalUrls?: string[];
    path1?: string;
    path2?: string;
  };
  metrics?: Record<string, unknown>;
}

function buildQueryForLevel(
  level: Level,
  from: string,
  to: string,
  campaignId?: string,
  adGroupId?: string,
  assetGroupId?: string
): string {
  const opts = {
    level,
    from,
    to,
    campaignIds: campaignId ? [campaignId] : undefined,
    adGroupIds: adGroupId ? [adGroupId] : undefined,
    assetGroupIds: assetGroupId ? [assetGroupId] : undefined,
  };
  if (level === 'campaign') return buildCampaignsQuery(opts);
  if (level === 'ad_group') return buildAdGroupsQuery(opts);
  if (level === 'asset_group') return buildAssetGroupsQuery(opts);
  if (level === 'ad') return buildAdsQuery(opts);
  if (level === 'search_term') return buildSearchTermsQuery(opts);
  return buildKeywordsQuery(opts);
}

async function fetchRowsForBrand(
  level: Level,
  brandId: number,
  from: string,
  to: string,
  campaignId?: string,
  adGroupId?: string,
  assetGroupId?: string
): Promise<Row[]> {
  const brand = getBrand(brandId);
  if (!brand) throw new Error(`Brand ${brandId} not found`);
  if (!brand.accounts.length) return [];

  const query = buildQueryForLevel(level, from, to, campaignId, adGroupId, assetGroupId);

  // Fetch each linked customer in parallel — using its MCC as login-customer-id where required.
  const perAccount = await Promise.all(
    brand.accounts.map(async (acc) => {
      const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
      const rows = await search<GoogleAdsRow>({ customerId: acc.customer_id, loginCustomerId, query });
      return { customerId: acc.customer_id, rows };
    })
  );

  // Aggregate rows by entity within each customer (one row per entity, summing daily metrics).
  // GAQL with segments.date returns one row per date — we sum across the date range here.
  const aggregated = new Map<string, { row: Row; raw: RawMetrics }>();

  for (const { customerId, rows } of perAccount) {
    for (const r of rows) {
      const key = `${customerId}|${pickRowKey(level, r)}`;
      const raw = parseRawFromGoogle(r.metrics ?? {});

      let entry = aggregated.get(key);
      if (!entry) {
        entry = { row: shapeRow(level, customerId, r), raw: emptyRaw() };
        aggregated.set(key, entry);
      }
      entry.raw = addRaw(entry.raw, raw);
    }
  }

  let rows = Array.from(aggregated.values()).map(({ row, raw }) => ({
    ...row,
    metrics: applyFlatRto(deriveMetrics(raw), brand.rto_factor),
  }));

  // If brand is on Redshift mode and we're at campaign level, join in NCs / AOV / calc ROAS
  if (level === 'campaign' && brand.rto_mode === 'redshift') {
    rows = await mergeRedshiftMetrics(rows, brandId, from, to);
  }

  return rows;
}

interface BrandRedshiftRow {
  brand_id: number;
  funnel_table: string | null;
  utm_source_list: string | null;
  enabled: number;
}

interface BrandRsTotal {
  ncs: number;
  amount: number;
}

async function tryFetchBrandTotals(
  brandId: number,
  from: string, to: string,
  compareFrom?: string, compareTo?: string
): Promise<{ primary?: BrandRsTotal; compare?: BrandRsTotal } | undefined> {
  const cfg = getDb()
    .prepare('SELECT brand_id, funnel_table, utm_source_list, enabled FROM brand_redshift_config WHERE brand_id = ?')
    .get(brandId) as BrandRedshiftRow | undefined;
  if (!cfg || !cfg.enabled || !cfg.funnel_table) return undefined;
  let utmSourceList: string[] = [];
  try { utmSourceList = JSON.parse(cfg.utm_source_list ?? '[]'); } catch { /* ignore */ }
  if (utmSourceList.length === 0) return undefined;

  const primary = await fetchTotal({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: from, dateTo: to });
  let compare: BrandRsTotal | undefined;
  if (compareFrom && compareTo) {
    const c = await fetchTotal({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: compareFrom, dateTo: compareTo });
    compare = { ncs: c.ncs, amount: c.amount };
  }
  return {
    primary: { ncs: primary.ncs, amount: primary.amount },
    compare,
  };
}

async function mergeRedshiftMetrics(rows: Row[], brandId: number, from: string, to: string): Promise<Row[]> {
  const cfg = getDb()
    .prepare('SELECT brand_id, funnel_table, utm_source_list, enabled FROM brand_redshift_config WHERE brand_id = ?')
    .get(brandId) as BrandRedshiftRow | undefined;
  if (!cfg || !cfg.enabled || !cfg.funnel_table) return rows;
  let utmSourceList: string[] = [];
  try { utmSourceList = JSON.parse(cfg.utm_source_list ?? '[]'); } catch { /* ignore */ }
  if (utmSourceList.length === 0) return rows;

  // Fetch Redshift NCs + Google indexes in parallel.
  // ad_id map:           Search campaigns use {creative} → utm_campaign holds AD ID
  // sku map:             Shopping campaigns use {product_id} → utm_campaign holds SKU
  // asset_group_name map: PMax campaigns sometimes use the asset group name verbatim
  //                       (e.g. 'Nutrimix-2', 'IBK') in their tracking template
  const brand = getBrand(brandId);
  const accountIds = brand?.accounts.map((a) => a.customer_id) ?? [];
  const [rsRows, adIdToCampaignId, skuToCampaignId, agNameToCampaignId] = await Promise.all([
    fetchByCampaign({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: from, dateTo: to }),
    buildAdIdToCampaignIdMap(accountIds),
    buildSkuToCampaignIdMap(accountIds, from, to),
    buildAssetGroupNameToCampaignIdMap(accountIds, from, to),
  ]);

  // utm_campaign is sometimes the Google Ads campaign ID (e.g. "23223219977"),
  // sometimes a custom name (e.g. "LJ_shopping_Manual_Generic_MVChocolate"),
  // and sometimes a SKU code (e.g. "MWLJNTP.00480.B0_N"). The funnel table is the
  // only attribution we have — there's no gclid, utm_term, or utm_content stored.
  //
  // Three-pass match:
  //   1. exact campaign.id (numeric utm_campaign)
  //   2. exact lowercase campaign.name
  //   3. normalized (alphanumeric only) campaign.name
  const byId = new Map<string, { ncs: number; amount: number }>();
  const byName = new Map<string, { ncs: number; amount: number }>();
  const byNormName = new Map<string, { ncs: number; amount: number }>();

  function normalize(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  function add(map: Map<string, { ncs: number; amount: number }>, k: string, v: { ncs: number; amount: number }) {
    const prev = map.get(k);
    map.set(k, prev ? { ncs: prev.ncs + v.ncs, amount: prev.amount + v.amount } : v);
  }

  for (const r of rsRows) {
    const entry = { ncs: r.ncs, amount: r.amount };
    if (/^\d+$/.test(r.utm_campaign)) {
      // numeric utm_campaign — campaign_id (PMax/DG) or ad_id (Search via {creative}).
      const target = adIdToCampaignId.get(r.utm_campaign) ?? r.utm_campaign;
      add(byId, target, entry);
    } else {
      // non-numeric — try SKU first (Shopping {product_id}), then asset_group_name
      // (PMax tracking template), then fall back to campaign name fuzzy matching.
      const lcKey = r.utm_campaign.toLowerCase();
      const normKey = normalize(r.utm_campaign);
      const skuTarget = skuToCampaignId.get(lcKey);
      if (skuTarget) {
        add(byId, skuTarget, entry);
        continue;
      }
      const agTarget = agNameToCampaignId.get(lcKey) ?? agNameToCampaignId.get(normKey);
      if (agTarget) {
        add(byId, agTarget, entry);
        continue;
      }
      add(byName, lcKey, entry);
      add(byNormName, normKey, entry);
    }
  }

  // In redshift mode, every row gets calc fields. Unmatched rows default to 0 NCs
  // (i.e. the campaign exists in Google Ads but generated no NCs in this window
  // — explicitly zero rather than ambiguous "—").
  // Track which Redshift rows we successfully attached so we can bucket the rest
  // into "Other [Channel]" synthetic rows below.
  const consumed = new Set<string>();
  function rsKey(source: string, campaign: string): string { return `${source}|${campaign}`; }

  // Re-walk rsRows so we know which are consumed by direct-row attachment.
  // (The byId/byName maps lost source/campaign granularity when aggregating.)
  // For accuracy, we iterate rsRows and check if each row would land on an attached campaign.
  const matchedCampaignIds = new Set<string>();
  const matchedNames = new Set<string>();
  const matchedNormNames = new Set<string>();
  for (const row of rows) {
    if (row.campaign_id && byId.has(row.campaign_id)) matchedCampaignIds.add(row.campaign_id);
    if (row.campaign_name) {
      const lc = row.campaign_name.toLowerCase();
      const nm = normalize(row.campaign_name);
      if (byName.has(lc)) matchedNames.add(lc);
      if (byNormName.has(nm)) matchedNormNames.add(nm);
    }
  }
  for (const r of rsRows) {
    let attributed = false;
    if (/^\d+$/.test(r.utm_campaign)) {
      const cid = adIdToCampaignId.get(r.utm_campaign) ?? r.utm_campaign;
      if (matchedCampaignIds.has(cid)) attributed = true;
    } else {
      const lcKey = r.utm_campaign.toLowerCase();
      const normKey = normalize(r.utm_campaign);
      const skuTarget = skuToCampaignId.get(lcKey);
      const agTarget = agNameToCampaignId.get(lcKey) ?? agNameToCampaignId.get(normKey);
      if ((skuTarget && matchedCampaignIds.has(skuTarget))
          || (agTarget && matchedCampaignIds.has(agTarget))
          || matchedNames.has(lcKey)
          || matchedNormNames.has(normKey)) {
        attributed = true;
      }
    }
    if (attributed) consumed.add(rsKey(r.utm_source, r.utm_campaign));
  }

  const attachedRows = rows.map((row) => {
    let rs = row.campaign_id ? byId.get(row.campaign_id) : undefined;
    if (!rs && row.campaign_name) {
      rs = byName.get(row.campaign_name.toLowerCase())
        ?? byNormName.get(normalize(row.campaign_name));
    }
    return { ...row, metrics: attachRedshiftMetrics(row.metrics, rs ?? { ncs: 0, amount: 0 }) };
  });

  // Synthesize "Other [Channel]" rows for residual Redshift rows that didn't
  // attach to any Google Ads campaign. These have cost=0 (no spend attribution)
  // but real NCs/amount, so brand-level NC totals reconcile with the per-campaign
  // table once the user adds them up.
  const residualBySource = new Map<string, { ncs: number; amount: number; samples: string[] }>();
  for (const r of rsRows) {
    if (consumed.has(rsKey(r.utm_source, r.utm_campaign))) continue;
    const prev = residualBySource.get(r.utm_source) ?? { ncs: 0, amount: 0, samples: [] };
    prev.ncs += r.ncs;
    prev.amount += r.amount;
    if (prev.samples.length < 5) prev.samples.push(r.utm_campaign);
    residualBySource.set(r.utm_source, prev);
  }

  for (const [source, residual] of residualBySource) {
    if (residual.ncs <= 0 && residual.amount <= 0) continue;
    attachedRows.push(buildOtherRow(source, residual.ncs, residual.amount, residual.samples));
  }

  return attachedRows;
}

function buildOtherRow(utmSource: string, ncs: number, amount: number, samples: string[]): Row {
  // Map utm_source → channel_type + display label so the synthetic row mirrors a
  // real campaign row's shape (filterable, sortable, etc.).
  const channel =
    utmSource.toLowerCase().includes('pmax') ? { type: 'PERFORMANCE_MAX', label: 'Other PMax' }
    : utmSource.toLowerCase().includes('search') ? { type: 'SEARCH', label: 'Other Search' }
    : utmSource.toLowerCase().includes('pla') ? { type: 'SHOPPING', label: 'Other Shopping' }
    : utmSource.toLowerCase().includes('dg') || utmSource.toLowerCase().includes('demand') ? { type: 'DEMAND_GEN', label: 'Other Demand Gen' }
    : { type: 'OTHER', label: `Other (${utmSource})` };

  // calc_roas is undefined for synthetic rows because we have no cost
  // (we know NCs came in from this source but not which campaign drove them).
  const baseMetrics = {
    cost_micros: 0, impressions: 0, clicks: 0, conversions: 0, conversions_value: 0,
    view_through_conversions: 0,
    cost: 0, ctr: 0, cpc: 0, cpm: 0, cpa: 0,
    roas_pre_rto: 0, conversions_value_post_rto: amount, roas_post_rto: 0,
    ncs, ncs_amount: amount,
    aov: ncs > 0 ? amount / ncs : 0,
    calc_cpa: null,    // no cost → CPA is undefined
    calc_roas: null,   // no cost → ROAS is undefined
  };

  return {
    customer_id: '',
    campaign_id: `__synthetic_${utmSource}`,
    campaign_name: channel.label,
    channel_type: channel.type,
    status: 'ENABLED',
    synthetic: true,
    synthetic_samples: samples,
    metrics: baseMetrics,
  } as Row;
}

/**
 * Build an {asset_group_name (lowercase) → campaign_id} index for PMax asset groups
 * in the given window. PMax tracking templates sometimes use the asset group name
 * verbatim as utm_campaign (e.g. 'Nutrimix-2', 'IBK', 'MV') instead of the campaign ID.
 *
 * If the same asset_group_name appears in multiple campaigns, picks the highest-spend.
 */
async function buildAssetGroupNameToCampaignIdMap(
  customerIds: string[],
  from: string,
  to: string
): Promise<Map<string, string>> {
  if (!customerIds.length) return new Map();
  const query = `
    SELECT campaign.id, asset_group.name, metrics.cost_micros
    FROM asset_group
    WHERE segments.date BETWEEN '${from}' AND '${to}'
      AND asset_group.status != 'REMOVED'
      AND metrics.cost_micros > 0
  `.trim();
  const perAccount = await Promise.all(
    customerIds.map(async (cid) => {
      try {
        const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
        return await search<{
          campaign?: { id?: string };
          assetGroup?: { name?: string };
          metrics?: { costMicros?: string };
        }>({ customerId: cid, loginCustomerId, query });
      } catch (err) {
        console.error(`[ag-name-map] customer ${cid} failed:`, err instanceof Error ? err.message : String(err));
        return [];
      }
    })
  );
  const nameToCampaignCosts = new Map<string, Map<string, number>>();
  for (const rows of perAccount) {
    for (const r of rows) {
      const name = r.assetGroup?.name?.toLowerCase();
      const cid = r.campaign?.id;
      const cost = Number(r.metrics?.costMicros ?? 0);
      if (!name || !cid) continue;
      let inner = nameToCampaignCosts.get(name);
      if (!inner) { inner = new Map(); nameToCampaignCosts.set(name, inner); }
      inner.set(cid, (inner.get(cid) ?? 0) + cost);
    }
  }
  // Index by both lowercase and alphanumeric-normalized name to catch tracking
  // templates that use 'brain_gummies' for asset group 'Brain Gummies'.
  const result = new Map<string, string>();
  for (const [name, costs] of nameToCampaignCosts) {
    let bestCid = '';
    let bestCost = -1;
    for (const [cid, cost] of costs) {
      if (cost > bestCost) { bestCost = cost; bestCid = cid; }
    }
    if (bestCid) {
      result.set(name, bestCid);
      const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!result.has(normalized)) result.set(normalized, bestCid);
    }
  }
  return result;
}

/**
 * Build a {sku (lowercase) → campaign_id} index for products served by Shopping
 * campaigns in the given window. Used to resolve utm_campaign values that are
 * SKU codes (Shopping campaigns using the {product_id} macro).
 *
 * If a SKU runs in multiple Shopping campaigns, picks the highest-spend one
 * deterministically (sufficient for v1; weighted attribution can come later).
 */
async function buildSkuToCampaignIdMap(
  customerIds: string[],
  from: string,
  to: string
): Promise<Map<string, string>> {
  if (!customerIds.length) return new Map();
  const query = `
    SELECT campaign.id, campaign.advertising_channel_type, segments.product_item_id, metrics.cost_micros
    FROM shopping_performance_view
    WHERE segments.date BETWEEN '${from}' AND '${to}'
      AND campaign.advertising_channel_type = 'SHOPPING'
      AND metrics.cost_micros > 0
  `.trim();
  const perAccount = await Promise.all(
    customerIds.map(async (cid) => {
      try {
        const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
        return await search<{
          campaign?: { id?: string };
          segments?: { productItemId?: string };
          metrics?: { costMicros?: string };
        }>({ customerId: cid, loginCustomerId, query });
      } catch (err) {
        console.error(`[sku-map] customer ${cid} failed:`, err instanceof Error ? err.message : String(err));
        return [];
      }
    })
  );
  // (sku → { campaign_id → cost_micros }) → pick max
  const skuToCampaignCosts = new Map<string, Map<string, number>>();
  for (const rows of perAccount) {
    for (const r of rows) {
      const sku = r.segments?.productItemId?.toLowerCase();
      const cid = r.campaign?.id;
      const cost = Number(r.metrics?.costMicros ?? 0);
      if (!sku || !cid) continue;
      let inner = skuToCampaignCosts.get(sku);
      if (!inner) { inner = new Map(); skuToCampaignCosts.set(sku, inner); }
      inner.set(cid, (inner.get(cid) ?? 0) + cost);
    }
  }
  const result = new Map<string, string>();
  for (const [sku, costs] of skuToCampaignCosts) {
    let bestCid = '';
    let bestCost = -1;
    for (const [cid, cost] of costs) {
      if (cost > bestCost) { bestCost = cost; bestCid = cid; }
    }
    if (bestCid) result.set(sku, bestCid);
  }
  return result;
}

/**
 * Build a {ad_id → campaign_id} index for all active ads across the given customer accounts.
 * Used to resolve utm_campaign values that are actually ad IDs (Search campaigns using
 * the {creative} macro in their tracking template).
 */
async function buildAdIdToCampaignIdMap(customerIds: string[]): Promise<Map<string, string>> {
  if (!customerIds.length) return new Map();
  const query = `SELECT campaign.id, ad_group_ad.ad.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'`;
  const perAccount = await Promise.all(
    customerIds.map(async (cid) => {
      try {
        const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
        return await search<{ campaign?: { id?: string }; adGroupAd?: { ad?: { id?: string } } }>({
          customerId: cid,
          loginCustomerId,
          query,
        });
      } catch {
        return [];
      }
    })
  );
  const map = new Map<string, string>();
  for (const rows of perAccount) {
    for (const r of rows) {
      const adId = r.adGroupAd?.ad?.id;
      const campaignId = r.campaign?.id;
      if (adId && campaignId) map.set(adId, campaignId);
    }
  }
  return map;
}

function shapeRow(level: Level, customerId: string, r: GoogleAdsRow): Row {
  const base: Row = {
    customer_id: customerId,
    metrics: applyFlatRto(deriveMetrics(emptyRaw()), 0), // placeholder; overwritten on aggregate
  };
  if (r.campaign?.id) {
    base.campaign_id = r.campaign.id;
    base.campaign_name = r.campaign.name;
  }
  if (level === 'campaign') {
    base.status = r.campaign?.status;
    base.channel_type = r.campaign?.advertisingChannelType;
    base.bidding_strategy_type = r.campaign?.biddingStrategyType;
    if (r.campaignBudget?.amountMicros) {
      base.daily_budget_inr = Number(r.campaignBudget.amountMicros) / MICROS;
    }
  }
  if (level === 'ad_group' || level === 'ad' || level === 'keyword') {
    base.ad_group_id = r.adGroup?.id;
    base.ad_group_name = r.adGroup?.name;
  }
  if (level === 'ad_group') {
    base.status = r.adGroup?.status;
    if (r.adGroup?.cpcBidMicros) base.cpc_bid_inr = Number(r.adGroup.cpcBidMicros) / MICROS;
  }
  if (level === 'asset_group') {
    base.asset_group_id = r.assetGroup?.id;
    base.asset_group_name = r.assetGroup?.name;
    base.status = r.assetGroup?.status;
    base.ad_strength = r.assetGroup?.adStrength;
    base.path1 = r.assetGroup?.path1;
    base.path2 = r.assetGroup?.path2;
    base.final_urls = r.assetGroup?.finalUrls;
    base.channel_type = r.campaign?.advertisingChannelType;
  }
  if (level === 'ad') {
    base.ad_id = r.adGroupAd?.ad?.id;
    base.ad_name = r.adGroupAd?.ad?.name;
    base.ad_type = r.adGroupAd?.ad?.type;
    base.status = r.adGroupAd?.status;
    base.headlines = (r.adGroupAd?.ad?.responsiveSearchAd?.headlines ?? [])
      .map((h) => h.text ?? '')
      .filter(Boolean);
    base.descriptions = (r.adGroupAd?.ad?.responsiveSearchAd?.descriptions ?? [])
      .map((d) => d.text ?? '')
      .filter(Boolean);
    base.final_urls = r.adGroupAd?.ad?.finalUrls ?? [];
  }
  if (level === 'keyword') {
    base.criterion_id = r.adGroupCriterion?.criterionId;
    base.keyword_text = r.adGroupCriterion?.keyword?.text;
    base.match_type = r.adGroupCriterion?.keyword?.matchType;
    base.status = r.adGroupCriterion?.status;
    base.quality_score = r.adGroupCriterion?.qualityInfo?.qualityScore;
  }
  if (level === 'search_term') {
    base.search_term = r.searchTermView?.searchTerm;
    base.status = r.searchTermView?.status;
    base.match_type = r.segments?.searchTermMatchType;
  }
  return base;
}

function rowKey(level: Level, row: Row): string {
  if (level === 'campaign') return `${row.customer_id}|${row.campaign_id}`;
  if (level === 'ad_group') return `${row.customer_id}|${row.ad_group_id}`;
  if (level === 'asset_group') return `${row.customer_id}|${row.asset_group_id}`;
  if (level === 'keyword') return `${row.customer_id}|${row.ad_group_id}|${row.criterion_id}`;
  if (level === 'search_term') return `${row.customer_id}|${row.ad_group_id}|${row.search_term}`;
  return `${row.customer_id}|${row.ad_id}`;
}

export async function performanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  for (const level of ['campaign', 'ad_group', 'asset_group', 'ad', 'keyword', 'search_term'] as const) {
    const path = level === 'campaign' ? '/campaigns'
      : level === 'ad_group' ? '/ad-groups'
      : level === 'asset_group' ? '/asset-groups'
      : level === 'ad' ? '/ads'
      : level === 'keyword' ? '/keywords'
      : '/search-terms';

    app.get(path, async (req, reply) => {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const q = parsed.data;

      try {
        const primary = await fetchRowsForBrand(
          level, q.brand_id, q.from, q.to, q.campaign_id, q.ad_group_id, q.asset_group_id
        );

        if (q.compare_from && q.compare_to) {
          const compare = await fetchRowsForBrand(
            level, q.brand_id, q.compare_from, q.compare_to, q.campaign_id, q.ad_group_id, q.asset_group_id
          );
          const compareByKey = new Map(compare.map((r) => [rowKey(level, r), r]));
          for (const r of primary) {
            const c = compareByKey.get(rowKey(level, r));
            if (c) r.comparison = c.metrics;
          }
        }

        // Brand-wide Redshift totals (only at campaign level — for KPI strip).
        // Independent of per-row matching, so NCs total stays accurate even when
        // some campaigns can't be linked via utm_campaign.
        let brand_redshift_totals: { primary?: BrandRsTotal; compare?: BrandRsTotal } | undefined;
        if (level === 'campaign') {
          brand_redshift_totals = await tryFetchBrandTotals(
            q.brand_id,
            q.from, q.to,
            q.compare_from, q.compare_to
          );
        }

        return { rows: primary, brand_redshift_totals };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error({ err: message }, `${level} fetch failed`);
        return reply.code(500).send({ error: message });
      }
    });
  }
}
