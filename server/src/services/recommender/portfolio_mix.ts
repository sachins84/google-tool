/**
 * Channel-level capital allocator. Pure, deterministic — no I/O.
 *
 * Given current channel-level state (spend, value, IS-headroom) for a brand,
 * recommends a new spend MIX (% share per channel) by ranking each channel's
 * effective marginal ROAS and moving share toward the score-proportional target,
 * bounded by:
 *   - per-channel share floor / cap (light diversification + funnel protection)
 *   - ±max_step_pct of share per channel per run (Google-algo stability)
 *   - the blended DIRECT ROAS must not drop below the portfolio target
 *
 * Halo coefficients (cross-channel uplift, e.g. DG → SEARCH) are wired but
 * default to 0: effective_roas = direct_roas × (1 + halo_bonus). When a brand
 * sets non-zero halo via a rule, top-funnel channels look better in the mix
 * ranking — but the blended-ROAS safety check still uses DIRECT ROAS, never
 * halo-inflated, so we never blow up real efficiency on theoretical lift.
 *
 * This is the STRATEGIC layer. Execution still happens through the per-campaign
 * optimizer + the existing dry-run/approve/audit pipeline; the mix panel is
 * informational guidance on which channel should absorb the next ±₹.
 */

const clamp = (lo: number, hi: number, x: number): number => Math.max(lo, Math.min(hi, x));

export interface ChannelState {
  channel: string;           // SEARCH | PERFORMANCE_MAX | SHOPPING | DEMAND_GEN | VIDEO | ...
  spend: number;             // daily ₹ (cost / windowDays)
  value: number;             // daily ₹ (post-RTO value / windowDays)
  direct_roas: number;       // value / spend
  lost_is_budget: number | null;
  halo_bonus: number;        // 0 by default
}

export interface MixConfig {
  portfolioTargetRoas: number;
  shareFloor: Record<string, number>; // min share per channel (e.g. SEARCH=0.05)
  shareCap: Record<string, number>;   // max share per channel (default 0.70)
  maxStepPct: number;                 // ±share step per run (default 0.15)
}

export interface ChannelMixRecommendation {
  channel: string;
  current_share: number;
  current_spend: number;
  current_value: number;
  direct_roas: number;
  halo_bonus: number;
  effective_roas: number;
  marginal_effective_roas: number;
  recommended_share: number;
  delta_share: number;       // recommended - current
  delta_spend: number;       // daily ₹
  rationale: string;
}

export interface MixResult {
  channels: ChannelMixRecommendation[];
  current_blended_direct_roas: number;
  projected_blended_direct_roas: number;
  total_daily_spend: number;
  total_daily_value: number;
  target_reachable: boolean;
  notes: string[];
}

/** Saturation penalty β ∈ [0, 0.6] from IS-budget-lost headroom.
 *  High lost-IS-to-budget ⇒ low β (cheap to scale). PMax/Video/DG have no
 *  Search IS — fall back to a neutral 0.3. */
function saturationBeta(c: ChannelState): number {
  if (c.lost_is_budget == null) return 0.3;
  const lost = clamp(0, 1, c.lost_is_budget);
  return clamp(0, 0.6, 0.5 * (1 - lost));
}

export function recommendMix(channels: ChannelState[], cfg: MixConfig): MixResult {
  const notes: string[] = [];
  const total_daily_spend = channels.reduce((s, c) => s + c.spend, 0);
  const total_daily_value = channels.reduce((s, c) => s + c.value, 0);
  const current_blended = total_daily_spend > 0 ? total_daily_value / total_daily_spend : 0;

  if (total_daily_spend <= 0) {
    return { channels: [], current_blended_direct_roas: 0, projected_blended_direct_roas: 0, total_daily_spend: 0, total_daily_value: 0, target_reachable: false, notes: ['No spend in window — nothing to allocate.'] };
  }

  // Per-channel computed signals.
  const enriched = channels.map((c) => {
    const share = c.spend / total_daily_spend;
    const beta = saturationBeta(c);
    const marg_direct = c.direct_roas * (1 - beta);
    const effective_roas = c.direct_roas * (1 + c.halo_bonus);
    const marg_eff = marg_direct * (1 + c.halo_bonus);
    return { ...c, share, beta, marg_direct, effective_roas, marg_eff };
  });

  // Score-proportional target share (after clamping to share floor/cap, renormalised).
  const score = (e: typeof enriched[number]): number => Math.max(0, e.marg_eff);
  const totalScore = enriched.reduce((s, e) => s + score(e), 0);
  const raw: Map<string, number> = new Map();
  for (const e of enriched) raw.set(e.channel, totalScore > 0 ? score(e) / totalScore : e.share);
  // Clamp each to [floor, cap]
  for (const [k, v] of raw) {
    const fl = cfg.shareFloor[k] ?? 0;
    const cap = cfg.shareCap[k] ?? 0.7;
    raw.set(k, clamp(fl, cap, v));
  }
  // Renormalise so shares sum to 1
  const sum = [...raw.values()].reduce((a, b) => a + b, 0);
  if (sum > 0) for (const [k, v] of raw) raw.set(k, v / sum);

  // Step 1: desired share delta per channel (step-cap clamped, donor→receiver).
  const desired = new Map<string, number>();
  for (const e of enriched) {
    const target = raw.get(e.channel) ?? e.share;
    desired.set(e.channel, clamp(-cfg.maxStepPct, cfg.maxStepPct, target - e.share));
  }

  // Step 2: a rebalance has to be budget-neutral (total share stays at 1.0). If
  // donors and receivers don't balance, scale down the larger side proportionally
  // so actual_delta sums to zero.
  let posSum = 0, negSum = 0;
  for (const v of desired.values()) { if (v > 0) posSum += v; else negSum += -v; }
  const transfer = Math.min(posSum, negSum);
  const actual = new Map<string, number>();
  for (const [k, v] of desired) {
    if (v > 0 && posSum > 0)      actual.set(k, v * (transfer / posSum));
    else if (v < 0 && negSum > 0) actual.set(k, v * (transfer / negSum));
    else actual.set(k, 0);
  }

  const recs: ChannelMixRecommendation[] = enriched.map((e) => {
    const step = actual.get(e.channel) ?? 0;
    const recommended_share = e.share + step;
    const delta_spend = recommended_share * total_daily_spend - e.spend;
    let rationale: string;
    if (delta_spend > 0.5) {
      rationale = `Marginal effective ROAS ${e.marg_eff.toFixed(2)}x is above the portfolio score — capacity to absorb ₹${Math.round(delta_spend).toLocaleString('en-IN')}/day more${e.lost_is_budget != null && e.lost_is_budget >= 0.1 ? ` (lost ${(e.lost_is_budget * 100).toFixed(0)}% IS to budget)` : ''}.`;
    } else if (delta_spend < -0.5) {
      rationale = `Marginal effective ROAS ${e.marg_eff.toFixed(2)}x trails the portfolio score — redeploy ₹${Math.round(-delta_spend).toLocaleString('en-IN')}/day to higher-marginal channels.`;
    } else {
      rationale = `At target share (marginal effective ROAS ${e.marg_eff.toFixed(2)}x).`;
    }
    return {
      channel: e.channel,
      current_share: e.share, current_spend: e.spend, current_value: e.value,
      direct_roas: e.direct_roas, halo_bonus: e.halo_bonus,
      effective_roas: e.effective_roas, marginal_effective_roas: e.marg_eff,
      recommended_share, delta_share: step, delta_spend, rationale,
    };
  });

  // Projected blended (DIRECT roas — halo is theoretical, safety check stays empirical).
  let projCost = 0, projValue = 0;
  for (const r of recs) {
    const newSpend = r.current_spend + r.delta_spend;
    projCost += newSpend;
    projValue += newSpend * r.direct_roas;
  }
  const projected_blended = projCost > 0 ? projValue / projCost : 0;
  const target_reachable = projected_blended >= cfg.portfolioTargetRoas;
  if (!target_reachable) notes.push(`Projected blended direct ROAS ${projected_blended.toFixed(2)}x stays below the ${cfg.portfolioTargetRoas.toFixed(2)}x portfolio target — a single mix shift won't get there in one step (cap is ±${(cfg.maxStepPct * 100).toFixed(0)}% per run).`);

  return { channels: recs, current_blended_direct_roas: current_blended, projected_blended_direct_roas: projected_blended, total_daily_spend, total_daily_value, target_reachable, notes };
}
