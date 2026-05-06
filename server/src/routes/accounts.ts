import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { getCustomerInfo, listAccessibleCustomers } from '../services/google-ads.js';

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // GET /api/accounts/accessible — list all customers our refresh token can see.
  // Hydrates each with descriptive_name + currency + timezone for the Settings UI.
  app.get('/accessible', async (_req, reply) => {
    try {
      const ids = await listAccessibleCustomers();
      const enriched = await Promise.all(
        ids.map(async (id) => {
          try {
            const info = await getCustomerInfo(id);
            return {
              customer_id: id,
              descriptive_name: info?.descriptiveName ?? null,
              currency_code: info?.currencyCode ?? null,
              time_zone: info?.timeZone ?? null,
              is_manager: info?.manager ?? false,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            app.log.warn({ customer_id: id, err: message }, 'hydrate failed');
            return {
              customer_id: id,
              descriptive_name: null,
              currency_code: null,
              time_zone: null,
              is_manager: false,
              error: message,
            };
          }
        })
      );
      return { accounts: enriched };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });
}
