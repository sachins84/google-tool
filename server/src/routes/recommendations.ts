import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db/init.js';
import { getBrand } from '../services/brands.js';
import { startBrandRun } from '../services/recommender/runner.js';
import { applyFeedbackLearning } from '../services/recommender/feedback.js';
import { recommendMix, type ChannelState } from '../services/recommender/portfolio_mix.js';
import { config } from '../config.js';

interface RecRow {
  id: number; run_id: number; brand_id: number; source: string; level: string;
  customer_id: string; entity_id: string; entity_name: string | null; mutate_action: string;
  bucket: string | null; user_action: string | null; channel_type: string | null;
  mutate_payload_json: string; current_json: string | null; proposed_json: string | null;
  score: number; confidence: number; expected_impact_json: string | null;
  hard_constraints_json: string | null; reason_codes_json: string | null; rationale: string | null;
  diagnosis: string | null;
  status: string; audit_log_id: number | null;
}

function shape(r: RecRow, commentCount = 0): Record<string, unknown> {
  const parse = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return {
    id: r.id, run_id: r.run_id, source: r.source, level: r.level, customer_id: r.customer_id,
    entity_id: r.entity_id, entity_name: r.entity_name, mutate_action: r.mutate_action,
    bucket: r.bucket, user_action: r.user_action, channel_type: r.channel_type,
    mutate_payload: parse(r.mutate_payload_json), current: parse(r.current_json), proposed: parse(r.proposed_json),
    score: r.score, confidence: r.confidence, expected_impact: parse(r.expected_impact_json),
    hard_constraints: parse(r.hard_constraints_json), reason_codes: parse(r.reason_codes_json),
    rationale: r.rationale, diagnosis: r.diagnosis, status: r.status, audit_log_id: r.audit_log_id, comment_count: commentCount,
  };
}

const decisionSchema = z.object({
  decision: z.enum(['accepted', 'rejected', 'overridden']),
  override_payload: z.record(z.string(), z.unknown()).optional(), // full action-specific body for an override
  reason: z.string().optional(),
});

export async function recommendationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Latest (or specified) run with manual-rules vs engine side-by-side + diff.
  app.get('/', async (req, reply) => {
    const q = z.object({ brand_id: z.coerce.number(), run_date: z.string().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const db = getDb();
    const run = (q.data.run_date
      ? db.prepare('SELECT * FROM recommendation_runs WHERE brand_id=? AND run_date=?').get(q.data.brand_id, q.data.run_date)
      : db.prepare(`SELECT * FROM recommendation_runs WHERE brand_id=? AND status='completed' ORDER BY run_date DESC LIMIT 1`).get(q.data.brand_id)
    ) as { id: number } | undefined;
    if (!run) return { run: null, rules: [], engine: [], diff: [] };

    const all = db.prepare('SELECT * FROM recommendations WHERE run_id=? ORDER BY score DESC').all(run.id) as RecRow[];
    const counts = new Map<number, number>(
      (db.prepare(
        `SELECT recommendation_id AS id, COUNT(*) AS n FROM recommendation_comments
         WHERE recommendation_id IN (SELECT id FROM recommendations WHERE run_id=?) GROUP BY recommendation_id`
      ).all(run.id) as Array<{ id: number; n: number }>).map((r) => [r.id, r.n])
    );
    const rules = all.filter((r) => r.source === 'rules').map((r) => shape(r, counts.get(r.id) ?? 0));
    const engine = all.filter((r) => r.source === 'engine').map((r) => shape(r, counts.get(r.id) ?? 0));

    // Diff joins on (level, entity_id, mutate_action). Rank = position in each sorted list.
    const key = (r: Record<string, unknown>): string => `${r.level}|${r.entity_id}|${r.mutate_action}`;
    const rankOf = (list: Record<string, unknown>[], k: string): number => list.findIndex((r) => key(r) === k);
    const keys = new Set([...rules.map(key), ...engine.map(key)]);
    const diff = [...keys].map((k) => {
      const rr = rankOf(rules, k), er = rankOf(engine, k);
      return {
        key: k,
        in: rr >= 0 && er >= 0 ? 'both' : rr >= 0 ? 'rules_only' : 'engine_only',
        rank_rules: rr >= 0 ? rr + 1 : null,
        rank_engine: er >= 0 ? er + 1 : null,
      };
    });

    return { run, rules, engine, diff };
  });

  // Trend: blended post-RTO ROAS over snapshot dates.
  app.get('/trend', async (req, reply) => {
    const q = z.object({ brand_id: z.coerce.number(), window: z.string().default('7d') }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const rows = getDb().prepare(
      `SELECT snapshot_date,
              SUM(cost) AS cost,
              SUM(COALESCE(ncs_amount, conversions_value)) AS value
       FROM metric_snapshots
       WHERE brand_id=? AND level='campaign' AND window=?
       GROUP BY snapshot_date ORDER BY snapshot_date`
    ).all(q.data.brand_id, q.data.window) as Array<{ snapshot_date: string; cost: number; value: number }>;
    return {
      series: rows.map((r) => ({
        date: r.snapshot_date, cost: r.cost, value: r.value,
        blended_roas: r.cost > 0 ? Math.round((r.value / r.cost) * 100) / 100 : 0,
      })),
    };
  });

  // Manually trigger a run (testing / on-demand). Returns 409 if today's run exists.
  // window_days = the metric evaluation window the user chose.
  app.post('/run', async (req, reply) => {
    const q = z.object({ brand_id: z.coerce.number(), window_days: z.coerce.number().min(1).max(90).optional() }).safeParse(req.body);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    if (!getBrand(q.data.brand_id)) return reply.code(404).send({ error: 'Brand not found' });
    const runId = startBrandRun(q.data.brand_id, 'manual', q.data.window_days);
    if (!runId) return reply.code(409).send({ error: "Today's run already exists for this brand — open it or come back tomorrow" });
    return { ok: true, run_id: runId };
  });

  // Date-stamped comments on a recommendation (backtrack rationale).
  app.get('/:id/comments', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const rows = getDb()
      .prepare('SELECT id, username, comment, created_at FROM recommendation_comments WHERE recommendation_id=? ORDER BY created_at')
      .all(id);
    return { comments: rows };
  });

  app.post('/:id/comments', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ comment: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const rec = getDb().prepare('SELECT id FROM recommendations WHERE id=?').get(id);
    if (!rec) return reply.code(404).send({ error: 'Recommendation not found' });
    getDb()
      .prepare('INSERT INTO recommendation_comments (recommendation_id, user_id, username, comment) VALUES (?,?,?,?)')
      .run(id, req.user?.id ?? null, req.user?.username ?? null, parsed.data.comment);
    return { ok: true };
  });

  // Channel-level capital allocation: current vs recommended spend mix per
  // campaign type, aggregated from the latest metric_snapshots. Strategic
  // guidance — execution still flows through the per-campaign approve path.
  app.get('/mix', async (req, reply) => {
    const q = z.object({ brand_id: z.coerce.number(), window: z.string().default('7d') }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const db = getDb();
    // Use the most recent snapshot_date we have for this window (matches the
    // latest run's snapshots so the panel never shows stale aggregates).
    const latest = db.prepare(
      `SELECT MAX(snapshot_date) AS d FROM metric_snapshots WHERE brand_id=? AND window=? AND level='campaign'`
    ).get(q.data.brand_id, q.data.window) as { d: string | null } | undefined;
    if (!latest?.d) return { date: null, run_window_days: null, mix: null, halo_rules: [] };
    const windowDays = Number((q.data.window || '7d').replace(/[^0-9]/g, '')) || 7;

    const rows = db.prepare(
      `SELECT channel_type,
              SUM(cost) AS cost,
              SUM(COALESCE(ncs_amount, conversions_value)) AS value,
              AVG(search_budget_lost_impression_share) AS lost_is_budget
       FROM metric_snapshots
       WHERE brand_id=? AND snapshot_date=? AND window=? AND level='campaign' AND channel_type IS NOT NULL
       GROUP BY channel_type`
    ).all(q.data.brand_id, latest.d, q.data.window) as Array<{ channel_type: string; cost: number; value: number; lost_is_budget: number | null }>;

    // Halo bonuses from rules (kind='preference', metric='halo_bonus', channel=X).
    // Defaults to 0 if no rule exists for a channel — the user explicitly chose
    // pure direct-ROAS allocation; halo machinery is wired but inert by default.
    const haloRules = db.prepare(
      `SELECT json FROM rules WHERE (brand_id=? OR brand_id IS NULL) AND enabled=1
        AND kind='preference' AND COALESCE(json_extract(json,'$.metric'),'')='halo_bonus'`
    ).all(q.data.brand_id) as Array<{ json: string }>;
    const halo: Record<string, number> = {};
    for (const r of haloRules) {
      try {
        const p = JSON.parse(r.json) as { channel?: string; value: number };
        if (p.channel) halo[p.channel] = Number(p.value);
      } catch { /* skip malformed */ }
    }

    // Per-channel min/max share rules (kind='cap'/'floor' metric='spend_share' channel=X).
    // Defaults: floor 0, cap 0.7.
    const shareRules = db.prepare(
      `SELECT kind, json FROM rules WHERE (brand_id=? OR brand_id IS NULL) AND enabled=1
        AND scope_level='campaign' AND COALESCE(json_extract(json,'$.metric'),'')='spend_share'`
    ).all(q.data.brand_id) as Array<{ kind: string; json: string }>;
    const shareFloor: Record<string, number> = {};
    const shareCap: Record<string, number> = {};
    for (const r of shareRules) {
      try {
        const p = JSON.parse(r.json) as { channel?: string; value: number };
        if (!p.channel) continue;
        if (r.kind === 'floor') shareFloor[p.channel] = Number(p.value);
        else if (r.kind === 'cap') shareCap[p.channel] = Number(p.value);
      } catch { /* skip */ }
    }

    // Portfolio target from rules
    const portfolioTarget = (() => {
      const r = db.prepare(`SELECT json FROM rules WHERE brand_id=? AND enabled=1 AND kind='preference' AND scope_level='portfolio' LIMIT 1`).get(q.data.brand_id) as { json: string } | undefined;
      try { return r ? Number((JSON.parse(r.json) as { value: number }).value) : 4.0; } catch { return 4.0; }
    })();

    const channels: ChannelState[] = rows
      .filter((r) => r.cost > 0)
      .map((r) => ({
        channel: r.channel_type,
        spend: r.cost / windowDays,
        value: (r.value ?? 0) / windowDays,
        direct_roas: r.cost > 0 ? (r.value ?? 0) / r.cost : 0,
        lost_is_budget: r.lost_is_budget,
        halo_bonus: halo[r.channel_type] ?? 0,
      }));

    const mix = recommendMix(channels, {
      portfolioTargetRoas: portfolioTarget,
      shareFloor, shareCap,
      maxStepPct: Math.min(config.RECOMMENDER_MAX_BUDGET_STEP_PCT, 0.15),
    });
    return { date: latest.d, window: q.data.window, run_window_days: windowDays, mix, halo_rules: Object.entries(halo).map(([channel, value]) => ({ channel, value })) };
  });

  // Per-run rollup: one row per (brand, run_date) with totals + per-bucket
  // suggested-vs-actioned. Drives the "Run history" panel on the Actions tab
  // so operators can see, day-by-day, how many suggestions the optimizer made
  // and how many landed as real changes.
  app.get('/runs', async (req, reply) => {
    const q = z.object({ brand_id: z.coerce.number(), days: z.coerce.number().min(1).max(180).default(30) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const db = getDb();

    const runs = db.prepare(
      `SELECT id, run_date, trigger, status, started_at, finished_at,
              current_blended_roas, portfolio_target_roas, projected_blended_roas,
              target_reachable, eval_window_days, notes
       FROM recommendation_runs
       WHERE brand_id = ? AND run_date >= date('now', ?)
       ORDER BY run_date DESC`
    ).all(q.data.brand_id, `-${q.data.days} days`) as Array<{
      id: number; run_date: string; trigger: string; status: string;
      started_at: number | null; finished_at: number | null;
      current_blended_roas: number | null; portfolio_target_roas: number | null;
      projected_blended_roas: number | null; target_reachable: number | null;
      eval_window_days: number | null; notes: string | null;
    }>;
    if (runs.length === 0) return { runs: [] };

    // Bucket breakdown per run. source='engine' to avoid double-counting the
    // rules mirror — same convention as /summary. COALESCE(bucket,'hold')
    // catches older recs whose bucket wasn't set when the column was added.
    const placeholders = runs.map(() => '?').join(',');
    const bucketRows = db.prepare(
      `SELECT run_id, COALESCE(bucket,'hold') AS bucket,
              COUNT(*) AS suggested,
              SUM(CASE WHEN status IN ('accepted','overridden','executed') THEN 1 ELSE 0 END) AS actioned,
              SUM(CASE WHEN status='executed' THEN 1 ELSE 0 END) AS executed,
              SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status='overridden' THEN 1 ELSE 0 END) AS overridden
       FROM recommendations
       WHERE source='engine' AND run_id IN (${placeholders})
       GROUP BY run_id, COALESCE(bucket,'hold')`
    ).all(...runs.map((r) => r.id)) as Array<{
      run_id: number; bucket: string; suggested: number; actioned: number;
      executed: number; rejected: number; pending: number; overridden: number;
    }>;

    const byRun = new Map<number, Record<string, { suggested: number; actioned: number; executed: number; rejected: number; pending: number; overridden: number }>>();
    for (const b of bucketRows) {
      const m = byRun.get(b.run_id) ?? {};
      m[b.bucket] = { suggested: b.suggested, actioned: b.actioned, executed: b.executed, rejected: b.rejected, pending: b.pending, overridden: b.overridden };
      byRun.set(b.run_id, m);
    }

    return {
      runs: runs.map((r) => {
        const buckets = byRun.get(r.id) ?? {};
        const totals = Object.values(buckets).reduce(
          (s, x) => ({ suggested: s.suggested + x.suggested, actioned: s.actioned + x.actioned, executed: s.executed + x.executed, rejected: s.rejected + x.rejected, pending: s.pending + x.pending, overridden: s.overridden + x.overridden }),
          { suggested: 0, actioned: 0, executed: 0, rejected: 0, pending: 0, overridden: 0 }
        );
        return {
          run_id: r.id, run_date: r.run_date, trigger: r.trigger, status: r.status,
          started_at: r.started_at, finished_at: r.finished_at,
          eval_window_days: r.eval_window_days, notes: r.notes,
          current_blended_roas: r.current_blended_roas,
          portfolio_target_roas: r.portfolio_target_roas,
          projected_blended_roas: r.projected_blended_roas,
          target_reachable: r.target_reachable == null ? null : Boolean(r.target_reachable),
          totals, buckets,
        };
      }),
    };
  });

  // Daily suggestions-vs-actions check, grouped by bucket + level.
  app.get('/summary', async (req, reply) => {
    const q = z.object({ brand_id: z.coerce.number(), days: z.coerce.number().min(1).max(90).default(30) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    // Engine source only (avoids double-counting the rules mirror). actioned =
    // accepted/overridden/executed; the rest are rejected or still pending.
    const rows = getDb().prepare(
      `SELECT rr.run_date AS run_date, r.bucket AS bucket, r.level AS level,
              COUNT(*) AS suggested,
              SUM(CASE WHEN r.status IN ('accepted','overridden','executed') THEN 1 ELSE 0 END) AS actioned,
              SUM(CASE WHEN r.status='rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN r.status='pending' THEN 1 ELSE 0 END) AS pending
       FROM recommendations r JOIN recommendation_runs rr ON rr.id = r.run_id
       WHERE r.brand_id = ? AND r.source = 'engine' AND rr.run_date >= date('now', ?)
       GROUP BY rr.run_date, r.bucket, r.level
       ORDER BY rr.run_date DESC, r.bucket, r.level`
    ).all(q.data.brand_id, `-${q.data.days} days`);
    return { summary: rows };
  });

  // Accept / reject / override a recommendation. Accept+override execute through
  // the existing /api/mutate pipeline (dry-run first) so every change is audited.
  app.post('/:id/decision', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { decision, override_payload, reason } = parsed.data;

    const db = getDb();
    const rec = db.prepare('SELECT * FROM recommendations WHERE id=?').get(id) as RecRow | undefined;
    if (!rec) return reply.code(404).send({ error: 'Recommendation not found' });
    if (rec.status !== 'pending') return reply.code(409).send({ error: `Already ${rec.status}` });
    if (rec.mutate_action === 'monitor') return reply.code(400).send({ error: 'Monitor rows are informational — nothing to apply' });

    const reasonCodes = (() => { try { return JSON.parse(rec.reason_codes_json ?? '[]') as string[]; } catch { return []; } })();
    const recordDecision = (overrideJson: string | null): void => {
      db.prepare(
        `INSERT INTO recommendation_feedback (recommendation_id, user_id, decision, override_payload_json, reason, reason_codes_json)
         VALUES (?,?,?,?,?,?)`
      ).run(id, req.user?.id ?? null, decision, overrideJson, reason ?? null, JSON.stringify(reasonCodes));
      applyFeedbackLearning(rec.brand_id, reasonCodes, decision);
    };

    if (decision === 'rejected') {
      db.prepare(`UPDATE recommendations SET status='rejected', user_action='rejected' WHERE id=?`).run(id);
      recordDecision(null);
      return { ok: true, status: 'rejected' };
    }

    // accept or override → execute via /api/mutate (dry-run, then live)
    const actionPayload = decision === 'overridden' && override_payload
      ? override_payload
      : (JSON.parse(rec.mutate_payload_json) as Record<string, unknown>);
    const body = { ...actionPayload, brand_id: rec.brand_id, customer_id: rec.customer_id };
    const cookie = req.headers.cookie ?? '';
    const headers = { cookie, 'content-type': 'application/json' };

    const dry = await app.inject({ method: 'POST', url: '/api/mutate', headers, payload: { ...body, dry_run: true } });
    if (dry.statusCode !== 200) {
      return reply.code(422).send({ error: 'Dry-run failed', detail: safeJson(dry.body) });
    }
    const live = await app.inject({ method: 'POST', url: '/api/mutate', headers, payload: { ...body, dry_run: false } });
    if (live.statusCode !== 200) {
      return reply.code(500).send({ error: 'Execution failed', detail: safeJson(live.body) });
    }
    const auditId = (live.json() as { audit_id?: number }).audit_id ?? null;
    db.prepare(`UPDATE recommendations SET status='executed', user_action=?, audit_log_id=? WHERE id=?`)
      .run(decision === 'overridden' ? 'overridden' : 'accepted', auditId, id);
    recordDecision(decision === 'overridden' ? JSON.stringify(override_payload) : null);
    return { ok: true, status: 'executed', audit_log_id: auditId };
  });
}

function safeJson(body: string): unknown {
  try { return JSON.parse(body); } catch { return body; }
}
