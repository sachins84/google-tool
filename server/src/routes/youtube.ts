import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { listConfiguredChannels } from '../services/youtube/channels.js';
import {
  startJob,
  getJob,
  listJobs,
  getJobRows,
} from '../services/youtube/orchestrator.js';

const startSchema = z.object({
  channel_key: z.string().min(1),
  sheet: z.string().min(1),
  sheet_tab: z.string().optional(),
  privacy_status: z.enum(['unlisted', 'private', 'public']).default('unlisted'),
});

export async function youtubeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/channels', async () => {
    const channels = await listConfiguredChannels();
    return { channels };
  });

  app.post('/upload', async (req, reply) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const job = await startJob({
        userId: req.user?.id ?? null,
        channelKey: parsed.data.channel_key,
        sheetInput: parsed.data.sheet,
        sheetTab: parsed.data.sheet_tab,
        privacyStatus: parsed.data.privacy_status,
      });
      return { job };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  app.get('/jobs', async () => ({ jobs: listJobs(50) }));

  app.get('/jobs/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Bad id' });
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return { job, rows: getJobRows(id) };
  });
}
