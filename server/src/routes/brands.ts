import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getDb } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { getBrandPreset } from '../config/brand-presets.js';

const brandUpsertSchema = z.object({
  name: z.string().min(1),
  rto_factor: z.number().min(0).max(1).default(0),
  rto_mode: z.enum(['flat', 'csv', 'redshift']).default('flat'),
  account_ids: z.array(z.string()).default([]),
});

export async function brandRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async () => {
    const db = getDb();
    const brands = db.prepare('SELECT id, name, rto_factor, rto_mode FROM brands ORDER BY name').all() as Array<{
      id: number;
      name: string;
      rto_factor: number;
      rto_mode: string;
    }>;
    const accounts = db.prepare('SELECT brand_id, customer_id, customer_name FROM brand_accounts').all() as Array<{
      brand_id: number;
      customer_id: string;
      customer_name: string | null;
    }>;
    const byBrand = new Map<number, typeof accounts>();
    for (const a of accounts) {
      if (!byBrand.has(a.brand_id)) byBrand.set(a.brand_id, []);
      byBrand.get(a.brand_id)!.push(a);
    }
    return {
      brands: brands.map((b) => ({ ...b, accounts: byBrand.get(b.id) ?? [] })),
    };
  });

  app.post('/', async (req, reply) => {
    const parsed = brandUpsertSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const db = getDb();
    const tx = db.transaction((data: z.infer<typeof brandUpsertSchema>) => {
      // If the name matches a preset (Little Joys / Man Matters / BeBodywise),
      // auto-flip rto_mode to redshift so calc ROAS works on first load.
      const preset = getBrandPreset(data.name);
      const effectiveMode = preset && data.rto_mode === 'flat' ? 'redshift' : data.rto_mode;
      const result = db.prepare(
        'INSERT INTO brands (name, rto_factor, rto_mode) VALUES (?, ?, ?)'
      ).run(data.name, data.rto_factor, effectiveMode);
      const brandId = result.lastInsertRowid as number;
      for (const cid of data.account_ids) {
        db.prepare(
          'INSERT INTO brand_accounts (brand_id, customer_id) VALUES (?, ?)'
        ).run(brandId, cid);
      }
      applyPresetIfMatch(db, brandId, data.name);
      return brandId;
    });

    try {
      const id = tx(parsed.data);
      return { id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.put('/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Bad id' });

    const parsed = brandUpsertSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const db = getDb();
    const tx = db.transaction((data: z.infer<typeof brandUpsertSchema>) => {
      const preset = getBrandPreset(data.name);
      const effectiveMode = preset && data.rto_mode === 'flat' ? 'redshift' : data.rto_mode;
      db.prepare(
        'UPDATE brands SET name = ?, rto_factor = ?, rto_mode = ? WHERE id = ?'
      ).run(data.name, data.rto_factor, effectiveMode, id);
      db.prepare('DELETE FROM brand_accounts WHERE brand_id = ?').run(id);
      for (const cid of data.account_ids) {
        db.prepare('INSERT INTO brand_accounts (brand_id, customer_id) VALUES (?, ?)').run(id, cid);
      }
      applyPresetIfMatch(db, id, data.name);
    });

    try {
      tx(parsed.data);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete('/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Bad id' });
    getDb().prepare('DELETE FROM brands WHERE id = ?').run(id);
    return { ok: true };
  });
}

/** Upsert brand_redshift_config for a brand whose name matches a known preset. */
function applyPresetIfMatch(db: Database.Database, brandId: number, name: string): void {
  const preset = getBrandPreset(name);
  if (!preset) return;
  db.prepare(
    `INSERT INTO brand_redshift_config (brand_id, funnel_table, utm_source_list, utm_campaign_format, enabled)
     VALUES (?, ?, ?, 'mixed', 1)
     ON CONFLICT(brand_id) DO UPDATE SET
       funnel_table = excluded.funnel_table,
       utm_source_list = excluded.utm_source_list,
       enabled = 1`
  ).run(brandId, preset.funnel_table, JSON.stringify(preset.utm_source_list));
}
