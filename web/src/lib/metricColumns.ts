/**
 * Metric column registry — single source of truth for which metric columns
 * are available in the MetricsTable and how each one renders.
 *
 * Each column references a field on DerivedMetrics. Columns can be marked as:
 *   - default: visible out of the box
 *   - calcOnly: only shown when the row has Redshift-sourced calc metrics
 *   - searchOnly: only shown for Search/Shopping channels (impression share)
 */

import type { DerivedMetrics } from './api';

export type DeltaKind = 'pct' | 'absolute';
export type BetterIs = 'higher' | 'lower' | 'neutral';
export type Fmt = 'INR' | 'NUM' | 'NUM0' | 'PCT' | 'MUL';

export interface MetricColumn {
  key: keyof DerivedMetrics;
  label: string;
  longLabel?: string; // shown as tooltip on header
  fmt: Fmt;
  betterIs: BetterIs;
  deltaKind: DeltaKind;
  default?: boolean;
  nullable?: boolean;  // null = not joined, render —
  bold?: boolean;
  calcOnly?: boolean;  // only show when showCalcMetrics
  searchOnly?: boolean; // hint to users: relevant for Search/Shopping
  group: 'core' | 'efficiency' | 'conversions' | 'visibility' | 'engagement' | 'calc';
}

export const METRIC_COLUMNS: MetricColumn[] = [
  // ── Core spend/traffic ───────────────────────────────────────────────────
  { key: 'cost', label: 'Spend', fmt: 'INR', betterIs: 'lower', deltaKind: 'pct', default: true, group: 'core' },
  { key: 'impressions', label: 'Impr', fmt: 'NUM', betterIs: 'neutral', deltaKind: 'pct', default: true, group: 'core' },
  { key: 'clicks', label: 'Clicks', fmt: 'NUM', betterIs: 'higher', deltaKind: 'pct', default: true, group: 'core' },

  // ── Efficiency ratios ────────────────────────────────────────────────────
  { key: 'ctr', label: 'CTR', fmt: 'PCT', betterIs: 'higher', deltaKind: 'absolute', default: true, group: 'efficiency' },
  { key: 'cpc', label: 'CPC', fmt: 'INR', betterIs: 'lower', deltaKind: 'pct', default: true, group: 'efficiency' },
  { key: 'cpm', label: 'CPM', fmt: 'INR', betterIs: 'lower', deltaKind: 'pct', default: true, group: 'efficiency' },
  { key: 'conversion_rate', label: 'Conv rate', longLabel: 'conversions / clicks', fmt: 'PCT', betterIs: 'higher', deltaKind: 'absolute', group: 'efficiency' },

  // ── Conversions ──────────────────────────────────────────────────────────
  { key: 'conversions', label: 'Conv', fmt: 'NUM0', betterIs: 'higher', deltaKind: 'pct', default: true, group: 'conversions' },
  { key: 'cpa', label: 'CPA', fmt: 'INR', betterIs: 'lower', deltaKind: 'pct', default: true, group: 'conversions' },
  { key: 'roas_pre_rto', label: 'ROAS (G)', longLabel: 'Google ROAS = conversion value / cost (pre-RTO)', fmt: 'MUL', betterIs: 'higher', deltaKind: 'absolute', default: true, bold: true, group: 'conversions' },
  { key: 'conversions_value', label: 'Conv value', fmt: 'INR', betterIs: 'higher', deltaKind: 'pct', group: 'conversions' },
  { key: 'view_through_conversions', label: 'View-thru', longLabel: 'View-through conversions', fmt: 'NUM0', betterIs: 'higher', deltaKind: 'pct', group: 'conversions' },
  { key: 'all_conversions', label: 'All conv', longLabel: 'All Google conversions (including non-goal)', fmt: 'NUM0', betterIs: 'higher', deltaKind: 'pct', group: 'conversions' },
  { key: 'all_conversions_value', label: 'All conv value', fmt: 'INR', betterIs: 'higher', deltaKind: 'pct', group: 'conversions' },
  { key: 'cpa_all', label: 'CPA (all)', longLabel: 'cost / all_conversions', fmt: 'INR', betterIs: 'lower', deltaKind: 'pct', group: 'conversions' },
  { key: 'roas_all', label: 'ROAS (all)', longLabel: 'all_conversions_value / cost', fmt: 'MUL', betterIs: 'higher', deltaKind: 'absolute', group: 'conversions' },
  { key: 'cross_device_conversions', label: 'Cross-device', longLabel: 'Cross-device conversions', fmt: 'NUM0', betterIs: 'higher', deltaKind: 'pct', group: 'conversions' },

  // ── Visibility / impression share (Search & Shopping) ────────────────────
  { key: 'search_impression_share', label: 'Search IS', longLabel: 'Search Impression Share', fmt: 'PCT', betterIs: 'higher', deltaKind: 'absolute', searchOnly: true, group: 'visibility' },
  { key: 'search_top_impression_share', label: 'Top IS', longLabel: 'Search Top Impression Share', fmt: 'PCT', betterIs: 'higher', deltaKind: 'absolute', searchOnly: true, group: 'visibility' },
  { key: 'search_absolute_top_impression_share', label: 'Abs top IS', longLabel: 'Search Absolute Top Impression Share', fmt: 'PCT', betterIs: 'higher', deltaKind: 'absolute', searchOnly: true, group: 'visibility' },
  { key: 'search_budget_lost_impression_share', label: 'Lost IS (budget)', longLabel: 'Search Lost IS due to Budget', fmt: 'PCT', betterIs: 'lower', deltaKind: 'absolute', searchOnly: true, group: 'visibility' },
  { key: 'search_rank_lost_impression_share', label: 'Lost IS (rank)', longLabel: 'Search Lost IS due to Ad Rank', fmt: 'PCT', betterIs: 'lower', deltaKind: 'absolute', searchOnly: true, group: 'visibility' },
  { key: 'absolute_top_impression_percentage', label: 'Abs top %', longLabel: 'Share of your impressions at the absolute top', fmt: 'PCT', betterIs: 'higher', deltaKind: 'absolute', group: 'visibility' },
  { key: 'top_impression_percentage', label: 'Top %', longLabel: 'Share of your impressions at top of page', fmt: 'PCT', betterIs: 'higher', deltaKind: 'absolute', group: 'visibility' },

  // ── Engagement / video ───────────────────────────────────────────────────
  { key: 'engagements', label: 'Engagements', fmt: 'NUM', betterIs: 'higher', deltaKind: 'pct', group: 'engagement' },
  { key: 'engagement_rate', label: 'Engagement rate', fmt: 'PCT', betterIs: 'higher', deltaKind: 'absolute', group: 'engagement' },
  { key: 'video_views', label: 'Video views', fmt: 'NUM', betterIs: 'higher', deltaKind: 'pct', group: 'engagement' },
  { key: 'average_cpv', label: 'Avg CPV', longLabel: 'Average cost per view (video)', fmt: 'INR', betterIs: 'lower', deltaKind: 'pct', group: 'engagement' },

  // ── Calc / Redshift (NC funnel) ──────────────────────────────────────────
  { key: 'ncs', label: 'NCs', longLabel: 'New customers (post-RTO from Redshift funnel)', fmt: 'NUM0', betterIs: 'higher', deltaKind: 'pct', calcOnly: true, nullable: true, default: true, group: 'calc' },
  { key: 'aov', label: 'AOV', fmt: 'INR', betterIs: 'higher', deltaKind: 'pct', calcOnly: true, nullable: true, default: true, group: 'calc' },
  { key: 'calc_cpa', label: 'Calc CPA', longLabel: 'cost / NCs', fmt: 'INR', betterIs: 'lower', deltaKind: 'pct', calcOnly: true, nullable: true, default: true, group: 'calc' },
  { key: 'calc_roas', label: 'Calc ROAS', longLabel: 'NC revenue / cost (post-RTO)', fmt: 'MUL', betterIs: 'higher', deltaKind: 'absolute', calcOnly: true, nullable: true, default: true, bold: true, group: 'calc' },
];

export const GROUP_LABELS: Record<MetricColumn['group'], string> = {
  core: 'Core',
  efficiency: 'Efficiency',
  conversions: 'Conversions',
  visibility: 'Visibility (Search/Shopping)',
  engagement: 'Engagement / Video',
  calc: 'Calc (Redshift NCs)',
};

export function defaultVisibleSet(): Set<string> {
  return new Set(METRIC_COLUMNS.filter((c) => c.default).map((c) => c.key as string));
}

const STORAGE_PREFIX = 'mw-google.metrics.';

export function loadVisibleMetrics(level: string): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + level);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch { /* ignore */ }
  return defaultVisibleSet();
}

export function saveVisibleMetrics(level: string, visible: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + level, JSON.stringify(Array.from(visible)));
  } catch { /* ignore */ }
}
