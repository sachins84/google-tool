/**
 * Daily recommendation pipeline for one brand. Fire-and-forget, mirroring the
 * youtube/orchestrator job pattern: insert a run row (UNIQUE(brand,date) is the
 * dedupe lock), then snapshot metrics → optimize → persist recommendations.
 *
 * Snapshots are the persistence layer that makes "evaluate ROAS over a period"
 * possible — the live Google/Redshift fetch is on-demand and keeps no history.
 */
import { getDb } from '../../db/init.js';
import { config } from '../../config.js';
import { fetchRowsForBrand, type Row } from '../../routes/performance.js';
import {
  optimizePortfolio,
  bucketForReason,
  type CampaignInput,
  type SubEntityInput,
  type OptimizerConfig,
  type CandidateAction,
} from './optimizer.js';
import { buildRationale } from './rationale.js';
import { engineMultiplier } from './feedback.js';

const now = (): number => Math.floor(Date.now() / 1000);

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function dateMinus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return dateStr(d);
}

/** Build the OptimizerConfig for a brand from its rules rows + config defaults. */
function buildOptimizerConfig(brandId: number): { cfg: OptimizerConfig; portfolioTarget: number } {
  const rules = getDb()
    .prepare('SELECT kind, scope_level, json FROM rules WHERE (brand_id = ? OR brand_id IS NULL) AND enabled = 1')
    .all(brandId) as Array<{ kind: string; scope_level: string; json: string }>;

  const val = (kind: string, scope: string, fallback: number): number => {
    const r = rules.find((x) => x.kind === kind && x.scope_level === scope);
    if (!r) return fallback;
    try {
      return Number((JSON.parse(r.json) as { value: number }).value) ?? fallback;
    } catch {
      return fallback;
    }
  };

  const portfolioTarget = val('preference', 'portfolio', 4.0);
  const cfg: OptimizerConfig = {
    portfolioTargetRoas: portfolioTarget,
    floors: {
      campaign: val('floor', 'campaign', 2.0),
      asset_group: val('floor', 'asset_group', 2.0),
      keyword: val('floor', 'keyword', 1.5),
      ad: val('floor', 'ad', 1.5),
    },
    maxBudgetStepPct: val('cap', 'campaign', config.RECOMMENDER_MAX_BUDGET_STEP_PCT),
    minDataConv: config.RECOMMENDER_MIN_DATA_CONV,
    windowDays: config.RECOMMENDER_DEFAULT_WINDOW_DAYS,
    learningPhaseDays: config.RECOMMENDER_LEARNING_PHASE_DAYS,
    cooldownDays: config.RECOMMENDER_COOLDOWN_DAYS,
  };
  return { cfg, portfolioTarget };
}

/**
 * Campaign IDs treated as "in learning" — changed within the learning window,
 * either by an executed recommendation (reliable campaign id) or a recent manual
 * pause/settings mutation in audit_log (budget changes there carry the budget
 * resource, not the campaign id, so they're caught only via executed recs).
 */
function buildLearningSet(brandId: number, learningDays: number, cooldownDays: number): Set<string> {
  const db = getDb();
  const cutoff = now() - Math.max(learningDays, cooldownDays) * 86400;
  const set = new Set<string>();

  const recs = db
    .prepare(`SELECT entity_id FROM recommendations WHERE brand_id = ? AND level = 'campaign' AND status = 'executed' AND created_at > ?`)
    .all(brandId, cutoff) as Array<{ entity_id: string }>;
  for (const r of recs) set.add(r.entity_id);

  const audits = db
    .prepare(`SELECT target_resource FROM audit_log WHERE brand_id = ? AND dry_run = 0 AND created_at > ? AND target_resource LIKE '%/campaigns/%'`)
    .all(brandId, cutoff) as Array<{ target_resource: string }>;
  for (const a of audits) {
    const m = a.target_resource.match(/\/campaigns\/(\d+)/);
    if (m && m[1]) set.add(m[1]);
  }
  return set;
}

function campaignValue(m: Row['metrics']): { value: number; roas: number } {
  const value = m.ncs_amount != null ? m.ncs_amount : m.conversions_value_post_rto;
  const roas = m.calc_roas != null ? m.calc_roas : m.roas_post_rto;
  return { value, roas };
}

function writeSnapshots(brandId: number, today: string, window: string, level: string, rows: Row[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO metric_snapshots
       (brand_id, snapshot_date, window, level, customer_id, entity_id, entity_name,
        cost, conversions, conversions_value, roas_pre_rto, roas_post_rto,
        ncs, ncs_amount, calc_roas, daily_budget_inr, target_roas, bidding_strategy_type,
        channel_type, ad_strength, search_impression_share, search_budget_lost_impression_share)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(brand_id, snapshot_date, window, level, customer_id, entity_id) DO UPDATE SET
       cost=excluded.cost, conversions=excluded.conversions, conversions_value=excluded.conversions_value,
       roas_pre_rto=excluded.roas_pre_rto, roas_post_rto=excluded.roas_post_rto,
       ncs=excluded.ncs, ncs_amount=excluded.ncs_amount, calc_roas=excluded.calc_roas,
       daily_budget_inr=excluded.daily_budget_inr`
  );
  const entityId = (r: Row): string =>
    r.campaign_id ?? r.asset_group_id ?? r.ad_id ?? r.criterion_id ?? r.ad_group_id ?? '';
  const entityName = (r: Row): string =>
    r.campaign_name ?? r.asset_group_name ?? r.ad_name ?? r.keyword_text ?? r.ad_group_name ?? '';
  const tx = db.transaction((items: Row[]) => {
    for (const r of items) {
      const m = r.metrics;
      const id = entityId(r);
      if (!id) continue;
      stmt.run(
        brandId, today, window, level, r.customer_id, id, entityName(r),
        m.cost, m.conversions, m.conversions_value, m.roas_pre_rto, m.roas_post_rto,
        m.ncs, m.ncs_amount, m.calc_roas, r.daily_budget_inr ?? null, r.ad_group_target_roas ?? null,
        r.bidding_strategy_type ?? null, r.channel_type ?? null, r.ad_strength ?? null,
        m.search_impression_share ?? null, m.search_budget_lost_impression_share ?? null
      );
    }
  });
  tx(rows);
}

function persistRecommendation(runId: number, brandId: number, source: 'rules' | 'engine', a: CandidateAction, score: number, rationale: string): void {
  const bucket = bucketForReason(a.reason_codes[0] ?? '');
  getDb()
    .prepare(
      `INSERT INTO recommendations
        (run_id, brand_id, source, level, customer_id, entity_id, entity_name, mutate_action, bucket,
         mutate_payload_json, current_json, proposed_json, score, confidence,
         expected_impact_json, hard_constraints_json, reason_codes_json, rationale, diagnosis, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')`
    )
    .run(
      runId, brandId, source, a.level, a.customer_id, a.entity_id, a.entity_name, a.mutate_action, bucket,
      JSON.stringify(a.mutate_payload), JSON.stringify(a.current), JSON.stringify(a.proposed),
      score, a.confidence, JSON.stringify(a.expected_impact), JSON.stringify(a.hard_constraints),
      JSON.stringify(a.reason_codes), rationale, a.diagnosis ?? null
    );
}

/**
 * Insert the run row (dedupe lock) and detach the pipeline. Returns runId or
 * null if a run already exists today. `windowDays` is the user-chosen metric
 * evaluation window (defaults to config).
 */
export function startBrandRun(brandId: number, trigger: 'scheduled' | 'manual', windowDays?: number): number | null {
  const db = getDb();
  const today = dateStr(new Date());
  const win = windowDays && windowDays > 0 ? Math.round(windowDays) : config.RECOMMENDER_DEFAULT_WINDOW_DAYS;

  // Manual "Run now" regenerates: drop today's run (cascade clears its recs +
  // comments) so the operator can re-run, e.g. with a different window.
  // Scheduled runs keep the once-a-day dedupe (insert simply fails below).
  if (trigger === 'manual') {
    db.prepare('DELETE FROM recommendation_runs WHERE brand_id = ? AND run_date = ?').run(brandId, today);
  }

  let runId: number;
  try {
    const res = db
      .prepare(`INSERT INTO recommendation_runs (brand_id, run_date, trigger, status, eval_window_days, started_at) VALUES (?,?,?, 'running', ?, ?)`)
      .run(brandId, today, trigger, win, now());
    runId = res.lastInsertRowid as number;
  } catch {
    return null; // UNIQUE(brand_id, run_date) → scheduled run already exists today
  }
  void runBrand(runId, brandId, win).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    getDb().prepare(`UPDATE recommendation_runs SET status='failed', error=?, finished_at=? WHERE id=?`).run(msg, now(), runId);
  });
  return runId;
}

async function runBrand(runId: number, brandId: number, windowDays: number): Promise<void> {
  const today = dateStr(new Date());
  const { cfg, portfolioTarget } = buildOptimizerConfig(brandId);
  cfg.windowDays = windowDays; // user-chosen evaluation window
  const winLabel = `${windowDays}d`;

  // ── Phase 1: snapshot (campaign over chosen window + 30d slope + 1d trend; sub-entities over the chosen window)
  const [cW, c30, c1, agpRows, adRows, kwRows] = await Promise.all([
    fetchRowsForBrand('campaign', brandId, dateMinus(windowDays), today),
    fetchRowsForBrand('campaign', brandId, dateMinus(30), today),
    fetchRowsForBrand('campaign', brandId, dateMinus(1), today),
    fetchRowsForBrand('asset_group', brandId, dateMinus(windowDays), today),
    fetchRowsForBrand('ad', brandId, dateMinus(windowDays), today),
    fetchRowsForBrand('keyword', brandId, dateMinus(windowDays), today),
  ]);
  const c7 = cW; // primary window rows feed the optimizer
  writeSnapshots(brandId, today, winLabel, 'campaign', cW);
  if (winLabel !== '30d') writeSnapshots(brandId, today, '30d', 'campaign', c30);
  if (winLabel !== '1d') writeSnapshots(brandId, today, '1d', 'campaign', c1);
  writeSnapshots(brandId, today, winLabel, 'asset_group', agpRows);
  writeSnapshots(brandId, today, winLabel, 'ad', adRows);
  writeSnapshots(brandId, today, winLabel, 'keyword', kwRows);

  // ── Phase 2: assemble optimizer input ─────────────────────────────────────
  const learning = buildLearningSet(brandId, cfg.learningPhaseDays, cfg.cooldownDays);
  const roas30 = new Map<string, number>();
  for (const r of c30) if (r.campaign_id) roas30.set(`${r.customer_id}|${r.campaign_id}`, campaignValue(r.metrics).roas);
  const roas7 = new Map<string, number>();
  const rtoRatio = new Map<string, number>(); // campaign_id → post/pre RTO ratio (for sub-entity proxy)

  const campaigns: CampaignInput[] = c7
    .filter((r) => r.campaign_id && !r.synthetic)
    .map((r) => {
      const key = `${r.customer_id}|${r.campaign_id}`;
      const { value, roas } = campaignValue(r.metrics);
      roas7.set(key, roas);
      const ratio = r.metrics.roas_pre_rto > 0 ? Math.min(1, r.metrics.roas_post_rto / r.metrics.roas_pre_rto) : 1;
      rtoRatio.set(r.campaign_id as string, ratio);
      return {
        customer_id: r.customer_id,
        campaign_id: r.campaign_id as string,
        campaign_name: r.campaign_name ?? '',
        channel_type: r.channel_type,
        status: r.status,
        bidding_strategy_type: r.bidding_strategy_type,
        daily_budget_inr: r.daily_budget_inr ?? 0,
        target_roas: null,
        cost: r.metrics.cost,
        conversions: r.metrics.conversions,
        value_post_rto: value,
        roas_post_rto: roas,
        roas_pre_rto: r.metrics.roas_pre_rto,
        ctr: r.metrics.ctr,
        cpc: r.metrics.cpc,
        cpm: r.metrics.cpm,
        cvr: r.metrics.conversion_rate,
        lostISBudget: r.metrics.search_budget_lost_impression_share ?? null,
        lostISRank: r.metrics.search_rank_lost_impression_share ?? null,
        searchIS: r.metrics.search_impression_share ?? null,
        roas7d: roas,
        roas30d: roas30.get(key) ?? null,
        inLearning: learning.has(r.campaign_id as string),
      };
    });

  // Sub-entities: ROAS is RTO-adjusted by the parent campaign's ratio (post-RTO
  // ROAS isn't available below campaign level — documented assumption).
  const subEntities: SubEntityInput[] = [];
  const pushSub = (level: SubEntityInput['level'], rows: Row[]): void => {
    for (const r of rows) {
      if (r.synthetic) continue;
      const parent = r.campaign_id ?? '';
      const ratio = rtoRatio.get(parent) ?? 1;
      subEntities.push({
        level,
        customer_id: r.customer_id,
        parent_campaign_id: parent,
        entity_id: (level === 'asset_group' ? r.asset_group_id : level === 'ad' ? r.ad_id : r.criterion_id) ?? '',
        entity_name: r.asset_group_name ?? r.ad_name ?? r.keyword_text ?? '',
        ad_group_id: r.ad_group_id,
        asset_group_id: r.asset_group_id,
        criterion_id: r.criterion_id,
        ad_id: r.ad_id,
        cost: r.metrics.cost,
        conversions: r.metrics.conversions,
        roas_pre_rto: r.metrics.roas_pre_rto * ratio,
        ad_strength: r.ad_strength ?? null,
        parentInLearning: learning.has(parent),
      });
    }
  };
  pushSub('asset_group', agpRows);
  pushSub('ad', adRows);
  pushSub('keyword', kwRows);

  // ── Phase 3: optimize (deterministic) + persist both views ─────────────────
  const result = optimizePortfolio({ campaigns, subEntities, config: cfg });
  const tx = getDb().transaction(() => {
    for (const a of result.actions) {
      const rationale = buildRationale(a, portfolioTarget);
      persistRecommendation(runId, brandId, 'rules', a, a.baseScore, rationale);
      const mult = engineMultiplier(brandId, a.reason_codes[0] ?? '');
      persistRecommendation(runId, brandId, 'engine', a, a.baseScore * mult, rationale);
    }
    getDb()
      .prepare(
        `UPDATE recommendation_runs SET status='completed', portfolio_target_roas=?, current_blended_roas=?,
           projected_blended_roas=?, target_reachable=?, config_json=?, notes=?, finished_at=? WHERE id=?`
      )
      .run(
        portfolioTarget, result.currentBlendedRoas, result.projectedBlendedRoas,
        result.targetReachable ? 1 : 0, JSON.stringify(cfg), result.notes.join(' '), now(), runId
      );
  });
  tx();
}
