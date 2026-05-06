import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { askClaude, buildAnalysisContext, computeDailyInsights } from '../services/insights.js';

const dailySchema = z.object({
  brand_id: z.coerce.number(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  compare_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compare_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const askQuerySchema = z.object({
  brand_id: z.coerce.number(),
  from: z.string(),
  to: z.string(),
});

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Compute daily insights from the campaigns endpoint's rows (passed in via query)
  app.post('/daily', async (req, reply) => {
    const parsed = dailySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    // Reuse the campaigns endpoint internally — simpler than duplicating fetch logic.
    // The body passes rows from the frontend instead of refetching.
    const body = (req.body as { rows?: unknown[] }) ?? {};
    if (!Array.isArray(body.rows)) return reply.code(400).send({ error: 'rows[] required in body' });

    const insights = computeDailyInsights(body.rows as Parameters<typeof computeDailyInsights>[0]);
    return { insights };
  });

  app.post('/ask', async (req, reply) => {
    const qParsed = askQuerySchema.safeParse(req.query);
    if (!qParsed.success) return reply.code(400).send({ error: qParsed.error.flatten() });
    const body = (req.body as { question?: string; rows?: unknown[]; brand_totals?: { ncs: number; amount: number } }) ?? {};
    if (!body.question || typeof body.question !== 'string' || body.question.length < 3) {
      return reply.code(400).send({ error: 'question (string, min 3 chars) required in body' });
    }
    if (!Array.isArray(body.rows)) return reply.code(400).send({ error: 'rows[] required in body' });

    try {
      const context = buildAnalysisContext(body.rows as Parameters<typeof buildAnalysisContext>[0], body.brand_totals);
      const systemPrompt = [
        'You are a Google Ads analytics assistant for an e-commerce brand. The user is a marketing manager.',
        'Answer concisely (under 200 words unless analysis truly requires more).',
        'Use the data provided in the user message. If the question asks for something not in the data, say so plainly.',
        'Be specific — cite campaign names and exact numbers from the table.',
        'When recommending actions, explain the trade-off in one short sentence.',
        'Currency is INR. ROAS_G = Google reported ROAS (pre-RTO). Calc ROAS = post-RTO from internal funnel.',
      ].join(' ');

      const userMessage = `${context}\n\n---\n\nQuestion: ${body.question}`;
      const answer = await askClaude(systemPrompt, [{ role: 'user', content: userMessage }]);
      return { answer };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err: message }, 'insights/ask failed');
      return reply.code(500).send({ error: message });
    }
  });
}
