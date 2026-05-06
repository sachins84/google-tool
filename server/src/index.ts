import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { config } from './config.js';
import { initDatabase } from './db/init.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/accounts.js';
import { brandRoutes } from './routes/brands.js';

async function main(): Promise<void> {
  initDatabase();

  const app = Fastify({
    logger: { level: config.NODE_ENV === 'development' ? 'info' : 'warn' },
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(cors, {
    origin: config.NODE_ENV === 'development' ? ['http://localhost:5173'] : true,
    credentials: true,
  });

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(accountRoutes, { prefix: '/api/accounts' });
  await app.register(brandRoutes, { prefix: '/api/brands' });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  console.log(`[server] listening on http://localhost:${config.PORT}`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
