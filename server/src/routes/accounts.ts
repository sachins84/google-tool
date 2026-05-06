import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { clearMccMapCache, getAllAccounts } from '../services/mcc-map.js';

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // GET /api/accounts/accessible — full list across all accessible MCCs
  // Returns accounts with login_customer_id set when one is required for queries.
  app.get('/accessible', async (req, reply) => {
    try {
      const force = (req.query as { refresh?: string } | undefined)?.refresh === '1';
      if (force) clearMccMapCache();
      const accounts = await getAllAccounts(force);
      return {
        accounts: accounts.map((a) => ({
          customer_id: a.customer_id,
          descriptive_name: a.descriptive_name ?? null,
          currency_code: a.currency_code ?? null,
          time_zone: a.time_zone ?? null,
          is_manager: a.is_manager,
          status: a.status,
          login_customer_id: a.login_customer_id,
          source: a.source,
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });
}
