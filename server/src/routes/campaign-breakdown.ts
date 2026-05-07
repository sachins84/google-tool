import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getBrand } from '../services/brands.js';
import { getLoginCustomerId } from '../services/mcc-map.js';
import { search } from '../services/google-ads.js';

/**
 * Per-campaign spend breakdown along the dimensions Google's API actually exposes:
 *   - by_device:   MOBILE / DESKTOP / TABLET / CONNECTED_TV (works for ALL channel types incl. PMax)
 *   - by_network:  SEARCH / SEARCH_PARTNERS / CONTENT (Display) / YOUTUBE (does NOT work for PMax — returns MIXED only)
 *   - by_placement top 10 actual placements via detail_placement_view (works for Display, Video, Demand Gen)
 *
 * PMax callers get device + a note that network split is not API-exposed.
 * For non-PMax we surface all three.
 */

const querySchema = z.object({
  brand_id: z.coerce.number(),
  campaign_id: z.string(),
  customer_id: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

interface CampaignMetricsRow {
  campaign?: { id?: string; advertisingChannelType?: string };
  segments?: { device?: string; adNetworkType?: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number; conversionsValue?: number };
}

interface PlacementRow {
  campaign?: { id?: string };
  detailPlacementView?: { placementType?: string; targetUrl?: string; displayName?: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string };
}

interface PmaxPlacementRow {
  campaign?: { id?: string };
  performanceMaxPlacementView?: { placementType?: string; placement?: string; displayName?: string; targetUrl?: string };
  metrics?: { impressions?: string };
}

interface ChannelAssetRow {
  channelAggregateAssetView?: { fieldType?: string; asset?: string; advertisingChannelType?: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number };
}

/**
 * Map asset field_type → Google's nominal serving channel.
 * Mirrors how Google's UI groups PMax channel performance.
 */
function fieldTypeToChannel(fieldType: string): 'Search' | 'Display' | 'YouTube' | 'Shared' | 'Other' {
  switch (fieldType) {
    case 'HEADLINE':
    case 'LONG_HEADLINE':
    case 'DESCRIPTION':
    case 'SITELINK':
    case 'CALLOUT':
    case 'STRUCTURED_SNIPPET':
    case 'CALL':
    case 'PRICE':
    case 'PROMOTION':
    case 'LEAD_FORM':
      return 'Search';
    case 'MARKETING_IMAGE':
    case 'SQUARE_MARKETING_IMAGE':
    case 'PORTRAIT_MARKETING_IMAGE':
    case 'LOGO':
    case 'LANDSCAPE_LOGO':
      return 'Display';
    case 'YOUTUBE_VIDEO':
      return 'YouTube';
    case 'BUSINESS_NAME':
    case 'CALL_TO_ACTION_SELECTION':
      return 'Shared'; // used across networks
    default:
      return 'Other';
  }
}

const MICROS = 1_000_000;

export async function campaignBreakdownRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;

    const brand = getBrand(q.brand_id);
    if (!brand) return reply.code(404).send({ error: 'Brand not found' });

    const customer_id = q.customer_id ?? brand.accounts[0]?.customer_id;
    if (!customer_id) return reply.code(400).send({ error: 'No customer_id' });

    try {
      const loginCustomerId = (await getLoginCustomerId(customer_id)) ?? undefined;

      const [byDeviceRows, byNetworkRows, placementRows, channelRow, pmaxPlacements] = await Promise.all([
        search<CampaignMetricsRow>({
          customerId: customer_id, loginCustomerId,
          query: `SELECT segments.device, metrics.cost_micros, metrics.impressions, metrics.clicks
                  FROM campaign WHERE segments.date BETWEEN '${q.from}' AND '${q.to}'
                    AND campaign.id = ${q.campaign_id} AND metrics.cost_micros > 0`,
        }),
        search<CampaignMetricsRow>({
          customerId: customer_id, loginCustomerId,
          query: `SELECT segments.ad_network_type, metrics.cost_micros, metrics.impressions, metrics.clicks
                  FROM campaign WHERE segments.date BETWEEN '${q.from}' AND '${q.to}'
                    AND campaign.id = ${q.campaign_id} AND metrics.cost_micros > 0`,
        }),
        search<PlacementRow>({
          customerId: customer_id, loginCustomerId,
          query: `SELECT detail_placement_view.placement_type, detail_placement_view.target_url,
                         detail_placement_view.display_name, metrics.cost_micros, metrics.impressions, metrics.clicks
                  FROM detail_placement_view WHERE segments.date BETWEEN '${q.from}' AND '${q.to}'
                    AND campaign.id = ${q.campaign_id} AND metrics.cost_micros > 0
                  ORDER BY metrics.cost_micros DESC LIMIT 25`,
        }).catch(() => [] as PlacementRow[]),
        search<{ campaign?: { advertisingChannelType?: string } }>({
          customerId: customer_id, loginCustomerId,
          query: `SELECT campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${q.campaign_id} LIMIT 1`,
        }),
        // PMax YouTube placements — impressions only (no cost; Google constraint).
        // Top 50 by impressions is plenty for the UI; the long tail isn't actionable.
        search<PmaxPlacementRow>({
          customerId: customer_id, loginCustomerId,
          query: `SELECT campaign.id, performance_max_placement_view.placement,
                         performance_max_placement_view.placement_type,
                         performance_max_placement_view.display_name,
                         performance_max_placement_view.target_url,
                         metrics.impressions
                  FROM performance_max_placement_view
                  WHERE segments.date BETWEEN '${q.from}' AND '${q.to}'
                    AND campaign.id = ${q.campaign_id}
                  ORDER BY metrics.impressions DESC LIMIT 50`,
        }).catch(() => [] as PmaxPlacementRow[]),
      ]);

      const channelType = channelRow[0]?.campaign?.advertisingChannelType ?? 'UNKNOWN';

      // PMax-only: derive Search/Display/YouTube cost split via channel_aggregate_asset_view.
      // segments.ad_network_type returns MIXED for PMax, but Google attributes asset-level
      // cost in this view. Mapping field_type → channel matches how Google's UI computes it.
      let pmax_channel_split: Array<{ channel: string; cost: number; impressions: number; clicks: number; conversions: number }> | undefined;
      if (channelType === 'PERFORMANCE_MAX') {
        try {
          // Step 1: collect asset IDs used in this campaign's asset groups
          const assetRows = await search<{ asset?: { id?: string } }>({
            customerId: customer_id, loginCustomerId,
            query: `SELECT asset.id FROM asset_group_asset
                    WHERE campaign.id = ${q.campaign_id}
                      AND asset_group_asset.status != 'REMOVED'`,
          });
          const assetIds = Array.from(new Set(assetRows.map((r) => r.asset?.id).filter((x): x is string => !!x)));
          if (assetIds.length > 0) {
            // Step 2: query channel_aggregate_asset_view for those assets — chunk in batches of 200
            // to keep IN clauses sane
            const chunks: string[][] = [];
            for (let i = 0; i < assetIds.length; i += 200) chunks.push(assetIds.slice(i, i + 200));
            const allRows: ChannelAssetRow[] = [];
            for (const chunk of chunks) {
              const inList = chunk.map((id) => `'customers/${customer_id}/assets/${id}'`).join(',');
              const rows = await search<ChannelAssetRow>({
                customerId: customer_id, loginCustomerId,
                query: `SELECT channel_aggregate_asset_view.field_type,
                               channel_aggregate_asset_view.asset,
                               metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
                        FROM channel_aggregate_asset_view
                        WHERE segments.date BETWEEN '${q.from}' AND '${q.to}'
                          AND channel_aggregate_asset_view.advertising_channel_type = 'PERFORMANCE_MAX'
                          AND channel_aggregate_asset_view.asset IN (${inList})`,
              });
              allRows.push(...rows);
            }

            const buckets = new Map<string, { cost: number; impressions: number; clicks: number; conversions: number }>();
            for (const r of allRows) {
              const ft = r.channelAggregateAssetView?.fieldType ?? 'UNKNOWN';
              const channel = fieldTypeToChannel(ft);
              const b = buckets.get(channel) ?? { cost: 0, impressions: 0, clicks: 0, conversions: 0 };
              b.cost += Number(r.metrics?.costMicros ?? 0) / MICROS;
              b.impressions += Number(r.metrics?.impressions ?? 0);
              b.clicks += Number(r.metrics?.clicks ?? 0);
              b.conversions += Number(r.metrics?.conversions ?? 0);
              buckets.set(channel, b);
            }
            pmax_channel_split = Array.from(buckets.entries())
              .map(([channel, v]) => ({ channel, ...v }))
              .sort((a, b) => b.cost - a.cost);
          }
        } catch (err) {
          app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'pmax channel breakdown failed');
        }
      }

      const by_device = byDeviceRows.map((r) => ({
        device: r.segments?.device ?? 'UNKNOWN',
        cost: Number(r.metrics?.costMicros ?? 0) / MICROS,
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
      })).sort((a, b) => b.cost - a.cost);

      const by_network_raw = byNetworkRows.map((r) => ({
        network: r.segments?.adNetworkType ?? 'UNKNOWN',
        cost: Number(r.metrics?.costMicros ?? 0) / MICROS,
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
      })).sort((a, b) => b.cost - a.cost);
      // Pretty-label the network names; for PMax the only value is MIXED — keep as-is so the
      // frontend can decide whether to display or replace with a notice.
      const by_network = by_network_raw.map((e) => ({
        ...e,
        network: e.network === 'CONTENT' ? 'Display'
               : e.network === 'SEARCH' ? 'Search'
               : e.network === 'SEARCH_PARTNERS' ? 'Search Partners'
               : e.network === 'YOUTUBE' || e.network === 'YOUTUBE_WATCH' || e.network === 'YOUTUBE_SEARCH' ? 'YouTube'
               : e.network === 'GOOGLE_TV' ? 'Google TV'
               : e.network === 'MIXED' ? 'Mixed (PMax)'
               : e.network.replace(/_/g, ' '),
      }));

      const placements = placementRows.map((r) => ({
        placement_type: r.detailPlacementView?.placementType ?? '?',
        target_url: r.detailPlacementView?.targetUrl,
        display_name: r.detailPlacementView?.displayName,
        cost: Number(r.metrics?.costMicros ?? 0) / MICROS,
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
      }));

      // PMax placement view exposes impressions only (no cost). Aggregate by placement_type
      // (currently always YOUTUBE_VIDEO) + return top 25 individual placements for the table.
      const pmax_placements_by_type = pmaxPlacements.reduce<Record<string, number>>((acc, r) => {
        const t = r.performanceMaxPlacementView?.placementType ?? 'UNKNOWN';
        acc[t] = (acc[t] ?? 0) + Number(r.metrics?.impressions ?? 0);
        return acc;
      }, {});
      const pmax_top_placements = pmaxPlacements
        .map((r) => ({
          placement_type: r.performanceMaxPlacementView?.placementType ?? '?',
          target_url: r.performanceMaxPlacementView?.targetUrl,
          display_name: r.performanceMaxPlacementView?.displayName,
          placement: r.performanceMaxPlacementView?.placement,
          impressions: Number(r.metrics?.impressions ?? 0),
        }))
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 25);
      const pmax_total_impr = Object.values(pmax_placements_by_type).reduce((a, b) => a + b, 0);

      // Honest meta about which sections are reliable for this channel type
      const network_breakdown_available = channelType !== 'PERFORMANCE_MAX';
      const placement_breakdown_available = channelType !== 'PERFORMANCE_MAX';

      return {
        channel_type: channelType,
        by_device,
        by_network,
        placements,
        pmax_placements_by_type,
        pmax_top_placements,
        pmax_total_impr,
        pmax_channel_split,
        network_breakdown_available,
        placement_breakdown_available,
        notes: channelType === 'PERFORMANCE_MAX'
          ? pmax_channel_split && pmax_channel_split.length > 0
            ? [
                'PMax channel split is derived from asset-level cost attribution (channel_aggregate_asset_view → field_type → channel) — same data Google\'s UI uses.',
                'IMPORTANT: trust the percentages, not the absolute numbers. Asset costs sum across all PMax campaigns those assets serve in (Google\'s API doesn\'t scope asset cost by campaign), so totals here can exceed this campaign\'s actual spend. Proportions remain accurate.',
                '"Shared" = assets used across networks (business name, CTA). "Other" = uncategorised field types.',
              ]
            : [
                'No asset-level cost data found for this PMax campaign in this window — possibly just launched, low spend, or asset-group changes mid-window.',
              ]
          : [],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err: message }, 'campaign-breakdown failed');
      return reply.code(500).send({ error: message });
    }
  });
}
