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

      const [byDeviceRows, byNetworkRows, placementRows, channelRow] = await Promise.all([
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
      ]);

      const channelType = channelRow[0]?.campaign?.advertisingChannelType ?? 'UNKNOWN';

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

      // Honest meta about which sections are reliable for this channel type
      const network_breakdown_available = channelType !== 'PERFORMANCE_MAX';
      const placement_breakdown_available = channelType !== 'PERFORMANCE_MAX';

      return {
        channel_type: channelType,
        by_device,
        by_network,
        placements,
        network_breakdown_available,
        placement_breakdown_available,
        notes: channelType === 'PERFORMANCE_MAX'
          ? [
              'Google Ads API does not expose YouTube/Search/Display split for Performance Max campaigns.',
              'The Google Ads UI computes this breakdown from internal data not available to third-party tools.',
              'Available alternatives: device split (below) and Asset Groups tab.',
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
