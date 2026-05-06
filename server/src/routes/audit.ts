import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const querySchema = z.object({
  brand_id: z.coerce.number().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(100),
});

interface AuditRow {
  id: number;
  user_id: number | null;
  username: string | null;
  action: string;
  brand_id: number | null;
  brand_name: string | null;
  customer_id: string | null;
  target_resource: string | null;
  before_json: string | null;
  after_json: string | null;
  dry_run: number;
  response_json: string | null;
  created_at: number;
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q.brand_id) { where.push('a.brand_id = ?'); params.push(q.brand_id); }
    if (q.action) { where.push('a.action LIKE ?'); params.push(`${q.action}%`); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = getDb()
      .prepare(
        `SELECT a.id, a.user_id, u.username, a.action, a.brand_id, b.name AS brand_name,
                a.customer_id, a.target_resource, a.before_json, a.after_json,
                a.dry_run, a.response_json, a.created_at
         FROM audit_log a
         LEFT JOIN users u ON a.user_id = u.id
         LEFT JOIN brands b ON a.brand_id = b.id
         ${whereClause}
         ORDER BY a.id DESC
         LIMIT ?`
      )
      .all(...params, q.limit) as AuditRow[];

    return {
      entries: rows.map((r) => ({
        id: r.id,
        username: r.username,
        action: r.action,
        brand_name: r.brand_name,
        customer_id: r.customer_id,
        target_resource: r.target_resource,
        before: r.before_json ? JSON.parse(r.before_json) : null,
        after: r.after_json ? JSON.parse(r.after_json) : null,
        dry_run: r.dry_run === 1,
        response: r.response_json ? JSON.parse(r.response_json) : null,
        created_at: r.created_at,
      })),
    };
  });
}
