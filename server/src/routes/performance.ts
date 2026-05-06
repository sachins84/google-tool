import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getBrand } from '../services/brands.js';
import {
  buildCampaignsQuery,
  buildAdGroupsQuery,
  buildAdsQuery,
  buildKeywordsQuery,
  buildSearchTermsQuery,
  type Level,
} from '../services/gaql.js';
import { search } from '../services/google-ads.js';
import {
  addRaw,
  applyFlatRto,
  deriveMetrics,
  emptyRaw,
  parseRawFromGoogle,
  type DerivedMetrics,
  type RawMetrics,
} from '../services/metrics.js';

const querySchema = z.object({
  brand_id: z.coerce.number(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  compare_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compare_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  campaign_id: z.string().optional(),
  ad_group_id: z.string().optional(),
});

interface Row {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  ad_group_id?: string;
  ad_group_name?: string;
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
  metrics: DerivedMetrics;
  comparison?: DerivedMetrics;
}

const MICROS = 1_000_000;

function pickRowKey(level: Level, raw: GoogleAdsRow): string {
  if (level === 'campaign') return `${raw.campaign?.id}`;
  if (level === 'ad_group') return `${raw.adGroup?.id}`;
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
  metrics?: Record<string, unknown>;
}

function buildQueryForLevel(
  level: Level,
  from: string,
  to: string,
  campaignId?: string,
  adGroupId?: string
): string {
  const opts = {
    level,
    from,
    to,
    campaignIds: campaignId ? [campaignId] : undefined,
    adGroupIds: adGroupId ? [adGroupId] : undefined,
  };
  if (level === 'campaign') return buildCampaignsQuery(opts);
  if (level === 'ad_group') return buildAdGroupsQuery(opts);
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
  adGroupId?: string
): Promise<Row[]> {
  const brand = getBrand(brandId);
  if (!brand) throw new Error(`Brand ${brandId} not found`);
  if (!brand.accounts.length) return [];

  const query = buildQueryForLevel(level, from, to, campaignId, adGroupId);

  // Fetch each linked customer in parallel.
  const perAccount = await Promise.all(
    brand.accounts.map(async (acc) => {
      const rows = await search<GoogleAdsRow>({ customerId: acc.customer_id, query });
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

  return Array.from(aggregated.values()).map(({ row, raw }) => ({
    ...row,
    metrics: applyFlatRto(deriveMetrics(raw), brand.rto_factor),
  }));
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
  if (level === 'keyword') return `${row.customer_id}|${row.ad_group_id}|${row.criterion_id}`;
  if (level === 'search_term') return `${row.customer_id}|${row.ad_group_id}|${row.search_term}`;
  return `${row.customer_id}|${row.ad_id}`;
}

export async function performanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  for (const level of ['campaign', 'ad_group', 'ad', 'keyword', 'search_term'] as const) {
    const path = level === 'campaign' ? '/campaigns'
      : level === 'ad_group' ? '/ad-groups'
      : level === 'ad' ? '/ads'
      : level === 'keyword' ? '/keywords'
      : '/search-terms';

    app.get(path, async (req, reply) => {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const q = parsed.data;

      try {
        const primary = await fetchRowsForBrand(
          level, q.brand_id, q.from, q.to, q.campaign_id, q.ad_group_id
        );

        if (q.compare_from && q.compare_to) {
          const compare = await fetchRowsForBrand(
            level, q.brand_id, q.compare_from, q.compare_to, q.campaign_id, q.ad_group_id
          );
          const compareByKey = new Map(compare.map((r) => [rowKey(level, r), r]));
          for (const r of primary) {
            const c = compareByKey.get(rowKey(level, r));
            if (c) r.comparison = c.metrics;
          }
        }

        return { rows: primary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error({ err: message }, `${level} fetch failed`);
        return reply.code(500).send({ error: message });
      }
    });
  }
}
