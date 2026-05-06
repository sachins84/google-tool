import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getBrand } from '../services/brands.js';
import { buildAssetsQuery } from '../services/gaql.js';
import { search } from '../services/google-ads.js';

const querySchema = z.object({
  brand_id: z.coerce.number(),
  campaign_id: z.string().optional(),
  asset_group_id: z.string().optional(),
});

interface RawAssetRow {
  campaign?: { id?: string; name?: string };
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
}

interface AssetRow {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
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

      const query = buildAssetsQuery({
        level: 'asset',
        from: '', // unused
        to: '',
        campaignIds: q.campaign_id ? [q.campaign_id] : undefined,
        assetGroupIds: q.asset_group_id ? [q.asset_group_id] : undefined,
      });

      const perAccount = await Promise.all(
        brand.accounts.map(async (acc) => {
          try {
            const rows = await search<RawAssetRow>({ customerId: acc.customer_id, query });
            return rows.map<AssetRow>((r) => ({
              customer_id: acc.customer_id,
              campaign_id: r.campaign?.id,
              campaign_name: r.campaign?.name,
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

      return { rows: perAccount.flat() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err: message }, 'asset fetch failed');
      return reply.code(500).send({ error: message });
    }
  });
}
