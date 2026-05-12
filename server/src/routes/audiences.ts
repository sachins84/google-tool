import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getBrand } from '../services/brands.js';
import { getLoginCustomerId } from '../services/mcc-map.js';
import { search } from '../services/google-ads.js';
import { buildAudiencesQuery } from '../services/gaql.js';
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

interface Row {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  channel_type?: string;
  criterion_id?: string;
  audience_type?: string;
  audience_label?: string;
  metrics: DerivedMetrics;
  comparison?: DerivedMetrics;
}

interface RawGoogleRow {
  campaign?: { id?: string; name?: string; advertisingChannelType?: string };
  campaignCriterion?: {
    criterionId?: string;
    type?: string;
    displayName?: string;
    userInterest?: { userInterestCategory?: string };
  };
  metrics?: Record<string, unknown>;
}

function rowKey(r: Row): string {
  return `${r.customer_id}|${r.campaign_id}|${r.criterion_id}`;
}

function audienceLabel(r: RawGoogleRow): string {
  const cc = r.campaignCriterion;
  return (
    cc?.displayName
    ?? cc?.userInterest?.userInterestCategory
    ?? cc?.criterionId
    ?? '—'
  );
}

export async function audienceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;

    const brand = getBrand(q.brand_id);
    if (!brand) return reply.code(404).send({ error: 'Brand not found' });

    async function fetchWindow(from: string, to: string): Promise<Row[]> {
      const query = buildAudiencesQuery({
        level: 'audience', from, to,
        campaignIds: q.campaign_id ? [q.campaign_id] : undefined,
      });
      const perAccount = await Promise.all(
        brand!.accounts.map(async (acc) => {
          try {
            const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
            const raws = await search<RawGoogleRow>({ customerId: acc.customer_id, loginCustomerId, query });
            const aggregated = new Map<string, { row: Row; raw: RawMetrics }>();
            for (const r of raws) {
              const key = `${r.campaign?.id}|${r.campaignCriterion?.criterionId}`;
              const raw = parseRawFromGoogle(r.metrics ?? {});
              let entry = aggregated.get(key);
              if (!entry) {
                entry = {
                  row: {
                    customer_id: acc.customer_id,
                    campaign_id: r.campaign?.id,
                    campaign_name: r.campaign?.name,
                    channel_type: r.campaign?.advertisingChannelType,
                    criterion_id: r.campaignCriterion?.criterionId,
                    audience_type: r.campaignCriterion?.type,
                    audience_label: audienceLabel(r),
                    metrics: applyFlatRto(deriveMetrics(emptyRaw()), brand!.rto_factor),
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
            app.log.warn({ customer_id: acc.customer_id, err: err instanceof Error ? err.message : String(err) }, 'audience fetch failed');
            return [];
          }
        })
      );
      return perAccount.flat();
    }

    try {
      const primary = await fetchWindow(q.from, q.to);
      if (q.compare_from && q.compare_to) {
        const cmp = await fetchWindow(q.compare_from, q.compare_to);
        const byKey = new Map(cmp.map((r) => [rowKey(r), r]));
        for (const r of primary) {
          const c = byKey.get(rowKey(r));
          if (c) r.comparison = c.metrics;
        }
      }
      return { rows: primary.sort((a, b) => b.metrics.cost - a.metrics.cost) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err: message }, 'audiences route failed');
      return reply.code(500).send({ error: message });
    }
  });
}
