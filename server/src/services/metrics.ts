/**
 * Metric derivations.
 *
 * Cost is always from Google Ads API. Conversions / conversion value can come from
 * Google Ads (default in v1) or — when RTO mode = 'redshift' — from the Redshift funnel.
 * Either way, post-RTO ROAS = (post-RTO conversion value) / cost.
 *
 * In flat-factor mode: post-RTO value = google_value × (1 - rto_factor).
 * In redshift mode: post-RTO value comes directly from Redshift (no further adjustment).
 */

const MICROS = 1_000_000;

export interface RawMetrics {
  cost_micros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversions_value: number;
  view_through_conversions?: number;
}

export interface DerivedMetrics extends RawMetrics {
  cost: number;
  ctr: number;          // clicks / impressions
  cpc: number;          // cost / clicks
  cpm: number;          // cost / impressions × 1000
  cpa: number;          // cost / conversions
  roas_pre_rto: number; // conversions_value / cost
  // Post-RTO fields populated by applyRto()
  conversions_value_post_rto: number;
  roas_post_rto: number;
}

export function deriveMetrics(raw: RawMetrics): DerivedMetrics {
  const cost = raw.cost_micros / MICROS;
  const ctr = raw.impressions ? raw.clicks / raw.impressions : 0;
  const cpc = raw.clicks ? cost / raw.clicks : 0;
  const cpm = raw.impressions ? (cost / raw.impressions) * 1000 : 0;
  const cpa = raw.conversions ? cost / raw.conversions : 0;
  const roas_pre_rto = cost ? raw.conversions_value / cost : 0;
  return {
    ...raw,
    cost,
    ctr,
    cpc,
    cpm,
    cpa,
    roas_pre_rto,
    conversions_value_post_rto: raw.conversions_value,
    roas_post_rto: roas_pre_rto,
  };
}

export function applyFlatRto(m: DerivedMetrics, rtoFactor: number): DerivedMetrics {
  const factor = Math.max(0, Math.min(1, rtoFactor));
  const post = m.conversions_value * (1 - factor);
  return {
    ...m,
    conversions_value_post_rto: post,
    roas_post_rto: m.cost ? post / m.cost : 0,
  };
}

export function emptyRaw(): RawMetrics {
  return {
    cost_micros: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversions_value: 0,
    view_through_conversions: 0,
  };
}

export function addRaw(a: RawMetrics, b: RawMetrics): RawMetrics {
  return {
    cost_micros: a.cost_micros + b.cost_micros,
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    conversions: a.conversions + b.conversions,
    conversions_value: a.conversions_value + b.conversions_value,
    view_through_conversions: (a.view_through_conversions ?? 0) + (b.view_through_conversions ?? 0),
  };
}

/** Parse Google Ads API metric strings (cost_micros is a string, conversions is a number). */
export function parseRawFromGoogle(metrics: Record<string, unknown>): RawMetrics {
  const num = (v: unknown): number => {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Number(v) || 0;
    return 0;
  };
  return {
    cost_micros: num(metrics.costMicros),
    impressions: num(metrics.impressions),
    clicks: num(metrics.clicks),
    conversions: num(metrics.conversions),
    conversions_value: num(metrics.conversionsValue),
    view_through_conversions: num(metrics.viewThroughConversions),
  };
}
