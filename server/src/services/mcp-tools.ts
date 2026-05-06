/**
 * MCP tool registrations — exposes google-ads-tool data to claude.ai (HTTP) or
 * Claude Desktop (stdio). Read-only for v1; mutations stay in the web UI where
 * the dry-run + audit log workflow is enforced.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/init.js';
import { getAllAccounts } from '../services/mcc-map.js';
import {
  fetchRowsForBrand,
  fetchNetworkSplit,
  tryFetchBrandTotals,
} from '../routes/performance.js';
import { computeDailyInsights, type PerfRowSummary } from './insights.js';

const fmtINR = (n: number): string => '₹' + Math.round(n).toLocaleString('en-IN');
const fmt2 = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(2));

export function registerTools(server: McpServer): void {
  // ── list_brands ────────────────────────────────────────────────────────
  server.tool(
    'list_brands',
    'List all configured brands with their RTO mode, RTO factor, and linked Google Ads customer IDs.',
    {},
    () => {
      const db = getDb();
      const brands = db.prepare('SELECT id, name, rto_factor, rto_mode FROM brands ORDER BY name').all() as Array<{
        id: number; name: string; rto_factor: number; rto_mode: string;
      }>;
      const accounts = db.prepare('SELECT brand_id, customer_id FROM brand_accounts').all() as Array<{
        brand_id: number; customer_id: string;
      }>;
      const byBrand = new Map<number, string[]>();
      for (const a of accounts) {
        if (!byBrand.has(a.brand_id)) byBrand.set(a.brand_id, []);
        byBrand.get(a.brand_id)!.push(a.customer_id);
      }
      const text = brands.map((b) =>
        `- **${b.name}** (id=${b.id}, RTO mode=${b.rto_mode}, factor=${(b.rto_factor * 100).toFixed(0)}%) — ${(byBrand.get(b.id) ?? []).join(', ') || 'no accounts'}`
      ).join('\n') || 'No brands configured.';
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── list_accounts ─────────────────────────────────────────────────────
  server.tool(
    'list_accessible_accounts',
    'List every Google Ads account reachable through the configured OAuth token (direct grants + via the MCC). Useful for adding new brands.',
    {},
    async () => {
      const accounts = await getAllAccounts(false);
      const text = accounts.map((a) =>
        `- ${a.customer_id} ${a.is_manager ? '[MCC]' : '     '} ${a.descriptive_name ?? '(no name)'} (${a.currency_code ?? '?'}, source=${a.source}${a.login_customer_id ? `, login=${a.login_customer_id}` : ''})`
      ).join('\n') || 'No accounts.';
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── get_campaigns ─────────────────────────────────────────────────────
  server.tool(
    'get_campaigns',
    'Get campaign-level performance for a brand within a date range. Includes Google ROAS, post-RTO Calc ROAS, NCs and AOV when Redshift is configured for the brand. Pass compare_from / compare_to to include period-over-period deltas.',
    {
      brand_id: z.number().int().describe('Brand ID from list_brands'),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date YYYY-MM-DD'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End date YYYY-MM-DD'),
      compare_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      compare_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().min(1).max(200).optional().default(40).describe('Max rows, sorted by spend desc. Default 40.'),
    },
    async ({ brand_id, from, to, compare_from, compare_to, limit }) => {
      const primary = await fetchRowsForBrand('campaign', brand_id, from, to);
      if (compare_from && compare_to) {
        const compare = await fetchRowsForBrand('campaign', brand_id, compare_from, compare_to);
        const cmpById = new Map(compare.map((r) => [r.campaign_id ?? '', r]));
        for (const r of primary) {
          const c = cmpById.get(r.campaign_id ?? '');
          if (c) (r as { comparison?: typeof c.metrics }).comparison = c.metrics;
        }
      }
      const sorted = [...primary].sort((a, b) => (b.metrics?.cost ?? 0) - (a.metrics?.cost ?? 0)).slice(0, limit ?? 40);
      const totals = await tryFetchBrandTotals(brand_id, from, to, compare_from, compare_to);

      const lines: string[] = [];
      lines.push(`# ${sorted.length} campaigns (top by spend)`);
      if (totals?.primary) {
        const totalCost = primary.reduce((a, r) => a + (r.metrics?.cost ?? 0), 0);
        const calcRoas = totalCost ? totals.primary.amount / totalCost : 0;
        lines.push(`Brand totals: NCs=${totals.primary.ncs.toLocaleString('en-IN')}, Revenue=${fmtINR(totals.primary.amount)}, Calc ROAS=${fmt2(calcRoas)}`);
      }
      lines.push('');
      lines.push('| Campaign | Type | Status | Spend | Conv | ROAS_G | NCs | Calc ROAS | Δ Spend | Δ ROAS |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|');
      for (const r of sorted) {
        const m = r.metrics ?? {} as PerfRowSummary['metrics'];
        const c = (r as { comparison?: typeof m }).comparison;
        const dSpend = c?.cost ? `${(((m.cost - c.cost) / c.cost) * 100).toFixed(0)}%` : '—';
        const dRoas = c?.roas_post_rto != null ? (m.roas_post_rto - c.roas_post_rto).toFixed(2) : '—';
        lines.push(`| ${r.campaign_name ?? '?'} | ${r.channel_type ?? '?'} | ${r.status ?? '?'} | ${fmtINR(m.cost ?? 0)} | ${(m.conversions ?? 0).toFixed(0)} | ${fmt2(m.roas_pre_rto)} | ${m.ncs ?? '—'} | ${fmt2(m.calc_roas)} | ${dSpend} | ${dRoas} |`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ── get_network_split ─────────────────────────────────────────────────
  server.tool(
    'get_network_split',
    'Spend split by ad network (Search / Display / YouTube / PMax-mixed) for a brand within a date range.',
    {
      brand_id: z.number().int(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    },
    async ({ brand_id, from, to }) => {
      const split = await fetchNetworkSplit(brand_id, from, to);
      const total = split.reduce((a, e) => a + e.cost, 0);
      const text = split.length === 0
        ? 'No spend in this period.'
        : split.map((e) => `- ${e.network}: ${fmtINR(e.cost)} (${total ? ((e.cost / total) * 100).toFixed(0) : 0}%, ${e.clicks.toLocaleString()} clicks, ${e.impressions.toLocaleString()} impr)`).join('\n')
          + `\n\nTotal: ${fmtINR(total)}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── get_daily_insights ────────────────────────────────────────────────
  server.tool(
    'get_daily_insights',
    'Compute rule-based observations (spend jumps/drops, ROAS movements, low-Calc-ROAS burn alerts) for a brand. Requires compare_from/compare_to for movement-based insights.',
    {
      brand_id: z.number().int(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      compare_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      compare_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
    async ({ brand_id, from, to, compare_from, compare_to }) => {
      const primary = await fetchRowsForBrand('campaign', brand_id, from, to);
      if (compare_from && compare_to) {
        const compare = await fetchRowsForBrand('campaign', brand_id, compare_from, compare_to);
        const cmpById = new Map(compare.map((r) => [r.campaign_id ?? '', r]));
        for (const r of primary) {
          const c = cmpById.get(r.campaign_id ?? '');
          if (c) (r as { comparison?: typeof c.metrics }).comparison = c.metrics;
        }
      }
      const insights = computeDailyInsights(primary as unknown as PerfRowSummary[]);
      const text = insights.length === 0
        ? 'No notable movements — performance looks stable in this window.'
        : insights.map((i) => `- [${i.severity.toUpperCase()}] ${i.message}`).join('\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── get_audit_log ─────────────────────────────────────────────────────
  server.tool(
    'get_audit_log',
    'Recent mutations performed via the tool (pause/enable/budget/keyword changes). Includes both DRY runs and LIVE actions.',
    {
      brand_id: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).optional().default(20),
    },
    ({ brand_id, limit }) => {
      const db = getDb();
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (brand_id) { where.push('a.brand_id = ?'); params.push(brand_id); }
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT a.id, u.username, a.action, b.name AS brand_name, a.target_resource,
                a.before_json, a.after_json, a.dry_run, a.created_at
         FROM audit_log a
         LEFT JOIN users u ON a.user_id = u.id
         LEFT JOIN brands b ON a.brand_id = b.id
         ${whereClause}
         ORDER BY a.id DESC LIMIT ?`
      ).all(...params, limit ?? 20) as Array<{
        id: number; username: string | null; action: string; brand_name: string | null;
        target_resource: string | null; before_json: string | null; after_json: string | null;
        dry_run: number; created_at: number;
      }>;
      const text = rows.length === 0 ? 'No audit entries.' : rows.map((r) => {
        const when = new Date(r.created_at * 1000).toISOString();
        const flag = r.dry_run === 1 ? '[DRY]' : '[LIVE]';
        const before = r.before_json ? ` before=${r.before_json}` : '';
        const after = r.after_json ? ` after=${r.after_json}` : '';
        return `${when} ${flag} ${r.username ?? '—'} ${r.action} brand=${r.brand_name ?? '—'} target=${r.target_resource ?? '—'}${before}${after}`;
      }).join('\n');
      return { content: [{ type: 'text', text }] };
    }
  );
}
