/**
 * Insights service — two layers:
 *
 *   1. Daily insights: deterministic rules computed from yesterday vs prior day
 *      (biggest movers, ROAS outliers, budget cap risks). No LLM required.
 *   2. Q&A: free-form question answered by Claude with the brand's recent
 *      performance summary as context.
 */

import { config } from '../config.js';
import type { DerivedMetrics } from './metrics.js';

// ---------- Daily insights (rule-based) ----------

export interface PerfRowSummary {
  campaign_id?: string;
  campaign_name?: string;
  channel_type?: string;
  status?: string;
  metrics: DerivedMetrics;
  comparison?: DerivedMetrics;
}

export interface DailyInsight {
  kind: 'spend_jump' | 'spend_drop' | 'roas_drop' | 'roas_lift' | 'low_calc_roas' | 'paused_recently_active';
  severity: 'high' | 'medium' | 'low';
  message: string;
  campaign_name?: string;
  detail: Record<string, unknown>;
}

export function computeDailyInsights(rows: PerfRowSummary[]): DailyInsight[] {
  const out: DailyInsight[] = [];
  const fmtINR = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

  for (const r of rows) {
    if (!r.comparison || !r.metrics) continue;
    const cur = r.metrics, prev = r.comparison;
    if (cur.cost < 5000) continue; // ignore tiny campaigns

    const spendDelta = prev.cost ? (cur.cost - prev.cost) / prev.cost : 0;
    const roasDelta = (cur.roas_post_rto ?? 0) - (prev.roas_post_rto ?? 0);

    if (spendDelta > 0.5 && cur.cost > 50000) {
      out.push({
        kind: 'spend_jump',
        severity: spendDelta > 1 ? 'high' : 'medium',
        message: `${r.campaign_name} spend up ${(spendDelta * 100).toFixed(0)}% to ${fmtINR(cur.cost)} — ROAS ${cur.roas_post_rto.toFixed(2)} (${roasDelta >= 0 ? '+' : ''}${roasDelta.toFixed(2)} vs prev)`,
        campaign_name: r.campaign_name,
        detail: { current_cost: cur.cost, prev_cost: prev.cost, roas_post_rto: cur.roas_post_rto },
      });
    } else if (spendDelta < -0.5 && prev.cost > 50000) {
      out.push({
        kind: 'spend_drop',
        severity: 'medium',
        message: `${r.campaign_name} spend down ${Math.abs(spendDelta * 100).toFixed(0)}% to ${fmtINR(cur.cost)}`,
        campaign_name: r.campaign_name,
        detail: { current_cost: cur.cost, prev_cost: prev.cost },
      });
    }

    if (cur.calc_roas != null && prev.calc_roas != null) {
      const calcDelta = cur.calc_roas - prev.calc_roas;
      if (calcDelta < -0.5 && prev.calc_roas > 1) {
        out.push({
          kind: 'roas_drop',
          severity: 'high',
          message: `${r.campaign_name} Calc ROAS dropped ${prev.calc_roas.toFixed(2)} → ${cur.calc_roas.toFixed(2)} (spend ${fmtINR(cur.cost)})`,
          campaign_name: r.campaign_name,
          detail: { current_roas: cur.calc_roas, prev_roas: prev.calc_roas },
        });
      } else if (calcDelta > 0.5 && cur.calc_roas > 2) {
        out.push({
          kind: 'roas_lift',
          severity: 'low',
          message: `${r.campaign_name} Calc ROAS rose ${prev.calc_roas.toFixed(2)} → ${cur.calc_roas.toFixed(2)} — strong performer`,
          campaign_name: r.campaign_name,
          detail: { current_roas: cur.calc_roas, prev_roas: prev.calc_roas },
        });
      }
    }

    if (cur.calc_roas != null && cur.calc_roas < 0.5 && cur.cost > 30000) {
      out.push({
        kind: 'low_calc_roas',
        severity: 'high',
        message: `${r.campaign_name} burning ${fmtINR(cur.cost)} at Calc ROAS ${cur.calc_roas.toFixed(2)} — review or pause`,
        campaign_name: r.campaign_name,
        detail: { calc_roas: cur.calc_roas, cost: cur.cost },
      });
    }
  }

  // Order by severity, then by absolute spend impact
  const sevRank: Record<DailyInsight['severity'], number> = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => {
    const sev = sevRank[a.severity] - sevRank[b.severity];
    if (sev !== 0) return sev;
    return Number(b.detail.cost ?? b.detail.current_cost ?? 0) - Number(a.detail.cost ?? a.detail.current_cost ?? 0);
  });

  return out.slice(0, 8);
}

// ---------- Q&A (Claude-powered) ----------

interface ClaudeMessage { role: 'user' | 'assistant'; content: string; }

export async function askClaude(systemPrompt: string, messages: ClaudeMessage[]): Promise<string> {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured — Insights Q&A requires this in .env');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
  }
  const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = body.content?.find((c) => c.type === 'text')?.text ?? '';
  return text.trim();
}

export function buildAnalysisContext(rows: PerfRowSummary[], brandTotals?: { ncs: number; amount: number }): string {
  // Compress rows into a markdown table the LLM can read efficiently.
  const totalSpend = rows.reduce((a, r) => a + r.metrics.cost, 0);
  const topRows = rows
    .filter((r) => r.metrics.cost > 1000)
    .sort((a, b) => b.metrics.cost - a.metrics.cost)
    .slice(0, 25);

  const lines: string[] = [];
  lines.push(`# Performance summary`);
  lines.push(`Total spend: ₹${Math.round(totalSpend).toLocaleString('en-IN')}`);
  if (brandTotals) {
    const calcRoas = totalSpend ? brandTotals.amount / totalSpend : 0;
    lines.push(`NCs (post-RTO): ${brandTotals.ncs.toLocaleString('en-IN')} | Revenue: ₹${Math.round(brandTotals.amount).toLocaleString('en-IN')} | Calc ROAS: ${calcRoas.toFixed(2)}`);
  }
  lines.push('');
  lines.push('| Campaign | Type | Status | Spend | Conv | ROAS_G | NCs | Calc ROAS | Δ Spend | Δ ROAS |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of topRows) {
    const m = r.metrics, c = r.comparison;
    const dSpend = c?.cost ? (((m.cost - c.cost) / c.cost) * 100).toFixed(0) + '%' : '—';
    const dRoas = c?.roas_post_rto != null ? (m.roas_post_rto - c.roas_post_rto).toFixed(2) : '—';
    lines.push(`| ${r.campaign_name ?? '?'} | ${r.channel_type ?? '?'} | ${r.status ?? '?'} | ₹${Math.round(m.cost).toLocaleString('en-IN')} | ${m.conversions.toFixed(0)} | ${m.roas_pre_rto.toFixed(2)} | ${m.ncs ?? '—'} | ${m.calc_roas?.toFixed(2) ?? '—'} | ${dSpend} | ${dRoas} |`);
  }
  return lines.join('\n');
}
