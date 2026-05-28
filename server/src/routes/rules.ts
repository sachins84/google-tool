import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db/init.js';
import { getBrand } from '../services/brands.js';

/**
 * Structured guardrail CRUD. Rules are predicate objects built from the UI's
 * dropdown/threshold form — no free-text parsing. Floors/caps with is_hard=1 are
 * enforced by the optimizer and never relaxed by the feedback loop.
 */

// Metrics a guardrail can condition on. roas_post_rto + budget_step_pct drive the
// optimizer directly; ctr/cvr/cpc/cpm refine the diagnosis & lever selection.
const METRICS = ['roas_post_rto', 'budget_step_pct', 'ctr', 'cvr', 'cpc', 'cpm', 'search_is', 'lost_is_budget', 'lost_is_rank'] as const;
const CHANNELS = ['ALL', 'SEARCH', 'PERFORMANCE_MAX', 'SHOPPING', 'DISPLAY', 'VIDEO'] as const;

const predicateSchema = z.object({
  metric: z.enum(METRICS),
  channel: z.enum(CHANNELS).optional(),   // campaign-type scope
  campaign_id: z.string().regex(/^\d+$/).optional(), // specific-campaign scope
  value: z.number(),
  comparator: z.enum(['gte', 'lte']).optional(),
});

const ruleBodySchema = z.object({
  brand_id: z.coerce.number(),
  kind: z.enum(['floor', 'cap', 'weight', 'exclusion', 'preference']),
  scope_level: z.enum(['campaign', 'asset_group', 'keyword', 'ad', 'portfolio']),
  predicate: predicateSchema,
  is_hard: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

interface RuleRow {
  id: number; brand_id: number | null; origin: string; kind: string; scope_level: string | null;
  json: string; weight: number; enabled: number; is_hard: number;
}

function shapeRule(r: RuleRow): Record<string, unknown> {
  let predicate: unknown = null;
  try { predicate = JSON.parse(r.json); } catch { /* keep null */ }
  return {
    id: r.id, brand_id: r.brand_id, origin: r.origin, kind: r.kind, scope_level: r.scope_level,
    predicate, weight: r.weight, enabled: !!r.enabled, is_hard: !!r.is_hard,
  };
}

export async function ruleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req, reply) => {
    const q = z.object({ brand_id: z.coerce.number() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const rows = getDb()
      .prepare('SELECT * FROM rules WHERE brand_id = ? OR brand_id IS NULL ORDER BY origin DESC, kind, scope_level')
      .all(q.data.brand_id) as RuleRow[];
    return { rules: rows.map(shapeRule) };
  });

  app.post('/', async (req, reply) => {
    const parsed = ruleBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const b = parsed.data;
    if (!getBrand(b.brand_id)) return reply.code(404).send({ error: 'Brand not found' });
    const res = getDb()
      .prepare(
        `INSERT INTO rules (brand_id, origin, kind, scope_level, json, weight, enabled, is_hard)
         VALUES (?, 'manual', ?, ?, ?, 1.0, ?, ?)`
      )
      .run(b.brand_id, b.kind, b.scope_level, JSON.stringify(b.predicate), b.enabled ? 1 : 0, b.is_hard ? 1 : 0);
    return { ok: true, id: res.lastInsertRowid };
  });

  app.patch('/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({
      predicate: predicateSchema.optional(),
      enabled: z.boolean().optional(),
      is_hard: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    const existing = db.prepare('SELECT * FROM rules WHERE id=?').get(id) as RuleRow | undefined;
    if (!existing) return reply.code(404).send({ error: 'Rule not found' });
    const p = parsed.data;
    db.prepare('UPDATE rules SET json=?, enabled=?, is_hard=? WHERE id=?').run(
      p.predicate ? JSON.stringify(p.predicate) : existing.json,
      p.enabled != null ? (p.enabled ? 1 : 0) : existing.enabled,
      p.is_hard != null ? (p.is_hard ? 1 : 0) : existing.is_hard,
      id
    );
    return { ok: true };
  });

  app.delete('/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT origin FROM rules WHERE id=?').get(id) as { origin: string } | undefined;
    if (!existing) return reply.code(404).send({ error: 'Rule not found' });
    if (existing.origin === 'default') return reply.code(400).send({ error: 'Default rules cannot be deleted — disable or edit instead' });
    getDb().prepare('DELETE FROM rules WHERE id=?').run(id);
    return { ok: true };
  });
}
