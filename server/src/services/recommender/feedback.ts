/**
 * Feedback-driven learning. Every accept / reject / override updates an EWMA
 * acceptance rate for the reason code's governing rule, which moves that rule's
 * live `weight`. The next run's "engine" ranking multiplies base scores by these
 * weights — so the engine column drifts toward what the manager actually approves.
 *
 * Hard floors/caps are NEVER relaxed by feedback: weight only changes RANKING,
 * not the floor value the optimizer enforces.
 */
import { getDb } from '../../db/init.js';

const ALPHA = 0.2; // EWMA responsiveness
const W_MIN = 0.4;
const W_MAX = 1.5;

/** reason_code → the rule (kind, scope) whose weight it should move. */
const REASON_GOVERNING_RULE: Record<string, { kind: string; scope: string } | null> = {
  SCALE_UP: { kind: 'floor', scope: 'campaign' },
  SCALE_DOWN: { kind: 'floor', scope: 'campaign' },
  PAUSE_LOW_ROAS: { kind: 'floor', scope: 'campaign' },
  TIGHTEN_TROAS: { kind: 'preference', scope: 'portfolio' },
  EXCLUDE_KW: { kind: 'floor', scope: 'keyword' },
  PAUSE_ASSET_GROUP: { kind: 'floor', scope: 'asset_group' },
  PAUSE_POOR_AD: { kind: 'floor', scope: 'ad' },
  MONITOR_LEARNING: null,
  MONITOR_LOW_CONF: null,
};

function governingRuleId(brandId: number, reasonCode: string): number | null {
  const g = REASON_GOVERNING_RULE[reasonCode];
  if (!g) return null;
  const row = getDb()
    .prepare(`SELECT id FROM rules WHERE brand_id = ? AND kind = ? AND scope_level = ? ORDER BY origin='default' DESC LIMIT 1`)
    .get(brandId, g.kind, g.scope) as { id: number } | undefined;
  return row?.id ?? null;
}

const weightFromEwma = (ewma: number): number => Math.max(W_MIN, Math.min(W_MAX, 0.5 + ewma));

/** Live ranking multiplier for a reason code (1.0 if no learning yet). */
export function engineMultiplier(brandId: number, reasonCode: string): number {
  const ruleId = governingRuleId(brandId, reasonCode);
  if (ruleId == null) return 1.0;
  const row = getDb()
    .prepare('SELECT ewma_acceptance FROM rule_weight_state WHERE rule_id = ? AND reason_code = ?')
    .get(ruleId, reasonCode) as { ewma_acceptance: number } | undefined;
  if (!row) return 1.0;
  return weightFromEwma(row.ewma_acceptance);
}

/** Record a decision and move the EWMA + governing rule weight. */
export function applyFeedbackLearning(
  brandId: number,
  reasonCodes: string[],
  decision: 'accepted' | 'rejected' | 'overridden'
): void {
  const observed = decision === 'accepted' ? 1 : decision === 'overridden' ? 0.5 : 0;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  for (const code of reasonCodes) {
    const ruleId = governingRuleId(brandId, code);
    if (ruleId == null) continue;

    const prev = db
      .prepare('SELECT accepts, rejects, overrides, ewma_acceptance FROM rule_weight_state WHERE rule_id = ? AND reason_code = ?')
      .get(ruleId, code) as { accepts: number; rejects: number; overrides: number; ewma_acceptance: number } | undefined;

    const ewma = prev ? ALPHA * observed + (1 - ALPHA) * prev.ewma_acceptance : ALPHA * observed + (1 - ALPHA) * 0.5;
    const accepts = (prev?.accepts ?? 0) + (decision === 'accepted' ? 1 : 0);
    const rejects = (prev?.rejects ?? 0) + (decision === 'rejected' ? 1 : 0);
    const overrides = (prev?.overrides ?? 0) + (decision === 'overridden' ? 1 : 0);

    db.prepare(
      `INSERT INTO rule_weight_state (rule_id, reason_code, accepts, rejects, overrides, ewma_acceptance, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(rule_id, reason_code) DO UPDATE SET
         accepts = excluded.accepts, rejects = excluded.rejects, overrides = excluded.overrides,
         ewma_acceptance = excluded.ewma_acceptance, last_updated = excluded.last_updated`
    ).run(ruleId, code, accepts, rejects, overrides, ewma, now);

    // Reflect the learned weight on the rule itself (visible in the Rules panel).
    // is_hard rules keep their floor value; only the ranking weight moves.
    db.prepare('UPDATE rules SET weight = ? WHERE id = ?').run(weightFromEwma(ewma), ruleId);
  }
}
