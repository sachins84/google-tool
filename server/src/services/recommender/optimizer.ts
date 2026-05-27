/**
 * Portfolio optimizer — pure, deterministic, no I/O, no network.
 *
 * Goal (per product spec): hit a ROAS guardrail at the PORTFOLIO (brand) level
 * while preserving SCALE — not by slashing spend. ROAS is tested on the blended
 * brand total (Σ value / Σ cost), never per campaign. Per-entity MIN floors are
 * hard constraints. Budget is reallocated WITHIN each customer_id (separate
 * billing accounts can't fund each other). Every change is capped per run so
 * Google's bid algorithm stays stable, and campaigns in their learning phase are
 * frozen (monitor only).
 *
 * This module owns the numbers and the hard constraints. Rule weights (which
 * only re-rank, never relax a floor or exceed a cap) are applied downstream by
 * the runner/feedback layer.
 */

export type RecLevel = 'campaign' | 'ad_group' | 'asset_group' | 'ad' | 'keyword';
export type RecMutateAction =
  | 'update_budget'
  | 'update_campaign_settings'
  | 'pause'
  | 'add_negative_keyword'
  | 'pause_asset'
  | 'monitor';

export interface OptimizerFloors {
  campaign: number;
  asset_group: number;
  keyword: number;
  ad: number;
}

export interface OptimizerConfig {
  portfolioTargetRoas: number;
  floors: OptimizerFloors;
  maxBudgetStepPct: number; // e.g. 0.20
  minDataConv: number; // confidence gate
  windowDays: number; // length of the primary evaluation window (for daily-unit math)
  learningPhaseDays: number; // used by the runner to compute inLearning (optimizer ignores)
  cooldownDays: number; // used by the runner to compute inLearning (optimizer ignores)
  /** Pause (vs. scale-down) a loser when its ROAS is below floor × this. */
  killThresholdPct?: number; // default 0.5
  /** Max upward tROAS step as a fraction of current (default 0.15), clamped to 0.5..10. */
  troasStepPct?: number;
}

export interface CampaignInput {
  customer_id: string;
  campaign_id: string;
  campaign_name: string;
  channel_type?: string;
  status?: string;
  bidding_strategy_type?: string;
  daily_budget_inr: number;
  target_roas?: number | null; // current campaign tROAS, if value-bidding
  // Primary-window metrics (already post-RTO where available):
  cost: number;
  conversions: number;
  value_post_rto: number;
  roas_post_rto: number;
  roas_pre_rto: number;
  lostISBudget?: number | null; // 0..1 search budget-lost IS
  roas7d?: number | null;
  roas30d?: number | null;
  inLearning: boolean; // precomputed by the runner (start_date + audit history)
}

export interface SubEntityInput {
  level: 'ad_group' | 'asset_group' | 'ad' | 'keyword';
  customer_id: string;
  parent_campaign_id: string;
  entity_id: string;
  entity_name: string;
  // ids needed to build a /api/mutate pause payload:
  ad_group_id?: string;
  asset_group_id?: string;
  criterion_id?: string;
  ad_id?: string;
  cost: number;
  conversions: number;
  roas_pre_rto: number;
  ad_strength?: string | null; // asset_group (PMax) only
  parentInLearning?: boolean;
}

export interface CandidateAction {
  level: RecLevel;
  customer_id: string;
  entity_id: string;
  entity_name: string;
  mutate_action: RecMutateAction;
  /** Action-specific body for POST /api/mutate (brand_id, customer_id, dry_run added at exec). */
  mutate_payload: Record<string, unknown>;
  current: Record<string, number>;
  proposed: Record<string, number>;
  baseScore: number;
  confidence: number;
  expected_impact: { delta_value: number; delta_cost: number };
  hard_constraints: string[];
  reason_codes: string[];
}

export interface OptimizerResult {
  actions: CandidateAction[];
  currentBlendedRoas: number;
  projectedBlendedRoas: number;
  targetReachable: boolean;
  notes: string[];
}

export interface PortfolioInput {
  campaigns: CampaignInput[];
  subEntities: SubEntityInput[];
  config: OptimizerConfig;
}

const clamp = (lo: number, hi: number, x: number): number => Math.max(lo, Math.min(hi, x));

/** Cost-weighted blended ROAS — the portfolio guardrail metric. */
export function blendedRoas(cost: number, value: number): number {
  return cost > 0 ? value / cost : 0;
}

/**
 * Saturation penalty β ∈ [0, 0.6]. High lost-IS-to-budget ⇒ a budget-constrained
 * winner ⇒ low β (scaling is cheap). A falling 7d-vs-30d ROAS slope ⇒ near
 * saturation ⇒ high β (don't pour money in). Falls back to a moderate default
 * when neither signal exists (cold start).
 */
function saturation(c: CampaignInput): number {
  const hasIS = c.lostISBudget != null && c.lostISBudget >= 0;
  const hasSlope = c.roas7d != null && c.roas30d != null && (c.roas30d as number) > 0;
  if (!hasIS && !hasSlope) return 0.3;
  const isComponent = hasIS ? 1 - (c.lostISBudget as number) : 0.3;
  const slope = hasSlope ? ((c.roas7d as number) - (c.roas30d as number)) / (c.roas30d as number) : 0;
  const slopePenalty = Math.max(0, -slope); // negative slope (decaying) ⇒ penalty
  const wIs = hasIS ? 0.6 : 0;
  const wSlope = hasSlope ? 0.4 : 0;
  const total = wIs + wSlope || 1;
  return clamp(0, 0.6, (wIs * isComponent + wSlope * slopePenalty) / total);
}

export function optimizePortfolio(input: PortfolioInput): OptimizerResult {
  const { campaigns, subEntities, config: cfg } = input;
  const days = Math.max(1, cfg.windowDays);
  const kill = cfg.killThresholdPct ?? 0.5;
  const troasStep = cfg.troasStepPct ?? 0.15;
  const notes: string[] = [];
  const actions: CandidateAction[] = [];

  // Daily-unit working state per campaign (budget is daily; cost is windowed).
  interface W extends CampaignInput {
    dailyCost: number;
    dailyValue: number;
    roas: number;
    conf: number;
    mRoas: number;
    deltaCost: number; // accumulated daily deltas applied by the allocator
    deltaValue: number;
  }
  const active = campaigns.filter((c) => (c.status ?? 'ENABLED') === 'ENABLED');
  const W: W[] = active.map((c) => {
    const dailyCost = c.cost / days;
    const dailyValue = c.value_post_rto / days;
    const roas = c.roas_post_rto || blendedRoas(c.cost, c.value_post_rto);
    const conf = clamp(0, 1, cfg.minDataConv > 0 ? c.conversions / cfg.minDataConv : 1);
    return { ...c, dailyCost, dailyValue, roas, conf, mRoas: roas * (1 - saturation(c)), deltaCost: 0, deltaValue: 0 };
  });

  const sumCost = () => W.reduce((s, c) => s + c.dailyCost + c.deltaCost, 0);
  const sumValue = () => W.reduce((s, c) => s + c.dailyValue + c.deltaValue, 0);
  const currentBlended = blendedRoas(W.reduce((s, c) => s + c.dailyCost, 0), W.reduce((s, c) => s + c.dailyValue, 0));
  const target = cfg.portfolioTargetRoas;
  const campFloor = cfg.floors.campaign;

  // Partition.
  const frozen = W.filter((c) => c.inLearning || c.conf < 1);
  const eligible = W.filter((c) => !c.inLearning && c.conf >= 1);
  const winners = eligible.filter((c) => c.roas >= target).sort((a, b) => b.mRoas - a.mRoas);
  const losers = eligible.filter((c) => c.roas < campFloor).sort((a, b) => a.roas - b.roas);
  const mids = eligible.filter((c) => c.roas >= campFloor && c.roas < target);

  // Freed daily budget, tracked per customer_id (cross-account reallocation is illegal).
  const freed = new Map<string, number>();
  const addFreed = (cid: string, v: number) => freed.set(cid, (freed.get(cid) ?? 0) + v);

  // ── Step 1: harvest from losers ──────────────────────────────────────────
  for (const c of losers) {
    const catastrophic = c.roas < campFloor * kill || c.value_post_rto <= 0;
    if (catastrophic) {
      // Pause: remove its full daily spend & value.
      actions.push({
        level: 'campaign', customer_id: c.customer_id, entity_id: c.campaign_id, entity_name: c.campaign_name,
        mutate_action: 'pause',
        mutate_payload: { action: 'pause', level: 'campaign', campaign_id: c.campaign_id },
        current: { daily_budget_inr: c.daily_budget_inr, roas_post_rto: round(c.roas) },
        proposed: { status: 0 },
        baseScore: c.dailyCost * (campFloor - c.roas),
        confidence: c.conf,
        expected_impact: { delta_value: -round(c.dailyValue), delta_cost: -round(c.dailyCost) },
        hard_constraints: [`floor.campaign=${campFloor}`],
        reason_codes: ['PAUSE_LOW_ROAS'],
      });
      c.deltaCost -= c.dailyCost; c.deltaValue -= c.dailyValue;
      addFreed(c.customer_id, Math.min(c.dailyCost, c.daily_budget_inr));
    } else {
      // Scale down one capped step.
      const reduceDaily = c.daily_budget_inr * cfg.maxBudgetStepPct;
      const newBudget = round(c.daily_budget_inr * (1 - cfg.maxBudgetStepPct));
      actions.push({
        level: 'campaign', customer_id: c.customer_id, entity_id: c.campaign_id, entity_name: c.campaign_name,
        mutate_action: 'update_budget',
        mutate_payload: { action: 'update_budget', campaign_id: c.campaign_id, daily_budget_inr: newBudget },
        current: { daily_budget_inr: c.daily_budget_inr, roas_post_rto: round(c.roas) },
        proposed: { daily_budget_inr: newBudget },
        baseScore: reduceDaily * (campFloor - c.roas),
        confidence: c.conf,
        expected_impact: { delta_value: -round(reduceDaily * c.roas), delta_cost: -round(reduceDaily) },
        hard_constraints: [`floor.campaign=${campFloor}`, `step<=${cfg.maxBudgetStepPct}`],
        reason_codes: ['SCALE_DOWN'],
      });
      c.deltaCost -= reduceDaily; c.deltaValue -= reduceDaily * c.roas;
      addFreed(c.customer_id, reduceDaily);
    }
  }

  // ── Step 2: pour freed budget into winners (per account), holding the blend ─
  for (const c of winners) {
    const avail = freed.get(c.customer_id) ?? 0;
    if (avail <= 0) continue;
    const grant = Math.min(avail, c.daily_budget_inr * cfg.maxBudgetStepPct);
    if (grant <= 0) continue;
    // Accept only while projected blend stays ≥ target.
    const projected = blendedRoas(sumCost() + grant, sumValue() + grant * c.mRoas);
    if (projected < target) continue;
    const newBudget = round(c.daily_budget_inr + grant);
    actions.push({
      level: 'campaign', customer_id: c.customer_id, entity_id: c.campaign_id, entity_name: c.campaign_name,
      mutate_action: 'update_budget',
      mutate_payload: { action: 'update_budget', campaign_id: c.campaign_id, daily_budget_inr: newBudget },
      current: { daily_budget_inr: c.daily_budget_inr, roas_post_rto: round(c.roas) },
      proposed: { daily_budget_inr: newBudget },
      baseScore: grant * c.mRoas,
      confidence: c.conf,
      expected_impact: { delta_value: round(grant * c.mRoas), delta_cost: round(grant) },
      hard_constraints: [`step<=${cfg.maxBudgetStepPct}`, `blended>=${target}`],
      reason_codes: ['SCALE_UP'],
    });
    c.deltaCost += grant; c.deltaValue += grant * c.mRoas;
    addFreed(c.customer_id, -grant);
  }

  // ── Step 3: if still below target, tighten tROAS on mid-tier value-bidders ─
  const valueBidders = new Set(['TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE']);
  if (blendedRoas(sumCost(), sumValue()) < target) {
    for (const c of mids) {
      if (!c.bidding_strategy_type || !valueBidders.has(c.bidding_strategy_type)) continue;
      const base = c.target_roas && c.target_roas > 0 ? c.target_roas : c.roas;
      const proposed = round(clamp(0.5, 10, base * (1 + troasStep)));
      if (proposed <= round(base)) continue;
      actions.push({
        level: 'campaign', customer_id: c.customer_id, entity_id: c.campaign_id, entity_name: c.campaign_name,
        mutate_action: 'update_campaign_settings',
        mutate_payload: { action: 'update_campaign_settings', campaign_id: c.campaign_id, target_roas: proposed },
        current: { target_roas: round(base), roas_post_rto: round(c.roas) },
        proposed: { target_roas: proposed },
        baseScore: c.dailyCost * (target - c.roas),
        confidence: c.conf,
        expected_impact: { delta_value: 0, delta_cost: 0 },
        hard_constraints: [`troas in [0.5,10]`, `step<=${troasStep}`],
        reason_codes: ['TIGHTEN_TROAS'],
      });
    }
  }

  // ── Step 4: monitor-only rows for frozen / low-confidence campaigns ────────
  for (const c of frozen) {
    actions.push({
      level: 'campaign', customer_id: c.customer_id, entity_id: c.campaign_id, entity_name: c.campaign_name,
      mutate_action: 'monitor',
      mutate_payload: { action: 'monitor' },
      current: { daily_budget_inr: c.daily_budget_inr, roas_post_rto: round(c.roas) },
      proposed: {},
      baseScore: 0,
      confidence: c.conf,
      expected_impact: { delta_value: 0, delta_cost: 0 },
      hard_constraints: [],
      reason_codes: [c.inLearning ? 'MONITOR_LEARNING' : 'MONITOR_LOW_CONF'],
    });
  }

  // ── Step 5: sub-entity cleanups (never budget moves; pre-RTO × parent ratio)
  for (const s of subEntities) {
    if (s.parentInLearning) continue;
    const conf = clamp(0, 1, cfg.minDataConv > 0 ? s.conversions / cfg.minDataConv : 1);
    if (conf < 1) continue;
    if (s.level === 'asset_group') {
      const weak = (s.ad_strength === 'POOR' || s.ad_strength === 'AVERAGE') && s.roas_pre_rto < cfg.floors.asset_group;
      if (!weak || !s.asset_group_id) continue;
      actions.push(subPause('asset_group', s, conf, cfg.floors.asset_group, 'PAUSE_ASSET_GROUP',
        { action: 'pause', level: 'asset_group', asset_group_id: s.asset_group_id }));
    } else if (s.level === 'keyword') {
      if (s.roas_pre_rto >= cfg.floors.keyword || !s.ad_group_id || !s.criterion_id) continue;
      actions.push(subPause('keyword', s, conf, cfg.floors.keyword, 'EXCLUDE_KW',
        { action: 'pause', level: 'keyword', ad_group_id: s.ad_group_id, criterion_id: s.criterion_id }));
    } else if (s.level === 'ad') {
      if (s.roas_pre_rto >= cfg.floors.ad || !s.ad_group_id || !s.ad_id) continue;
      actions.push(subPause('ad', s, conf, cfg.floors.ad, 'PAUSE_POOR_AD',
        { action: 'pause', level: 'ad', ad_group_id: s.ad_group_id, ad_id: s.ad_id }));
    }
  }

  const projectedBlended = blendedRoas(sumCost(), sumValue());
  const targetReachable = projectedBlended >= target;
  if (!targetReachable) {
    notes.push(`Portfolio target ${target}x not reachable without scale loss — projected ${round(projectedBlended)}x. Human review recommended.`);
  }
  if (W.length === 0) notes.push('No active campaigns with data in window.');

  return {
    actions,
    currentBlendedRoas: round(currentBlended),
    projectedBlendedRoas: round(projectedBlended),
    targetReachable,
    notes,
  };
}

function subPause(
  level: 'asset_group' | 'keyword' | 'ad',
  s: SubEntityInput,
  conf: number,
  floor: number,
  reason: string,
  payload: Record<string, unknown>
): CandidateAction {
  return {
    level,
    customer_id: s.customer_id,
    entity_id: s.entity_id,
    entity_name: s.entity_name,
    mutate_action: 'pause',
    mutate_payload: payload,
    current: { roas_pre_rto: round(s.roas_pre_rto), cost: round(s.cost) },
    proposed: { status: 0 },
    baseScore: s.cost * Math.max(0, floor - s.roas_pre_rto),
    confidence: conf,
    expected_impact: { delta_value: 0, delta_cost: 0 },
    hard_constraints: [`floor.${level}=${floor}`],
    reason_codes: [reason],
  };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
