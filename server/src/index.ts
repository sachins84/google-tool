import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config, projectRoot } from './config.js';
import { initDatabase } from './db/init.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/accounts.js';
import { brandRoutes } from './routes/brands.js';
import { performanceRoutes } from './routes/performance.js';
import { assetRoutes } from './routes/assets.js';
import { mutateRoutes } from './routes/mutate.js';
import { auditRoutes } from './routes/audit.js';
import { insightsRoutes } from './routes/insights.js';
import { mcpRoutes } from './routes/mcp.js';
import { campaignBreakdownRoutes } from './routes/campaign-breakdown.js';
import { diagnoseRoutes } from './routes/diagnose.js';
import { audienceRoutes } from './routes/audiences.js';
import { productRoutes } from './routes/products.js';
import { videoAssetRoutes } from './routes/video-assets.js';
import { youtubeRoutes } from './routes/youtube.js';

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
  await app.register(performanceRoutes, { prefix: '/api' });
  await app.register(assetRoutes, { prefix: '/api/assets' });
  await app.register(mutateRoutes, { prefix: '/api/mutate' });
  await app.register(auditRoutes, { prefix: '/api/audit' });
  await app.register(insightsRoutes, { prefix: '/api/insights' });
  await app.register(campaignBreakdownRoutes, { prefix: '/api/campaign-breakdown' });
  await app.register(diagnoseRoutes, { prefix: '/api/diagnose' });
  await app.register(audienceRoutes, { prefix: '/api/audiences' });
  await app.register(productRoutes, { prefix: '/api/products' });
  await app.register(videoAssetRoutes, { prefix: '/api/video-assets' });
  await app.register(youtubeRoutes, { prefix: '/api/youtube' });

  // MCP server — public (or token-gated via MCP_SECRET). Mounted outside /api/* so
  // it bypasses the session-cookie auth middleware.
  await app.register(mcpRoutes, { prefix: '/mcp' });

  if (config.NODE_ENV === 'production') {
    const webDist = path.join(projectRoot, 'web', 'dist');
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  console.log(`[server] listening on http://localhost:${config.PORT}`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
