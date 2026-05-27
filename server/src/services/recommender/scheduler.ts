/**
 * Minimal in-process daily scheduler. No cron dependency: a 15-minute timer
 * checks whether today's run exists for each brand (the UNIQUE(brand_id,
 * run_date) constraint in startBrandRun is the real lock, so this survives
 * restarts and never double-runs). Gated by config.ENABLE_RECOMMENDER.
 */
import { getDb } from '../../db/init.js';
import { config } from '../../config.js';
import { startBrandRun } from './runner.js';

const TICK_MS = 15 * 60 * 1000;

function tick(): void {
  const hour = new Date().getHours();
  if (hour < config.RECOMMENDER_RUN_HOUR) return; // wait until upstream data settles
  const brands = getDb().prepare('SELECT id FROM brands').all() as Array<{ id: number }>;
  for (const b of brands) {
    const runId = startBrandRun(b.id, 'scheduled');
    if (runId) console.log(`[recommender] started daily run ${runId} for brand ${b.id}`);
  }
}

export function startRecommenderScheduler(): void {
  if (!config.ENABLE_RECOMMENDER) {
    console.log('[recommender] scheduler disabled (set ENABLE_RECOMMENDER=true to enable)');
    return;
  }
  console.log(`[recommender] scheduler on — daily after ${config.RECOMMENDER_RUN_HOUR}:00, checking every 15m`);
  setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.error('[recommender] tick error:', err instanceof Error ? err.message : err);
    }
  }, TICK_MS);
  // Kick once shortly after boot (not synchronously, so listen() isn't blocked).
  setTimeout(() => {
    try { tick(); } catch { /* logged next tick */ }
  }, 30_000);
}
