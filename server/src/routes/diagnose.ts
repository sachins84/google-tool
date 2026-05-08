import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { diagnose, type DiagnoseMetric } from '../services/diagnose.js';

const querySchema = z.object({
  brand_id: z.coerce.number(),
  customer_id: z.string(),
  campaign_id: z.string(),
  metric: z.enum(['cpm', 'cpc', 'ctr', 'conv_rate', 'calc_roas', 'calc_cpa', 'cpa']),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  compare_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compare_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function diagnoseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;
    try {
      const result = await diagnose(
        q.brand_id, q.customer_id, q.campaign_id,
        q.metric as DiagnoseMetric,
        q.from, q.to,
        q.compare_from, q.compare_to,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err: message }, 'diagnose failed');
      return reply.code(500).send({ error: message });
    }
  });
}
