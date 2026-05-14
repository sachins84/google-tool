/**
 * Cross-campaign video asset performance.
 *
 * Same YouTube video (identified by youtube_video_id) is typically reused
 * across many PMax asset groups and Demand Gen ad groups. This route pulls
 * both data sources, aggregates by youtube_video_id, and returns one row per
 * video with totals + a list of where it's used.
 *
 * Caveats:
 *  - PMax (asset_group_asset) returns cost/impressions/clicks but NOT
 *    conversions at the asset level — Google's AI attributes conversions to
 *    the asset_group, not individual assets.
 *  - Demand Gen / non-PMax (ad_group_ad_asset_view) returns conversions too.
 *  - performance_label (BEST / GOOD / LOW) is the most reliable per-asset
 *    quality signal; it's set by Google relative to other assets in the same
 *    group.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getBrand } from '../services/brands.js';
import { getLoginCustomerId } from '../services/mcc-map.js';
import { search } from '../services/google-ads.js';
import { buildPmaxVideoAssetsQuery, buildDgVideoAssetsQuery } from '../services/gaql.js';
import {
  addRaw, applyFlatRto, deriveMetrics, emptyRaw, parseRawFromGoogle,
  type DerivedMetrics, type RawMetrics,
} from '../services/metrics.js';

const querySchema = z.object({
  brand_id: z.coerce.number(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  compare_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compare_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  campaign_id: z.string().optional(),
});

interface Usage {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  channel_type?: string;
  group_id?: string;         // asset_group_id (PMax) or ad_group_id (DG)
  group_name?: string;
  group_kind: 'asset_group' | 'ad_group';
  performance_label?: string;
  cost: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

interface TrendPoint {
  /** Bucket label — date for daily, ISO week-start date for weekly, "YYYY-MM" for monthly. */
  label: string;
  cost: number;
  impressions: number;
  clicks: number;
}

interface VideoRow {
  youtube_video_id: string;
  title?: string;
  asset_ids: string[];       // distinct asset.id values (same video can be uploaded as multiple assets)
  usage_count: number;
  has_conversions_data: boolean;  // true if at least one usage came from a DG source
  best_label?: string;            // collapsed label across usages (BEST > GOOD > LOW > UNKNOWN)
  usages: Usage[];
  trend: TrendPoint[];            // bucketed spend trend (daily / weekly / monthly)
  trend_bucket: 'daily' | 'weekly' | 'monthly';
  metrics: DerivedMetrics;
  comparison?: DerivedMetrics;
}

interface PmaxRawRow {
  segments?: { date?: string };
  campaign?: { id?: string; name?: string; advertisingChannelType?: string };
  assetGroup?: { id?: string; name?: string };
  assetGroupAsset?: { performanceLabel?: string; status?: string };
  asset?: { id?: string; youtubeVideoAsset?: { youtubeVideoId?: string; youtubeVideoTitle?: string } };
  metrics?: Record<string, unknown>;
}

interface DgRawRow {
  segments?: { date?: string };
  campaign?: { id?: string; name?: string; advertisingChannelType?: string };
  adGroup?: { id?: string; name?: string };
  adGroupAdAssetView?: { performanceLabel?: string; fieldType?: string };
  asset?: { id?: string; youtubeVideoAsset?: { youtubeVideoId?: string; youtubeVideoTitle?: string } };
  metrics?: Record<string, unknown>;
}

type BucketMode = 'daily' | 'weekly' | 'monthly';

function pickBucket(from: string, to: string): BucketMode {
  const days = Math.round(
    (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000,
  ) + 1;
  if (days <= 14) return 'daily';
  if (days <= 90) return 'weekly';
  return 'monthly';
}

function bucketLabel(date: string, anchor: string, mode: BucketMode): string {
  if (mode === 'daily') return date;
  if (mode === 'monthly') return date.slice(0, 7);
  const dt = Date.parse(date + 'T00:00:00Z');
  const a = Date.parse(anchor + 'T00:00:00Z');
  const days = Math.floor((dt - a) / 86400000);
  const weekStart = new Date(a + Math.floor(days / 7) * 7 * 86400000);
  return weekStart.toISOString().slice(0, 10);
}

/** Produce a sorted, dense trend array (zero-filled for missing buckets). */
function buildTrend(
  daily: Map<string, { cost: number; impressions: number; clicks: number }>,
  from: string,
  to: string,
  mode: BucketMode,
): TrendPoint[] {
  // Bucket the daily Map
  const buckets = new Map<string, { cost: number; impressions: number; clicks: number }>();
  for (const [date, v] of daily) {
    const lbl = bucketLabel(date, from, mode);
    const entry = buckets.get(lbl) ?? { cost: 0, impressions: 0, clicks: 0 };
    entry.cost += v.cost;
    entry.impressions += v.impressions;
    entry.clicks += v.clicks;
    buckets.set(lbl, entry);
  }
  // Walk the date range and emit dense buckets so all rows share the same x-axis
  const labels: string[] = [];
  const aMs = Date.parse(from + 'T00:00:00Z');
  const bMs = Date.parse(to + 'T00:00:00Z');
  if (mode === 'daily') {
    for (let ms = aMs; ms <= bMs; ms += 86400000) {
      labels.push(new Date(ms).toISOString().slice(0, 10));
    }
  } else if (mode === 'weekly') {
    for (let ms = aMs; ms <= bMs; ms += 7 * 86400000) {
      labels.push(new Date(ms).toISOString().slice(0, 10));
    }
  } else {
    // monthly: iterate months between from and to
    const start = new Date(aMs);
    const end = new Date(bMs);
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cursor <= end) {
      labels.push(cursor.toISOString().slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return labels.map((label) => {
    const v = buckets.get(label) ?? { cost: 0, impressions: 0, clicks: 0 };
    return { label, cost: v.cost, impressions: v.impressions, clicks: v.clicks };
  });
}

const LABEL_RANK: Record<string, number> = { BEST: 4, GOOD: 3, LOW: 2, PENDING: 1, UNKNOWN: 0 };
function bestLabel(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return (LABEL_RANK[a] ?? 0) >= (LABEL_RANK[b] ?? 0) ? a : b;
}

export async function videoAssetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;

    const brand = getBrand(q.brand_id);
    if (!brand) return reply.code(404).send({ error: 'Brand not found' });

    async function fetchWindow(from: string, to: string, includeTrend: boolean): Promise<VideoRow[]> {
      const bucket = pickBucket(from, to);
      const pmaxQuery = buildPmaxVideoAssetsQuery({
        level: 'video_asset', from, to,
        campaignIds: q.campaign_id ? [q.campaign_id] : undefined,
      });
      const dgQuery = buildDgVideoAssetsQuery({
        level: 'video_asset', from, to,
        campaignIds: q.campaign_id ? [q.campaign_id] : undefined,
      });

      const perAccount = await Promise.all(
        brand!.accounts.map(async (acc) => {
          const aggregated = new Map<string, { row: VideoRow; raw: RawMetrics; usageMap: Map<string, Usage>; daily: Map<string, { cost: number; impressions: number; clicks: number }> }>();
          try {
            const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;

            // PMax video usages
            const pmaxRows = await search<PmaxRawRow>({ customerId: acc.customer_id, loginCustomerId, query: pmaxQuery }).catch((err) => {
              app.log.warn({ customer_id: acc.customer_id, err: err instanceof Error ? err.message : String(err) }, 'pmax video fetch failed');
              return [] as PmaxRawRow[];
            });
            for (const r of pmaxRows) {
              const ytId = r.asset?.youtubeVideoAsset?.youtubeVideoId;
              if (!ytId) continue;
              const raw = parseRawFromGoogle(r.metrics ?? {});
              const usageKey = `pmax|${r.campaign?.id}|${r.assetGroup?.id}|${r.asset?.id}`;
              addUsage(aggregated, ytId, r.asset?.youtubeVideoAsset?.youtubeVideoTitle, r.asset?.id, raw, r.segments?.date, {
                customer_id: acc.customer_id,
                campaign_id: r.campaign?.id,
                campaign_name: r.campaign?.name,
                channel_type: r.campaign?.advertisingChannelType,
                group_id: r.assetGroup?.id,
                group_name: r.assetGroup?.name,
                group_kind: 'asset_group',
                performance_label: r.assetGroupAsset?.performanceLabel,
                cost: raw.cost_micros / 1_000_000,
                impressions: raw.impressions,
                clicks: raw.clicks,
                conversions: 0,
              }, usageKey, false);
            }

            // Demand Gen / non-PMax video usages
            const dgRows = await search<DgRawRow>({ customerId: acc.customer_id, loginCustomerId, query: dgQuery }).catch((err) => {
              app.log.warn({ customer_id: acc.customer_id, err: err instanceof Error ? err.message : String(err) }, 'dg video fetch failed');
              return [] as DgRawRow[];
            });
            for (const r of dgRows) {
              const ytId = r.asset?.youtubeVideoAsset?.youtubeVideoId;
              if (!ytId) continue;
              const raw = parseRawFromGoogle(r.metrics ?? {});
              const usageKey = `dg|${r.campaign?.id}|${r.adGroup?.id}|${r.asset?.id}`;
              addUsage(aggregated, ytId, r.asset?.youtubeVideoAsset?.youtubeVideoTitle, r.asset?.id, raw, r.segments?.date, {
                customer_id: acc.customer_id,
                campaign_id: r.campaign?.id,
                campaign_name: r.campaign?.name,
                channel_type: r.campaign?.advertisingChannelType,
                group_id: r.adGroup?.id,
                group_name: r.adGroup?.name,
                group_kind: 'ad_group',
                performance_label: r.adGroupAdAssetView?.performanceLabel,
                cost: raw.cost_micros / 1_000_000,
                impressions: raw.impressions,
                clicks: raw.clicks,
                conversions: raw.conversions,
              }, usageKey, true);
            }
          } catch (err) {
            app.log.warn({ customer_id: acc.customer_id, err: err instanceof Error ? err.message : String(err) }, 'video assets account failed');
          }

          return Array.from(aggregated.values()).map(({ row, raw, usageMap, daily }) => ({
            row: {
              ...row,
              usages: Array.from(usageMap.values()).sort((a, b) => b.cost - a.cost),
              usage_count: usageMap.size,
              asset_ids: Array.from(new Set(row.asset_ids)),
              metrics: applyFlatRto(deriveMetrics(raw), brand!.rto_factor),
            } as VideoRow,
            daily,
          }));
        })
      );

      // Same video_id can appear under multiple customers — merge across accounts.
      const merged = new Map<string, { row: VideoRow; raw: RawMetrics; daily: Map<string, { cost: number; impressions: number; clicks: number }> }>();
      for (const acctRows of perAccount) {
        for (const { row: v, daily: vDaily } of acctRows) {
          const existing = merged.get(v.youtube_video_id);
          if (!existing) {
            const rawSum = emptyRaw();
            rawSum.cost_micros = Math.round(v.metrics.cost * 1_000_000);
            rawSum.impressions = v.metrics.impressions;
            rawSum.clicks = v.metrics.clicks;
            rawSum.conversions = v.metrics.conversions;
            rawSum.conversions_value = v.metrics.conversions_value;
            merged.set(v.youtube_video_id, { row: v, raw: rawSum, daily: new Map(vDaily) });
          } else {
            existing.row.usages.push(...v.usages);
            existing.row.usage_count += v.usage_count;
            existing.row.asset_ids = Array.from(new Set([...existing.row.asset_ids, ...v.asset_ids]));
            existing.row.has_conversions_data = existing.row.has_conversions_data || v.has_conversions_data;
            existing.row.best_label = bestLabel(existing.row.best_label, v.best_label);
            existing.raw.cost_micros += Math.round(v.metrics.cost * 1_000_000);
            existing.raw.impressions += v.metrics.impressions;
            existing.raw.clicks += v.metrics.clicks;
            existing.raw.conversions += v.metrics.conversions;
            existing.raw.conversions_value += v.metrics.conversions_value;
            for (const [date, dv] of vDaily) {
              const cur = existing.daily.get(date) ?? { cost: 0, impressions: 0, clicks: 0 };
              cur.cost += dv.cost;
              cur.impressions += dv.impressions;
              cur.clicks += dv.clicks;
              existing.daily.set(date, cur);
            }
          }
        }
      }
      return Array.from(merged.values()).map(({ row, raw, daily }) => ({
        ...row,
        metrics: applyFlatRto(deriveMetrics(raw), brand!.rto_factor),
        trend_bucket: bucket,
        trend: includeTrend ? buildTrend(daily, from, to, bucket) : [],
      }));
    }

    try {
      const primary = await fetchWindow(q.from, q.to, true);
      if (q.compare_from && q.compare_to) {
        const cmp = await fetchWindow(q.compare_from, q.compare_to, false);
        const byId = new Map(cmp.map((r) => [r.youtube_video_id, r]));
        for (const r of primary) {
          const c = byId.get(r.youtube_video_id);
          if (c) r.comparison = c.metrics;
        }
      }
      return { rows: primary.sort((a, b) => b.metrics.cost - a.metrics.cost) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err: message }, 'video-assets route failed');
      return reply.code(500).send({ error: message });
    }
  });
}

function addUsage(
  aggregated: Map<string, { row: VideoRow; raw: RawMetrics; usageMap: Map<string, Usage>; daily: Map<string, { cost: number; impressions: number; clicks: number }> }>,
  ytId: string,
  title: string | undefined,
  assetId: string | undefined,
  raw: RawMetrics,
  date: string | undefined,
  usage: Usage,
  usageKey: string,
  hasConversions: boolean,
): void {
  let entry = aggregated.get(ytId);
  if (!entry) {
    entry = {
      row: {
        youtube_video_id: ytId,
        title,
        asset_ids: assetId ? [assetId] : [],
        usage_count: 0,
        has_conversions_data: false,
        best_label: undefined,
        usages: [],
        trend: [],
        trend_bucket: 'daily',
        metrics: applyFlatRto(deriveMetrics(emptyRaw()), 0),
      },
      raw: emptyRaw(),
      usageMap: new Map(),
      daily: new Map(),
    };
    aggregated.set(ytId, entry);
  }
  if (title && !entry.row.title) entry.row.title = title;
  if (assetId && !entry.row.asset_ids.includes(assetId)) entry.row.asset_ids.push(assetId);
  entry.row.has_conversions_data = entry.row.has_conversions_data || hasConversions;
  entry.row.best_label = bestLabel(entry.row.best_label, usage.performance_label);
  entry.raw = addRaw(entry.raw, raw);

  // Per-date totals for the trend line.
  if (date) {
    const d = entry.daily.get(date) ?? { cost: 0, impressions: 0, clicks: 0 };
    d.cost += usage.cost;
    d.impressions += usage.impressions;
    d.clicks += usage.clicks;
    entry.daily.set(date, d);
  }

  // Merge into an existing usage (same campaign + group + asset) if present — handles
  // the date-segmented case where one usage spans multiple rows.
  const existingUsage = entry.usageMap.get(usageKey);
  if (existingUsage) {
    existingUsage.cost += usage.cost;
    existingUsage.impressions += usage.impressions;
    existingUsage.clicks += usage.clicks;
    existingUsage.conversions += usage.conversions;
    existingUsage.performance_label = bestLabel(existingUsage.performance_label, usage.performance_label);
  } else {
    entry.usageMap.set(usageKey, { ...usage });
  }
}
