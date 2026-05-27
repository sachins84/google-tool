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
  // ── Extended metrics (may be 0 if the view doesn't expose them) ─────────────
  all_conversions?: number;
  all_conversions_value?: number;
  cross_device_conversions?: number;
  engagements?: number;
  video_views?: number;
  // Engagement/percentage metrics: 0..1 fractions from Google
  engagement_rate?: number;
  absolute_top_impression_percentage?: number;
  top_impression_percentage?: number;
  search_impression_share?: number;
  search_top_impression_share?: number;
  search_absolute_top_impression_share?: number;
  search_budget_lost_impression_share?: number;
  search_rank_lost_impression_share?: number;
  // Cost ratios already provided by Google
  average_cpv?: number;
}

export interface DerivedMetrics extends RawMetrics {
  cost: number;
  ctr: number;          // clicks / impressions
  cpc: number;          // cost / clicks
  cpm: number;          // cost / impressions × 1000
  cpa: number;          // cost / conversions  (Google reported)
  roas_pre_rto: number; // conversions_value / cost  (Google reported, "Google ROAS")
  // "All conversions" variants
  cpa_all: number;      // cost / all_conversions
  roas_all: number;     // all_conversions_value / cost
  conversion_rate: number; // conversions / clicks
  // Post-RTO fields populated by applyRto()
  conversions_value_post_rto: number;
  roas_post_rto: number;
  // Redshift-sourced fields populated by attachRedshiftMetrics(); null if Redshift not joined for this row
  ncs: number | null;            // new customers (post-RTO)
  ncs_amount: number | null;     // converted_amount from funnel
  aov: number | null;            // amount / ncs
  calc_cpa: number | null;       // cost / ncs
  calc_roas: number | null;      // amount / cost
}

export function deriveMetrics(raw: RawMetrics): DerivedMetrics {
  const cost = raw.cost_micros / MICROS;
  const ctr = raw.impressions ? raw.clicks / raw.impressions : 0;
  const cpc = raw.clicks ? cost / raw.clicks : 0;
  const cpm = raw.impressions ? (cost / raw.impressions) * 1000 : 0;
  const cpa = raw.conversions ? cost / raw.conversions : 0;
  const roas_pre_rto = cost ? raw.conversions_value / cost : 0;
  const allConv = raw.all_conversions ?? 0;
  const allConvValue = raw.all_conversions_value ?? 0;
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
    ncs: null,
    ncs_amount: null,
    aov: null,
    calc_cpa: null,
    calc_roas: null,
    // Derived "all" variants — useful when Conversions is a goal-filtered subset
    cpa_all: allConv ? cost / allConv : 0,
    roas_all: cost ? allConvValue / cost : 0,
    conversion_rate: raw.clicks ? raw.conversions / raw.clicks : 0,
  };
}

/**
 * Attach Redshift-sourced post-RTO fields (NCs, AOV, calc CPA, calc ROAS).
 *
 * Funnel data (lj_google_funnel_daily etc.) is GROSS — at-order-time numbers, before
 * RTO and refunds are netted out. We apply per-brand RTO factors:
 *   - nc_rto_factor: % of NCs that get cancelled (RTO'd before delivery)
 *   - revenue_rto_factor: % of revenue lost to RTO + refunds (typically higher
 *     than NC factor because high-AOV orders RTO at higher rates)
 *
 * If revenue_rto_factor is omitted it defaults to nc_rto_factor (proportional
 * reduction → AOV unchanged).
 */
export function attachRedshiftMetrics(
  m: DerivedMetrics,
  rs: { ncs: number; amount: number },
  rtoFactors: { nc: number; revenue: number } = { nc: 0, revenue: 0 }
): DerivedMetrics {
  const ncFactor = Math.max(0, Math.min(1, rtoFactors.nc));
  const revFactor = Math.max(0, Math.min(1, rtoFactors.revenue));
  const adjNcs = rs.ncs * (1 - ncFactor);
  const adjAmount = rs.amount * (1 - revFactor);
  return {
    ...m,
    ncs: adjNcs,
    ncs_amount: adjAmount,
    aov: adjNcs > 0 ? adjAmount / adjNcs : 0,
    calc_cpa: adjNcs > 0 ? m.cost / adjNcs : 0,
    calc_roas: m.cost > 0 ? adjAmount / m.cost : 0,
    // Also overwrite the post-RTO ROAS so KPI strip picks up Redshift truth automatically.
    conversions_value_post_rto: adjAmount,
    roas_post_rto: m.cost > 0 ? adjAmount / m.cost : 0,
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
    all_conversions: 0,
    all_conversions_value: 0,
    cross_device_conversions: 0,
    engagements: 0,
    video_views: 0,
    engagement_rate: 0,
    absolute_top_impression_percentage: 0,
    top_impression_percentage: 0,
    search_impression_share: 0,
    search_top_impression_share: 0,
    search_absolute_top_impression_share: 0,
    search_budget_lost_impression_share: 0,
    search_rank_lost_impression_share: 0,
    average_cpv: 0,
  };
}

/**
 * Sum two raw metric records. Percentage / share fields (engagement_rate,
 * impression-share, top-impression percentages, average_cpv) can't simply be
 * summed because they're already aggregated ratios. We keep them as a
 * cost-weighted-style approximation only when there is exactly one non-zero
 * source — sufficient for grouping rows by (campaign, criterion) without
 * pretending the aggregate makes sense for cross-row aggregation.
 */
export function addRaw(a: RawMetrics, b: RawMetrics): RawMetrics {
  const pickRatio = (x: number | undefined, y: number | undefined): number => {
    const xv = x ?? 0;
    const yv = y ?? 0;
    if (xv && yv) return (xv + yv) / 2; // both present, naive avg
    return xv || yv;
  };
  return {
    cost_micros: a.cost_micros + b.cost_micros,
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    conversions: a.conversions + b.conversions,
    conversions_value: a.conversions_value + b.conversions_value,
    view_through_conversions: (a.view_through_conversions ?? 0) + (b.view_through_conversions ?? 0),
    all_conversions: (a.all_conversions ?? 0) + (b.all_conversions ?? 0),
    all_conversions_value: (a.all_conversions_value ?? 0) + (b.all_conversions_value ?? 0),
    cross_device_conversions: (a.cross_device_conversions ?? 0) + (b.cross_device_conversions ?? 0),
    engagements: (a.engagements ?? 0) + (b.engagements ?? 0),
    video_views: (a.video_views ?? 0) + (b.video_views ?? 0),
    // ratio-like — naive blend; date segmentation typically yields one row per key anyway
    engagement_rate: pickRatio(a.engagement_rate, b.engagement_rate),
    absolute_top_impression_percentage: pickRatio(a.absolute_top_impression_percentage, b.absolute_top_impression_percentage),
    top_impression_percentage: pickRatio(a.top_impression_percentage, b.top_impression_percentage),
    search_impression_share: pickRatio(a.search_impression_share, b.search_impression_share),
    search_top_impression_share: pickRatio(a.search_top_impression_share, b.search_top_impression_share),
    search_absolute_top_impression_share: pickRatio(a.search_absolute_top_impression_share, b.search_absolute_top_impression_share),
    search_budget_lost_impression_share: pickRatio(a.search_budget_lost_impression_share, b.search_budget_lost_impression_share),
    search_rank_lost_impression_share: pickRatio(a.search_rank_lost_impression_share, b.search_rank_lost_impression_share),
    average_cpv: pickRatio(a.average_cpv, b.average_cpv),
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
    all_conversions: num(metrics.allConversions),
    all_conversions_value: num(metrics.allConversionsValue),
    cross_device_conversions: num(metrics.crossDeviceConversions),
    engagements: num(metrics.engagements),
    video_views: num(metrics.videoViews),
    engagement_rate: num(metrics.engagementRate),
    absolute_top_impression_percentage: num(metrics.absoluteTopImpressionPercentage),
    top_impression_percentage: num(metrics.topImpressionPercentage),
    search_impression_share: num(metrics.searchImpressionShare),
    search_top_impression_share: num(metrics.searchTopImpressionShare),
    search_absolute_top_impression_share: num(metrics.searchAbsoluteTopImpressionShare),
    search_budget_lost_impression_share: num(metrics.searchBudgetLostImpressionShare),
    search_rank_lost_impression_share: num(metrics.searchRankLostImpressionShare),
    average_cpv: num(metrics.averageCpv) / MICROS, // returned in micros
  };
}
