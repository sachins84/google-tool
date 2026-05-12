import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getBrand } from '../services/brands.js';
import { buildAssetsQuery } from '../services/gaql.js';
import { search } from '../services/google-ads.js';
import { getLoginCustomerId } from '../services/mcc-map.js';
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
  asset_group_id: z.string().optional(),
});

interface RawAssetRow {
  campaign?: { id?: string; name?: string; advertisingChannelType?: string };
  assetGroup?: { id?: string; name?: string };
  assetGroupAsset?: {
    fieldType?: string;
    performanceLabel?: string;
    status?: string;
  };
  asset?: {
    id?: string;
    type?: string;
    textAsset?: { text?: string };
    imageAsset?: { fullSize?: { url?: string } };
    youtubeVideoAsset?: { youtubeVideoId?: string };
  };
  metrics?: Record<string, unknown>;
}

interface AssetRow {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  channel_type?: string;
  asset_group_id?: string;
  asset_group_name?: string;
  asset_id?: string;
  asset_type?: string;
  field_type?: string;
  performance_label?: string;
  status?: string;
  text?: string;
  image_url?: string;
  youtube_video_id?: string;
  metrics?: DerivedMetrics;
  comparison?: DerivedMetrics;
}

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;

    try {
      const brand = getBrand(q.brand_id);
      if (!brand) return reply.code(404).send({ error: 'Brand not found' });

      async function fetchWindow(from: string, to: string): Promise<AssetRow[]> {
        const query = buildAssetsQuery({
          level: 'asset', from, to,
          campaignIds: q.campaign_id ? [q.campaign_id] : undefined,
          assetGroupIds: q.asset_group_id ? [q.asset_group_id] : undefined,
        });
        const perAccount = await Promise.all(
          brand!.accounts.map(async (acc) => {
            try {
              const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
              const raws = await search<RawAssetRow>({ customerId: acc.customer_id, loginCustomerId, query });
              const aggregated = new Map<string, { row: AssetRow; raw: RawMetrics }>();
              for (const r of raws) {
                const key = `${r.assetGroup?.id}|${r.asset?.id}|${r.assetGroupAsset?.fieldType}`;
                const raw = parseRawFromGoogle(r.metrics ?? {});
                let entry = aggregated.get(key);
                if (!entry) {
                  entry = {
                    row: {
                      customer_id: acc.customer_id,
                      campaign_id: r.campaign?.id,
                      campaign_name: r.campaign?.name,
                      channel_type: r.campaign?.advertisingChannelType,
                      asset_group_id: r.assetGroup?.id,
                      asset_group_name: r.assetGroup?.name,
                      asset_id: r.asset?.id,
                      asset_type: r.asset?.type,
                      field_type: r.assetGroupAsset?.fieldType,
                      performance_label: r.assetGroupAsset?.performanceLabel,
                      status: r.assetGroupAsset?.status,
                      text: r.asset?.textAsset?.text,
                      image_url: r.asset?.imageAsset?.fullSize?.url,
                      youtube_video_id: r.asset?.youtubeVideoAsset?.youtubeVideoId,
                    },
                    raw: emptyRaw(),
                  };
                  aggregated.set(key, entry);
                }
                entry.raw = addRaw(entry.raw, raw);
              }
              return Array.from(aggregated.values()).map(({ row, raw }) => ({
                ...row,
                metrics: applyFlatRto(deriveMetrics(raw), brand!.rto_factor),
              }));
            } catch (err) {
              app.log.warn(
                { customer_id: acc.customer_id, err: err instanceof Error ? err.message : String(err) },
                'asset fetch failed for account'
              );
              return [];
            }
          })
        );
        return perAccount.flat();
      }

      const primary = await fetchWindow(q.from, q.to);
      if (q.compare_from && q.compare_to) {
        const compare = await fetchWindow(q.compare_from, q.compare_to);
        const cmpByKey = new Map(compare.map((r) => [`${r.asset_group_id}|${r.asset_id}|${r.field_type}`, r]));
        for (const r of primary) {
          const c = cmpByKey.get(`${r.asset_group_id}|${r.asset_id}|${r.field_type}`);
          if (c?.metrics) r.comparison = c.metrics;
        }
      }

      return { rows: primary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err: message }, 'asset fetch failed');
      return reply.code(500).send({ error: message });
    }
  });
}
