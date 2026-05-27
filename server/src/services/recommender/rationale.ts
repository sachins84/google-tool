/**
 * Deterministic plain-English rationale for a candidate action. No LLM — every
 * line is generated from the action's reason codes + before/after numbers, so
 * it's testable and never fabricates anything beyond the data.
 */
import type { CandidateAction } from './optimizer.js';

const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;
const diag = (a: CandidateAction): string => (a.diagnosis ? ` ${a.diagnosis}` : '');
const x = (n: number): string => `${(Math.round(n * 100) / 100).toFixed(2)}x`;
const pct = (a: number, b: number): string => (b ? `${Math.round(((a - b) / b) * 100)}%` : '0%');

export function buildRationale(a: CandidateAction, portfolioTarget: number): string {
  const code = a.reason_codes[0] ?? 'MONITOR';
  const cur = a.current;
  const prop = a.proposed;
  const conf = `${Math.round(a.confidence * 100)}% conf`;

  switch (code) {
    case 'SCALE_UP': {
      const from = cur.daily_budget_inr ?? 0;
      const to = prop.daily_budget_inr ?? from;
      return `Scale budget +${pct(to, from)} (${inr(from)}→${inr(to)}/day): post-RTO ROAS ${x(cur.roas_post_rto ?? 0)} is above the ${x(portfolioTarget)} portfolio target with headroom; redeploying freed budget here lifts blended value (${conf}).${diag(a)}`;
    }
    case 'SCALE_DOWN': {
      const from = cur.daily_budget_inr ?? 0;
      const to = prop.daily_budget_inr ?? from;
      return `Trim budget ${pct(to, from)} (${inr(from)}→${inr(to)}/day): post-RTO ROAS ${x(cur.roas_post_rto ?? 0)} is below the campaign floor; capped at one step to protect Google's learning (${conf}).${diag(a)}`;
    }
    case 'PAUSE_LOW_ROAS':
      return `Pause: post-RTO ROAS ${x(cur.roas_post_rto ?? 0)} is far below the campaign floor and not recoverable by trimming; freed budget redeploys to winners (${conf}).${diag(a)}`;
    case 'REVIEW_CREATIVE':
      return `Flag for review (creative/relevance): ${a.diagnosis ?? 'CTR is well below the portfolio median'} Budget cuts won't fix this — needs new/stronger creative. Routed to a human (no auto-change).`;
    case 'REVIEW_LANDING':
      return `Flag for review (landing/offer): ${a.diagnosis ?? 'CVR trails the portfolio median'} Not a bid lever — check the landing page/offer. Routed to a human (no auto-change).`;
    case 'TIGHTEN_TROAS': {
      const from = cur.target_roas ?? 0;
      const to = prop.target_roas ?? from;
      return `Raise target ROAS ${x(from)}→${x(to)}: portfolio is below the ${x(portfolioTarget)} target, so push Google to spend this mid-tier campaign more efficiently rather than cutting volume (${conf}).`;
    }
    case 'EXCLUDE_KW':
      return `Pause keyword: post-RTO-adjusted ROAS ${x(cur.roas_pre_rto ?? 0)} is below the keyword floor over the window with ${inr(cur.cost ?? 0)} spend (${conf}).`;
    case 'PAUSE_ASSET_GROUP':
      return `Pause asset group: ad strength is weak and post-RTO-adjusted ROAS ${x(cur.roas_pre_rto ?? 0)} is below the asset-group floor; spend is better served by stronger groups (${conf}).`;
    case 'PAUSE_POOR_AD':
      return `Pause ad: post-RTO-adjusted ROAS ${x(cur.roas_pre_rto ?? 0)} is below the ad floor with ${inr(cur.cost ?? 0)} spend (${conf}).`;
    case 'MONITOR_LEARNING':
      return `No change — campaign is in its learning phase or was recently edited; touching it now would reset Google's algorithm. Monitoring.`;
    case 'MONITOR_LOW_CONF':
      return `No change — not enough conversions in the window to act on confidently. Monitoring until data accrues.`;
    default:
      return `Monitoring; no action recommended.`;
  }
}
