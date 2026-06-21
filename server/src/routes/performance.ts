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
  buildPmaxSearchTermsQuery,
  buildCurrentCampaignBudgetsQuery,
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
import { fetchByCampaignDaily, fetchTotal } from '../services/redshift.js';
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

export interface Row {
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
  ad_group_target_cpa_inr?: number;
  ad_group_target_roas?: number;
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
    targetCpaMicros?: string;
    targetRoas?: number;
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
      appAd?: {
        headlines?: Array<{ text?: string }>;
        descriptions?: Array<{ text?: string }>;
      };
      responsiveDisplayAd?: {
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

export async function fetchRowsForBrand(
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

  // The date-segmented campaign query returns a campaign_budget snapshot per
  // date, and our aggregator only consumed the FIRST row's value — meaning a
  // budget changed mid-window showed up as the historical amount, not the
  // current one. Override with a tiny un-segmented "current budget" query so
  // both the dashboard and any action (e.g. update_budget recommendations)
  // see the live amount.
  if (level === 'campaign') {
    const budgetsByKey = new Map<string, number>(); // customer_id|campaign_id → ₹/day
    const budgetQuery = buildCurrentCampaignBudgetsQuery({ campaignIds: campaignId ? [campaignId] : undefined });
    const perAccountBudgets = await Promise.all(
      brand.accounts.map(async (acc) => {
        const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
        try {
          const bRows = await search<{ campaign?: { id?: string }; campaignBudget?: { amountMicros?: string } }>(
            { customerId: acc.customer_id, loginCustomerId, query: budgetQuery }
          );
          return { customerId: acc.customer_id, rows: bRows };
        } catch { return { customerId: acc.customer_id, rows: [] }; }
      })
    );
    for (const { customerId, rows: bRows } of perAccountBudgets) {
      for (const b of bRows) {
        if (!b.campaign?.id || !b.campaignBudget?.amountMicros) continue;
        budgetsByKey.set(`${customerId}|${b.campaign.id}`, Number(b.campaignBudget.amountMicros) / MICROS);
      }
    }
    rows = rows.map((r) => {
      const cur = r.campaign_id ? budgetsByKey.get(`${r.customer_id}|${r.campaign_id}`) : undefined;
      return cur != null ? { ...r, daily_budget_inr: cur } : r;
    });
  }

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
  utm_campaign_aliases: string | null;
  enabled: number;
}

interface BrandRsTotal {
  ncs: number;
  amount: number;
}

interface NetworkSplitEntry {
  network: string;       // SEARCH | SEARCH_PARTNERS | CONTENT | YOUTUBE | PMAX_MIXED | OTHER
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
}

interface PmaxChannelEntry {
  channel: string;
  cost: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

function fieldTypeToChannel(fieldType: string): string {
  switch (fieldType) {
    case 'HEADLINE': case 'LONG_HEADLINE': case 'DESCRIPTION':
    case 'SITELINK': case 'CALLOUT': case 'STRUCTURED_SNIPPET':
    case 'CALL': case 'PRICE': case 'PROMOTION': case 'LEAD_FORM':
      return 'Search';
    case 'MARKETING_IMAGE': case 'SQUARE_MARKETING_IMAGE':
    case 'PORTRAIT_MARKETING_IMAGE': case 'LOGO': case 'LANDSCAPE_LOGO':
      return 'Display';
    case 'YOUTUBE_VIDEO': return 'YouTube';
    case 'BUSINESS_NAME': case 'CALL_TO_ACTION_SELECTION': return 'Shared';
    default: return 'Other';
  }
}

/**
 * Brand-wide PMax channel breakdown via channel_aggregate_asset_view.
 * Sums asset-level cost across ALL PMax campaigns in the brand. Numbers are
 * accurate at brand level (no per-campaign cross-attribution issue).
 */
export async function fetchBrandPmaxChannelSplit(
  brandId: number, from: string, to: string
): Promise<PmaxChannelEntry[]> {
  const brand = getBrand(brandId);
  if (!brand?.accounts.length) return [];

  const query = `
    SELECT channel_aggregate_asset_view.field_type,
           metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
    FROM channel_aggregate_asset_view
    WHERE segments.date BETWEEN '${from}' AND '${to}'
      AND channel_aggregate_asset_view.advertising_channel_type = 'PERFORMANCE_MAX'
  `.trim();

  const perAccount = await Promise.all(
    brand.accounts.map(async (acc) => {
      try {
        const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
        return await search<{
          channelAggregateAssetView?: { fieldType?: string };
          metrics?: Record<string, unknown>;
        }>({ customerId: acc.customer_id, loginCustomerId, query });
      } catch {
        return [];
      }
    })
  );

  const buckets = new Map<string, PmaxChannelEntry>();
  for (const rows of perAccount) {
    for (const r of rows) {
      const ft = r.channelAggregateAssetView?.fieldType ?? 'UNKNOWN';
      const channel = fieldTypeToChannel(ft);
      const b = buckets.get(channel) ?? { channel, cost: 0, impressions: 0, clicks: 0, conversions: 0 };
      const m = r.metrics ?? {};
      b.cost += Number(m.costMicros ?? 0) / 1_000_000;
      b.impressions += Number(m.impressions ?? 0);
      b.clicks += Number(m.clicks ?? 0);
      b.conversions += Number(m.conversions ?? 0);
      buckets.set(channel, b);
    }
  }
  return Array.from(buckets.values()).sort((a, b) => b.cost - a.cost);
}

/** Brand-level spend split by ad network (Search vs Display vs YouTube vs PMax-mixed). */
export async function fetchNetworkSplit(brandId: number, from: string, to: string): Promise<NetworkSplitEntry[]> {
  const brand = getBrand(brandId);
  if (!brand?.accounts.length) return [];
  const query = `
    SELECT campaign.advertising_channel_type, segments.ad_network_type,
           metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
    FROM campaign
    WHERE segments.date BETWEEN '${from}' AND '${to}'
      AND metrics.cost_micros > 0
  `.trim();

  const perAccount = await Promise.all(
    brand.accounts.map(async (acc) => {
      try {
        const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
        return await search<{
          campaign?: { advertisingChannelType?: string };
          segments?: { adNetworkType?: string };
          metrics?: Record<string, unknown>;
        }>({ customerId: acc.customer_id, loginCustomerId, query });
      } catch {
        return [];
      }
    })
  );

  const buckets = new Map<string, NetworkSplitEntry>();
  function bucket(network: string): NetworkSplitEntry {
    const existing = buckets.get(network);
    if (existing) return existing;
    const fresh = { network, cost: 0, clicks: 0, impressions: 0, conversions: 0 };
    buckets.set(network, fresh);
    return fresh;
  }

  for (const rows of perAccount) {
    for (const r of rows) {
      const channel = r.campaign?.advertisingChannelType ?? 'UNKNOWN';
      const rawNetwork = r.segments?.adNetworkType ?? 'UNKNOWN';
      // For PMax campaigns, ad_network_type returns MIXED — Google doesn't expose
      // the per-network split via reporting API. Bucket these as 'PMAX (mixed)'.
      const network = channel === 'PERFORMANCE_MAX'
        ? 'PMax (mixed)'
        : rawNetwork === 'CONTENT' ? 'Display'
        : rawNetwork === 'SEARCH' ? 'Search'
        : rawNetwork === 'SEARCH_PARTNERS' ? 'Search Partners'
        : rawNetwork === 'YOUTUBE' || rawNetwork === 'YOUTUBE_WATCH' || rawNetwork === 'YOUTUBE_SEARCH' ? 'YouTube'
        : rawNetwork === 'GOOGLE_TV' ? 'Google TV'
        : rawNetwork.replace(/_/g, ' ');
      const e = bucket(network);
      const m = r.metrics ?? {};
      e.cost += Number(m.costMicros ?? 0) / 1_000_000;
      e.clicks += Number(m.clicks ?? 0);
      e.impressions += Number(m.impressions ?? 0);
      e.conversions += Number(m.conversions ?? 0);
    }
  }

  return Array.from(buckets.values()).sort((a, b) => b.cost - a.cost);
}

export async function tryFetchBrandTotals(
  brandId: number,
  from: string, to: string,
  compareFrom?: string, compareTo?: string
): Promise<{ primary?: BrandRsTotal; compare?: BrandRsTotal } | undefined> {
  const cfg = getDb()
    .prepare('SELECT brand_id, funnel_table, utm_source_list, utm_campaign_aliases, enabled FROM brand_redshift_config WHERE brand_id = ?')
    .get(brandId) as BrandRedshiftRow | undefined;
  if (!cfg || !cfg.enabled || !cfg.funnel_table) return undefined;
  let utmSourceList: string[] = [];
  try { utmSourceList = JSON.parse(cfg.utm_source_list ?? '[]'); } catch { /* ignore */ }
  if (utmSourceList.length === 0) return undefined;

  // Apply the brand's NC + revenue RTO factors on top of the gross funnel numbers,
  // so KPI strip totals match the per-row Calc ROAS / NCs.
  const brand = getBrand(brandId);
  const ncFactor = brand?.rto_factor ?? 0;
  const revFactor = brand?.revenue_rto_factor ?? brand?.rto_factor ?? 0;
  const adj = (n: number, factor: number) => n * (1 - Math.max(0, Math.min(1, factor)));

  const primary = await fetchTotal({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: from, dateTo: to });
  let compare: BrandRsTotal | undefined;
  if (compareFrom && compareTo) {
    const c = await fetchTotal({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: compareFrom, dateTo: compareTo });
    compare = { ncs: adj(c.ncs, ncFactor), amount: adj(c.amount, revFactor) };
  }
  return {
    primary: { ncs: adj(primary.ncs, ncFactor), amount: adj(primary.amount, revFactor) },
    compare,
  };
}

async function mergeRedshiftMetrics(rows: Row[], brandId: number, from: string, to: string): Promise<Row[]> {
  const cfg = getDb()
    .prepare('SELECT brand_id, funnel_table, utm_source_list, utm_campaign_aliases, enabled FROM brand_redshift_config WHERE brand_id = ?')
    .get(brandId) as BrandRedshiftRow | undefined;
  if (!cfg || !cfg.enabled || !cfg.funnel_table) return rows;
  let utmSourceList: string[] = [];
  try { utmSourceList = JSON.parse(cfg.utm_source_list ?? '[]'); } catch { /* ignore */ }
  if (utmSourceList.length === 0) return rows;

  // Brand-level alias map: { "IBK": "Immunity Boosting Kit", "PDP": "All Products", … }
  // Keys are matched case-insensitively against the raw utm_campaign value;
  // value is the asset_group_name (or campaign_name) that the funnel-side tag
  // should resolve to.
  let aliases: Record<string, string> = {};
  try {
    const raw = JSON.parse(cfg.utm_campaign_aliases ?? '{}');
    if (raw && typeof raw === 'object') {
      aliases = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [String(k).toLowerCase(), String(v)]),
      );
    }
  } catch { /* ignore */ }

  // Fetch Redshift NCs + Google indexes + per-day cost (for the per-date
  // active gate on asset-group splits) in parallel.
  // ad_id map:           Search campaigns use {creative} → utm_campaign holds AD ID
  // sku map:             Shopping campaigns use {product_id} → utm_campaign holds SKU
  // asset_group_name map: PMax campaigns sometimes use the asset group name verbatim
  //                       (e.g. 'Nutrimix-2', 'IBK') in their tracking template
  const brand = getBrand(brandId);
  const accountIds = brand?.accounts.map((a) => a.customer_id) ?? [];
  const [dailyRs, adIdToCampaignId, skuToCampaignId, agNameToCampaignId, utmFinalUrlsMap, activeByDate] = await Promise.all([
    fetchByCampaignDaily({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: from, dateTo: to }),
    buildAdIdToCampaignIdMap(accountIds),
    buildSkuToCampaignIdMap(accountIds, from, to),
    buildAssetGroupNameToCampaignIdMap(accountIds, from, to),
    buildUtmCampaignFromFinalUrlsMap(accountIds, from, to),
    buildActiveByDate(accountIds, from, to),
  ]);

  // utm_campaign is sometimes the Google Ads campaign ID (e.g. "23223219977"),
  // sometimes a custom name (e.g. "LJ_shopping_Manual_Generic_MVChocolate"),
  // and sometimes a SKU code (e.g. "MWLJNTP.00480.B0_N"). The funnel table is the
  // only attribution we have — there's no gclid, utm_term, or utm_content stored.
  //
  // Per-day walk with per-date active gate on the asset-group 1/N split so a
  // campaign paused on the conversion date can't absorb credit for it. Other
  // rules (numeric id, SKU, exact name match) intentionally still attribute
  // to paused campaigns — those are explicit "the URL named this campaign"
  // matches that the user confirmed should pass through.
  const byId = new Map<string, { ncs: number; amount: number }>();

  function normalize(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  function add(map: Map<string, { ncs: number; amount: number }>, k: string, v: { ncs: number; amount: number }) {
    const prev = map.get(k);
    map.set(k, prev ? { ncs: prev.ncs + v.ncs, amount: prev.amount + v.amount } : v);
  }

  // Track consumed per (source, utm_campaign) so the synthetic "Other" residual
  // catches only Redshift rows we couldn't attribute.
  const consumed = new Set<string>();
  function rsKey(source: string, campaign: string): string { return `${source}|${campaign}`; }

  // Gate: only credit byId entries for campaigns that actually appear in
  // `rows`. Otherwise the NCs sit orphaned in byId (never attached to any
  // row) and silently drop — should flow to "Other [Channel]" instead.
  const knownCampaignIds = new Set<string>();
  const nameToCampaignId = new Map<string, string>();
  const normNameToCampaignId = new Map<string, string>();
  for (const row of rows) {
    if (row.campaign_id) knownCampaignIds.add(row.campaign_id);
    if (row.campaign_id && row.campaign_name) {
      nameToCampaignId.set(row.campaign_name.toLowerCase(), row.campaign_id);
      normNameToCampaignId.set(normalize(row.campaign_name), row.campaign_id);
    }
  }

  for (const r of dailyRs) {
    const entry = { ncs: r.ncs, amount: r.amount };
    if (/^\d+$/.test(r.utm_campaign)) {
      const target = adIdToCampaignId.get(r.utm_campaign) ?? r.utm_campaign;
      if (knownCampaignIds.has(target)) {
        add(byId, target, entry);
        consumed.add(rsKey(r.utm_source, r.utm_campaign));
      }
      continue;
    }
    const aliasedCampaign = aliases[r.utm_campaign.toLowerCase()] ?? r.utm_campaign;
    const lcKey = aliasedCampaign.toLowerCase();
    const normKey = normalize(aliasedCampaign);
    const skuTarget = skuToCampaignId.get(lcKey);
    if (skuTarget && knownCampaignIds.has(skuTarget)) {
      add(byId, skuTarget, entry);
      consumed.add(rsKey(r.utm_source, r.utm_campaign));
      continue;
    }
    // Authoritative map: utm_campaign value extracted from each PMax campaign's
    // asset_group.final_urls. This is Google's own record of "which campaigns
    // bake this utm_campaign string into their click URLs" — preferred over
    // fuzzy asset-group-NAME matching. Filter to campaigns active that date.
    const finalUrlTargets = utmFinalUrlsMap.get(lcKey) ?? utmFinalUrlsMap.get(normKey);
    if (finalUrlTargets && finalUrlTargets.length) {
      const activeToday = activeByDate.get(r.date) ?? new Set<string>();
      const active = finalUrlTargets.filter((cid) => activeToday.has(cid) && knownCampaignIds.has(cid));
      if (active.length) {
        const share = { ncs: r.ncs / active.length, amount: r.amount / active.length };
        for (const cid of active) add(byId, cid, share);
        consumed.add(rsKey(r.utm_source, r.utm_campaign));
        continue;
      }
      // If none of the canonical owners are active that day, fall through to
      // asset-group-name matching (less reliable) — and if THAT also has no
      // active sibling that day, the NC lands in synthetic "Other".
    }
    const agTargets = agNameToCampaignId.get(lcKey) ?? agNameToCampaignId.get(normKey);
    if (agTargets && agTargets.length) {
      // Per-date active gate: include a campaign in the 1/N split only if it
      // had cost > 0 ON r.date. A campaign paused mid-window doesn't get
      // asset-group credit for orders placed while it was paused.
      const activeToday = activeByDate.get(r.date) ?? new Set<string>();
      const active = agTargets.filter((cid) => activeToday.has(cid) && knownCampaignIds.has(cid));
      if (!active.length) continue;
      const share = { ncs: r.ncs / active.length, amount: r.amount / active.length };
      for (const cid of active) add(byId, cid, share);
      consumed.add(rsKey(r.utm_source, r.utm_campaign));
      continue;
    }
    // byName fallback: per-date active gate. Same rule as the asset-group /
    // final_urls paths — a paused campaign whose name appears in final_url_suffix
    // (e.g. Search_Brand_MM) can't have served the click that day, so its
    // name match doesn't earn the NC. If no active campaign owns the string
    // deterministically, the row flows to "Other [Channel]".
    const nameTarget = nameToCampaignId.get(lcKey) ?? normNameToCampaignId.get(normKey);
    if (nameTarget) {
      const activeToday = activeByDate.get(r.date) ?? new Set<string>();
      if (activeToday.has(nameTarget)) {
        add(byId, nameTarget, entry);
        consumed.add(rsKey(r.utm_source, r.utm_campaign));
      }
      // else: matched a paused campaign → don't attribute → falls to "Other"
    }
  }

  // All attribution paths (numeric, SKU, final_urls, asset-group name,
  // byName) are now handled inline in the main loop with consumed marking.
  // No post-loop pass needed — anything still unconsumed flows to "Other".

  const attachedRows = rows.map((row) => {
    const rs = row.campaign_id ? byId.get(row.campaign_id) : undefined;
    return {
      ...row,
      metrics: attachRedshiftMetrics(
        row.metrics,
        rs ?? { ncs: 0, amount: 0 },
        { nc: brand?.rto_factor ?? 0, revenue: brand?.revenue_rto_factor ?? brand?.rto_factor ?? 0 },
      ),
    };
  });

  // Synthesize "Other [Channel]" rows for residual Redshift rows that didn't
  // attach to any Google Ads campaign. These have cost=0 (no spend attribution)
  // but real NCs/amount, so brand-level NC totals reconcile with the per-campaign
  // table once the user adds them up.
  const residualBySource = new Map<string, { ncs: number; amount: number; samples: string[] }>();
  for (const r of dailyRs) {
    if (consumed.has(rsKey(r.utm_source, r.utm_campaign))) continue;
    const prev = residualBySource.get(r.utm_source) ?? { ncs: 0, amount: 0, samples: [] };
    prev.ncs += r.ncs;
    prev.amount += r.amount;
    if (prev.samples.length < 5 && !prev.samples.includes(r.utm_campaign)) prev.samples.push(r.utm_campaign);
    residualBySource.set(r.utm_source, prev);
  }

  // Apply the same flat RTO factor we apply to real campaign NCs (via
  // attachRedshiftMetrics) — synthetic Other rows showed pre-RTO NCs before,
  // which made the Campaigns tab disagree with the Daily pivot at exactly
  // the RTO factor (e.g. LJ Other 439 / 0.9 = 395 = Daily's Other). Project
  // convention is all NCs displayed post-RTO.
  const ncMul = 1 - (brand?.rto_factor ?? 0);
  const revMul = 1 - (brand?.revenue_rto_factor ?? brand?.rto_factor ?? 0);
  for (const [source, residual] of residualBySource) {
    if (residual.ncs <= 0 && residual.amount <= 0) continue;
    attachedRows.push(buildOtherRow(source, residual.ncs * ncMul, residual.amount * revMul, residual.samples));
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
 * Build an {asset_group_name → [campaign_id, …]} index for PMax asset groups
 * in the given window. PMax tracking templates sometimes use the asset group
 * name verbatim as utm_campaign (e.g. 'Nutrimix', 'IBK', 'MV') instead of the
 * campaign ID.
 *
 * Same asset_group_name often lives in multiple campaigns (e.g. "Nutrimix"
 * exists as an asset group in 3 different PMax campaigns). We return ALL the
 * candidate campaign IDs so the caller can distribute NCs equally across
 * them (1/N each) — see services/redshift attribution rules.
 *
 * Indexed by both lowercase and alphanumeric-normalized name so tracking
 * templates that use 'brain_gummies' resolve to asset group 'Brain Gummies'.
 */
/**
 * Build {utm_campaign-value → Set<campaign_id>} by parsing every utm_campaign
 * token Google Ads ACTUALLY emits in click URLs — sourced from TWO endpoints:
 *
 *   1. landing_page_view.unexpanded_final_url — the URLs Google generates for
 *      clicks on each campaign, including ad-level final_urls + sitelinks +
 *      extensions + Final URL Expansion + the {ignore} macro behavior.
 *   2. asset_group.final_urls — PMax-only config; included as a belt-and-
 *      braces fallback for asset_groups whose URLs haven't served clicks in
 *      the window (and so wouldn't appear in landing_page_view).
 *
 * Why: Magento's URL parser stores whichever utm_campaign value lands in the
 * order URL (sometimes the auto-tagged `{creative}`/`{campaignid}` form,
 * sometimes a hardcoded asset/sitelink string like `Search_Brand_MM`). We
 * need to know which CAMPAIGNS actually emit each utm_campaign string. Then
 * for orders tagged with that string, attribute to the campaign(s) that
 * own it — filtered to those active on the conversion date.
 *
 * Indexed by both lowercase and alphanumeric-normalized forms.
 */
export async function buildUtmCampaignFromFinalUrlsMap(
  customerIds: string[],
  from?: string,
  to?: string,
): Promise<Map<string, string[]>> {
  if (!customerIds.length) return new Map();
  const byUtm = new Map<string, Set<string>>();
  const extract = (url: string): string[] => {
    let s = url; try { s = decodeURIComponent(url); } catch { /* */ }
    const out: string[] = [];
    const re = /[?&]utm_campaign=([^&#]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) if (m[1] && !out.includes(m[1])) out.push(m[1]);
    return out;
  };

  // Default landing_page_view window to last 30 days if no window passed.
  // landing_page_view requires a date range; we use the attribution window so
  // we capture URLs Google emitted for clicks that could plausibly be
  // converting in this same window.
  const lpvFrom = from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const lpvTo = to ?? new Date().toISOString().slice(0, 10);

  await Promise.all(customerIds.map(async (cid) => {
    const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
    // (1) landing_page_view — covers ALL channel types
    try {
      const rows = await search<{
        campaign?: { id?: string };
        landingPageView?: { unexpandedFinalUrl?: string };
      }>({
        customerId: cid, loginCustomerId,
        query: `SELECT campaign.id, landing_page_view.unexpanded_final_url
                FROM landing_page_view
                WHERE segments.date BETWEEN '${lpvFrom}' AND '${lpvTo}'`,
      });
      for (const r of rows) {
        const id = r.campaign?.id; const url = r.landingPageView?.unexpandedFinalUrl;
        if (!id || !url) continue;
        for (const v of extract(url)) {
          const lc = v.toLowerCase();
          let s = byUtm.get(lc); if (!s) { s = new Set(); byUtm.set(lc, s); }
          s.add(id);
        }
      }
    } catch (err) {
      console.error(`[utm-lpv] customer ${cid} failed:`, err instanceof Error ? err.message : String(err));
    }
    // (2) asset_group.final_urls — PMax-only fallback for configured URLs
    //     that haven't served clicks in window
    try {
      const rows = await search<{
        campaign?: { id?: string };
        assetGroup?: { finalUrls?: string[] };
      }>({
        customerId: cid, loginCustomerId,
        query: `SELECT campaign.id, asset_group.final_urls
                FROM asset_group
                WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
                  AND campaign.status != 'REMOVED'`,
      });
      for (const r of rows) {
        const id = r.campaign?.id; if (!id) continue;
        for (const url of r.assetGroup?.finalUrls ?? []) {
          for (const v of extract(url)) {
            const lc = v.toLowerCase();
            let s = byUtm.get(lc); if (!s) { s = new Set(); byUtm.set(lc, s); }
            s.add(id);
          }
        }
      }
    } catch (err) {
      console.error(`[utm-ag-final-urls] customer ${cid} failed:`, err instanceof Error ? err.message : String(err));
    }
  }));
  const result = new Map<string, string[]>();
  for (const [k, set] of byUtm) {
    const ids = Array.from(set);
    result.set(k, ids);
    const norm = k.replace(/[^a-z0-9]+/g, '');
    if (norm !== k && !result.has(norm)) result.set(norm, ids);
  }
  return result;
}

/**
 * Build a {date → Set<campaign_id>} index of campaigns that had cost > 0 on
 * each day in the window. Used by mergeRedshiftMetrics and buildCampaignPivot
 * to constrain the asset-group 1/N split — a campaign paused on the conversion
 * date can't have driven that day's asset-group click.
 */
export async function buildActiveByDate(
  customerIds: string[],
  from: string,
  to: string
): Promise<Map<string, Set<string>>> {
  if (!customerIds.length) return new Map();
  const query = `
    SELECT campaign.id, segments.date, metrics.cost_micros
    FROM campaign
    WHERE segments.date BETWEEN '${from}' AND '${to}'
      AND campaign.status != 'REMOVED'
      AND metrics.cost_micros > 0
  `.trim();
  const result = new Map<string, Set<string>>();
  await Promise.all(
    customerIds.map(async (cid) => {
      try {
        const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
        const rows = await search<{
          campaign?: { id?: string };
          segments?: { date?: string };
          metrics?: { costMicros?: string };
        }>({ customerId: cid, loginCustomerId, query });
        for (const r of rows) {
          const id = r.campaign?.id; const d = r.segments?.date;
          const cost = Number(r.metrics?.costMicros ?? 0);
          if (!id || !d || cost <= 0) continue;
          let set = result.get(d);
          if (!set) { set = new Set(); result.set(d, set); }
          set.add(id);
        }
      } catch (err) {
        console.error(`[active-by-date] customer ${cid} failed:`, err instanceof Error ? err.message : String(err));
      }
    })
  );
  return result;
}

export async function buildAssetGroupNameToCampaignIdMap(
  customerIds: string[],
  _from: string,
  _to: string
): Promise<Map<string, string[]>> {
  if (!customerIds.length) return new Map();
  // Pull ENABLED asset_group → campaign mappings only. PAUSED / REMOVED asset
  // groups can't be serving the clicks that drove today's NCs, so they
  // shouldn't be candidates for the equal-split denominator — even if their
  // parent campaign is currently active. No date / cost filter though: an
  // asset_group that's currently ENABLED but happened to spend zero today
  // can still own historic clicks that convert today.
  const query = `
    SELECT campaign.id, asset_group.name
    FROM asset_group
    WHERE asset_group.status = 'ENABLED'
  `.trim();
  const perAccount = await Promise.all(
    customerIds.map(async (cid) => {
      try {
        const loginCustomerId = (await getLoginCustomerId(cid)) ?? undefined;
        return await search<{
          campaign?: { id?: string };
          assetGroup?: { name?: string };
        }>({ customerId: cid, loginCustomerId, query });
      } catch (err) {
        console.error(`[ag-name-map] customer ${cid} failed:`, err instanceof Error ? err.message : String(err));
        return [];
      }
    })
  );
  const byName = new Map<string, Set<string>>();
  for (const rows of perAccount) {
    for (const r of rows) {
      const name = r.assetGroup?.name?.toLowerCase();
      const cid = r.campaign?.id;
      if (!name || !cid) continue;
      let set = byName.get(name);
      if (!set) { set = new Set(); byName.set(name, set); }
      set.add(cid);
    }
  }
  const result = new Map<string, string[]>();
  for (const [name, set] of byName) {
    const ids = Array.from(set);
    result.set(name, ids);
    const normalized = name.replace(/[^a-z0-9]+/g, '');
    if (!result.has(normalized)) result.set(normalized, ids);
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
export async function buildSkuToCampaignIdMap(
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
export async function buildAdIdToCampaignIdMap(customerIds: string[]): Promise<Map<string, string>> {
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
    if (r.adGroup?.targetCpaMicros) base.ad_group_target_cpa_inr = Number(r.adGroup.targetCpaMicros) / MICROS;
    if (r.adGroup?.targetRoas != null) base.ad_group_target_roas = Number(r.adGroup.targetRoas);
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
    // RSA / App / Responsive Display ads each store headlines+descriptions
    // under a different sub-resource — collapse whichever is populated.
    const ad = r.adGroupAd?.ad;
    const hl = ad?.responsiveSearchAd?.headlines ?? ad?.appAd?.headlines ?? ad?.responsiveDisplayAd?.headlines ?? [];
    const ds = ad?.responsiveSearchAd?.descriptions ?? ad?.appAd?.descriptions ?? ad?.responsiveDisplayAd?.descriptions ?? [];
    base.headlines = hl.map((h) => h.text ?? '').filter(Boolean);
    base.descriptions = ds.map((d) => d.text ?? '').filter(Boolean);
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

  // PMax search-term insights — privacy-aggregated category labels, not raw queries
  app.get('/pmax-search-terms', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;
    if (!q.campaign_id) return reply.code(400).send({ error: 'campaign_id required' });

    const brand = getBrand(q.brand_id);
    if (!brand) return reply.code(404).send({ error: 'Brand not found' });

    try {
      const query = buildPmaxSearchTermsQuery({
        level: 'search_term', from: q.from, to: q.to, campaignIds: [q.campaign_id],
      });
      const perAccount = await Promise.all(
        brand.accounts.map(async (acc) => {
          try {
            const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
            return await search<{
              campaignSearchTermInsight?: { id?: string; categoryLabel?: string };
              metrics?: Record<string, unknown>;
            }>({ customerId: acc.customer_id, loginCustomerId, query });
          } catch (err) {
            app.log.warn(
              { customer_id: acc.customer_id, err: err instanceof Error ? err.message : String(err) },
              'pmax-search-terms account fetch failed'
            );
            return [];
          }
        })
      );
      const rows = perAccount.flat().map((r) => {
        const raw = parseRawFromGoogle(r.metrics ?? {});
        const label = r.campaignSearchTermInsight?.categoryLabel?.trim() || '(other / aggregated)';
        return {
          customer_id: brand.accounts[0]?.customer_id ?? '',
          search_term: label,
          status: 'NONE',
          metrics: applyFlatRto(deriveMetrics(raw), brand.rto_factor),
        };
      });
      return { rows: rows.sort((a, b) => b.metrics.impressions - a.metrics.impressions) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err: message }, 'pmax search terms fetch failed');
      return reply.code(500).send({ error: message });
    }
  });

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
        let network_split: NetworkSplitEntry[] | undefined;
        let pmax_channel_split: PmaxChannelEntry[] | undefined;
        if (level === 'campaign') {
          [brand_redshift_totals, network_split, pmax_channel_split] = await Promise.all([
            tryFetchBrandTotals(q.brand_id, q.from, q.to, q.compare_from, q.compare_to),
            fetchNetworkSplit(q.brand_id, q.from, q.to),
            fetchBrandPmaxChannelSplit(q.brand_id, q.from, q.to),
          ]);
        }

        // RTO factor is what attachRedshiftMetrics already applied to ncs/ncs_amount
        // (so the per-row Redshift totals are already post-RTO). We surface it so the
        // KPI strip can also apply RTO to the Google-side ROAS / CPA tiles for
        // display-consistency with the per-row post-RTO numbers.
        const brand = getBrand(q.brand_id);
        const rto_factor = brand?.rto_factor ?? 0;
        return { rows: primary, brand_redshift_totals, network_split, pmax_channel_split, rto_factor };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error({ err: message }, `${level} fetch failed`);
        return reply.code(500).send({ error: message });
      }
    });
  }
}
