import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

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
      const result = db.prepare(
        'INSERT INTO brands (name, rto_factor, rto_mode) VALUES (?, ?, ?)'
      ).run(data.name, data.rto_factor, data.rto_mode);
      const brandId = result.lastInsertRowid as number;
      for (const cid of data.account_ids) {
        db.prepare(
          'INSERT INTO brand_accounts (brand_id, customer_id) VALUES (?, ?)'
        ).run(brandId, cid);
      }
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
      db.prepare(
        'UPDATE brands SET name = ?, rto_factor = ?, rto_mode = ? WHERE id = ?'
      ).run(data.name, data.rto_factor, data.rto_mode, id);
      db.prepare('DELETE FROM brand_accounts WHERE brand_id = ?').run(id);
      for (const cid of data.account_ids) {
        db.prepare('INSERT INTO brand_accounts (brand_id, customer_id) VALUES (?, ?)').run(id, cid);
      }
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
