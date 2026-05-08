/**
 * Diagnose service — for each metric (CPM/CPC/CTR/conv_rate/calc_roas/calc_cpa)
 * builds a structured diagnostic for a given campaign by surfacing the signals
 * that actually move that metric.
 *
 * No LLM. The "reasoning" is rule-based: we expose the data clearly + tag
 * notable signals (severity high/warn/info) so the user can read off the cause.
 */

import { search } from './google-ads.js';
import { getLoginCustomerId } from './mcc-map.js';
import { getBrand } from './brands.js';
import {
  fetchRowsForBrand,
} from '../routes/performance.js';
import type { DerivedMetrics } from './metrics.js';

export type DiagnoseMetric = 'cpm' | 'cpc' | 'ctr' | 'conv_rate' | 'calc_roas' | 'calc_cpa' | 'cpa';

interface PeerEntry { name: string; value: number; spend: number; channel_type?: string; }
interface TrendPoint { date: string; value: number; }
interface Signal { label: string; value: string | number; note?: string; severity?: 'info' | 'warn' | 'high'; }
interface Contributor { name: string; metric: number; secondary?: Record<string, number>; }
interface ContributorList { label: string; columns: string[]; rows: Contributor[]; }

export interface DiagnoseResult {
  campaign_id: string;
  campaign_name?: string;
  channel_type?: string;
  metric: DiagnoseMetric;
  metric_label: string;
  unit: 'INR' | '%' | 'x' | 'count';
  current_value: number;
  // Compare against
  brand_avg?: number;
  channel_avg?: number;       // average across same-channel-type campaigns in brand
  prev_period_value?: number; // same metric for the comparison window
  // 14-day daily trend (or as much as we can fit)
  trend: TrendPoint[];
  // Structured signals — the bullets the user reads
  signals: Signal[];
  // Top contributing rows (e.g. top keywords by CPM)
  contributors?: ContributorList[];
  // Rule-based observations woven from the signals
  observations: string[];
}

const METRIC_LABEL: Record<DiagnoseMetric, string> = {
  cpm: 'CPM',
  cpc: 'Avg CPC',
  ctr: 'CTR',
  conv_rate: 'Conv. rate',
  calc_roas: 'Calc ROAS',
  calc_cpa: 'Calc CPA',
  cpa: 'CPA (Google reported)',
};

const METRIC_UNIT: Record<DiagnoseMetric, 'INR' | '%' | 'x' | 'count'> = {
  cpm: 'INR', cpc: 'INR', cpa: 'INR', calc_cpa: 'INR',
  ctr: '%', conv_rate: '%',
  calc_roas: 'x',
};

function metricFromRow(m: DerivedMetrics, key: DiagnoseMetric): number {
  switch (key) {
    case 'cpm': return m.cpm;
    case 'cpc': return m.cpc;
    case 'ctr': return m.ctr;
    case 'cpa': return m.cpa;
    case 'calc_cpa': return m.calc_cpa ?? 0;
    case 'calc_roas': return m.calc_roas ?? 0;
    case 'conv_rate': return m.clicks ? m.conversions / m.clicks : 0;
  }
}

/**
 * Higher-is-better for these metrics — drives severity colouring on signals.
 */
function higherIsBetter(metric: DiagnoseMetric): boolean {
  return metric === 'ctr' || metric === 'conv_rate' || metric === 'calc_roas';
}

export async function diagnose(
  brandId: number,
  customerId: string,
  campaignId: string,
  metric: DiagnoseMetric,
  from: string,
  to: string,
  compareFrom?: string,
  compareTo?: string,
): Promise<DiagnoseResult> {
  const brand = getBrand(brandId);
  if (!brand) throw new Error('Brand not found');
  const loginCustomerId = (await getLoginCustomerId(customerId)) ?? undefined;

  // 1. Pull all campaigns in the brand with metrics → find the subject + peers
  const allCampaigns = await fetchRowsForBrand('campaign', brandId, from, to);
  const subject = allCampaigns.find((r) => r.campaign_id === campaignId);
  if (!subject) throw new Error(`Campaign ${campaignId} not found in brand`);

  const channelType = subject.channel_type ?? 'UNKNOWN';
  const subjectName = subject.campaign_name ?? campaignId;
  const currentValue = metricFromRow(subject.metrics, metric);
  const subjectSpend = subject.metrics.cost;

  // Brand average + same-channel average (weighted by spend, not arithmetic)
  function weightedAvg(rows: typeof allCampaigns): number {
    let num = 0, den = 0;
    for (const r of rows) {
      const v = metricFromRow(r.metrics, metric);
      const w = r.metrics.cost;
      if (Number.isFinite(v) && w > 0) { num += v * w; den += w; }
    }
    return den ? num / den : 0;
  }
  const peerCampaigns = allCampaigns.filter((r) => r.campaign_id !== campaignId && r.metrics.cost > 0);
  const sameChannelPeers = peerCampaigns.filter((r) => r.channel_type === channelType);
  const brandAvg = weightedAvg(peerCampaigns);
  const channelAvg = sameChannelPeers.length ? weightedAvg(sameChannelPeers) : undefined;

  // Prev-period value (if compare window provided)
  let prevValue: number | undefined;
  if (compareFrom && compareTo) {
    const prevRows = await fetchRowsForBrand('campaign', brandId, compareFrom, compareTo);
    const prevSubject = prevRows.find((r) => r.campaign_id === campaignId);
    if (prevSubject) prevValue = metricFromRow(prevSubject.metrics, metric);
  }

  // 2. 14-day daily trend via segments.date on campaign
  const trend = await fetchDailyTrend(customerId, loginCustomerId, campaignId, from, to, metric);

  // 3. Signals + contributors per metric
  const { signals, contributors, observations } =
    await buildSignalsForMetric({
      brand_id: brandId,
      customer_id: customerId,
      login_customer_id: loginCustomerId,
      campaign_id: campaignId,
      channel_type: channelType,
      from, to,
      subject_metric: subject.metrics,
      peer_campaigns: peerCampaigns,
      same_channel_peers: sameChannelPeers,
      metric,
      current_value: currentValue,
      brand_avg: brandAvg,
      channel_avg: channelAvg,
      prev_value: prevValue,
      subject_spend: subjectSpend,
    });

  return {
    campaign_id: campaignId,
    campaign_name: subjectName,
    channel_type: channelType,
    metric,
    metric_label: METRIC_LABEL[metric],
    unit: METRIC_UNIT[metric],
    current_value: currentValue,
    brand_avg: brandAvg || undefined,
    channel_avg: channelAvg,
    prev_period_value: prevValue,
    trend,
    signals,
    contributors,
    observations,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Daily trend (segments.date)

async function fetchDailyTrend(
  customerId: string,
  loginCustomerId: string | undefined,
  campaignId: string,
  from: string, to: string,
  metric: DiagnoseMetric,
): Promise<TrendPoint[]> {
  const rows = await search<{
    segments?: { date?: string };
    metrics?: Record<string, unknown>;
  }>({
    customerId, loginCustomerId,
    query: `SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks,
                   metrics.conversions, metrics.conversions_value
            FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'
              AND campaign.id = ${campaignId}
            ORDER BY segments.date ASC`,
  }).catch(() => [] as Array<{ segments?: { date?: string }; metrics?: Record<string, unknown> }>);

  return rows.map((r) => {
    const m = r.metrics ?? {};
    const cost = Number(m.costMicros ?? 0) / 1_000_000;
    const impressions = Number(m.impressions ?? 0);
    const clicks = Number(m.clicks ?? 0);
    const conversions = Number(m.conversions ?? 0);
    const conversionsValue = Number(m.conversionsValue ?? 0);
    let value = 0;
    switch (metric) {
      case 'cpm': value = impressions ? (cost / impressions) * 1000 : 0; break;
      case 'cpc': value = clicks ? cost / clicks : 0; break;
      case 'ctr': value = impressions ? clicks / impressions : 0; break;
      case 'cpa': value = conversions ? cost / conversions : 0; break;
      case 'calc_cpa': value = conversions ? cost / conversions : 0; break; // proxy at trend level
      case 'calc_roas': value = cost ? conversionsValue / cost : 0; break;  // proxy (Google ROAS, since RTO daily isn't available cheaply)
      case 'conv_rate': value = clicks ? conversions / clicks : 0; break;
    }
    return { date: r.segments?.date ?? '', value };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Signal builders

interface BuildArgs {
  brand_id: number;
  customer_id: string;
  login_customer_id: string | undefined;
  campaign_id: string;
  channel_type: string;
  from: string;
  to: string;
  subject_metric: DerivedMetrics;
  peer_campaigns: Array<{ campaign_name?: string; channel_type?: string; metrics: DerivedMetrics }>;
  same_channel_peers: Array<{ campaign_name?: string; metrics: DerivedMetrics }>;
  metric: DiagnoseMetric;
  current_value: number;
  brand_avg: number;
  channel_avg?: number;
  prev_value?: number;
  subject_spend: number;
}

async function buildSignalsForMetric(args: BuildArgs): Promise<{ signals: Signal[]; contributors?: ContributorList[]; observations: string[] }> {
  const { metric } = args;
  if (metric === 'cpm' || metric === 'cpc') return buildCostPerImpressionOrClick(args);
  if (metric === 'ctr') return buildCtr(args);
  if (metric === 'conv_rate') return buildConvRate(args);
  if (metric === 'calc_roas' || metric === 'calc_cpa' || metric === 'cpa') return buildRoasOrCpa(args);
  return { signals: [], observations: [] };
}

// Common: format helpers
const fmtINR = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');
const fmtMul = (n: number) => Number.isFinite(n) ? n.toFixed(2) : '—';
const fmtPct = (n: number) => Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '—';

function deltaSignal(current: number, baseline: number | undefined, label: string, betterIsHigher: boolean, fmt: (n: number) => string): Signal | null {
  if (baseline == null || !Number.isFinite(baseline) || baseline === 0) return null;
  const pct = (current - baseline) / baseline;
  const sign = pct >= 0 ? '+' : '';
  const isWorse = betterIsHigher ? pct < -0.1 : pct > 0.1;
  const isMuchWorse = betterIsHigher ? pct < -0.25 : pct > 0.25;
  return {
    label,
    value: `${fmt(current)} vs ${fmt(baseline)}  (${sign}${(pct * 100).toFixed(0)}%)`,
    severity: isMuchWorse ? 'high' : isWorse ? 'warn' : 'info',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CPM / CPC diagnosis

async function buildCostPerImpressionOrClick(args: BuildArgs): Promise<{ signals: Signal[]; contributors?: ContributorList[]; observations: string[] }> {
  const { metric, subject_metric, current_value, brand_avg, channel_avg, prev_value, channel_type } = args;
  const fmt = (n: number) => fmtINR(n);
  const signals: Signal[] = [];
  const observations: string[] = [];

  // Comparisons
  const sChannel = channel_avg != null ? deltaSignal(current_value, channel_avg, `vs same-channel avg (${channel_type})`, false, fmt) : null;
  if (sChannel) signals.push(sChannel);
  const sBrand = deltaSignal(current_value, brand_avg, 'vs brand-wide avg', false, fmt);
  if (sBrand) signals.push(sBrand);
  const sPrev = deltaSignal(current_value, prev_value, 'vs previous period', false, fmt);
  if (sPrev) signals.push(sPrev);

  // CTR — if CTR drops, ad rank suffers and CPC/CPM rise
  signals.push({
    label: 'CTR',
    value: fmtPct(subject_metric.ctr),
    note: 'When CTR drops, Google has to charge more per impression to maintain ad rank. A CTR drop is often the proximate cause of CPM/CPC creep.',
  });

  // For Search/Shopping, fetch QS distribution + match-type mix
  let contributors: ContributorList[] | undefined;
  if (channel_type === 'SEARCH' || channel_type === 'SHOPPING') {
    const { qsByBucket, matchMix, topKeywords, ctrCurrent, ctrPrev } = await fetchSearchKeywordContext(
      args.customer_id, args.login_customer_id, args.campaign_id, args.from, args.to
    );

    if (qsByBucket.total > 0) {
      const lowQsPct = qsByBucket.low / qsByBucket.total;
      signals.push({
        label: 'Quality Score distribution',
        value: `high (7+): ${qsByBucket.high}, mid (4-6): ${qsByBucket.mid}, low (≤3): ${qsByBucket.low}`,
        note: 'Lower QS = higher CPC. Anything in low bucket is dragging your average up.',
        severity: lowQsPct > 0.3 ? 'high' : lowQsPct > 0.15 ? 'warn' : 'info',
      });
      if (lowQsPct > 0.15) observations.push(`${(lowQsPct * 100).toFixed(0)}% of keywords have Quality Score ≤ 3 — these are paying a premium per click.`);
    }

    if (matchMix.length) {
      const top = matchMix[0];
      signals.push({
        label: 'Match-type mix (by spend)',
        value: matchMix.map((m) => `${m.match}: ${(m.share * 100).toFixed(0)}%`).join(', '),
        note: 'EXACT match keywords typically command higher CPC than BROAD on the same query intent.',
      });
      if (top && top.match === 'EXACT' && top.share > 0.5) observations.push(`Spend is heavily concentrated in EXACT match (${(top.share * 100).toFixed(0)}%) — these usually carry higher CPC than BROAD/PHRASE.`);
    }

    if (ctrPrev != null && ctrCurrent < ctrPrev * 0.85) {
      observations.push(`CTR fell from ${fmtPct(ctrPrev)} to ${fmtPct(ctrCurrent)} — likely the proximate cause of higher ${metric === 'cpm' ? 'CPM' : 'CPC'}.`);
    }

    if (topKeywords.length) {
      contributors = [{
        label: `Top 10 keywords by spend — ${metric === 'cpm' ? 'CPM' : 'CPC'} drivers`,
        columns: ['Keyword', 'Match', 'Spend', metric === 'cpm' ? 'CPM' : 'CPC', 'CTR', 'QS'],
        rows: topKeywords.slice(0, 10).map((k) => ({
          name: `${k.text}`,
          metric: metric === 'cpm' ? k.cpm : k.cpc,
          secondary: { match_type_idx: 0, spend: k.cost, ctr: k.ctr, qs: k.qs ?? 0, match_type: k.match_type as unknown as number },
        })),
      }];
    }
  }

  return { signals, contributors, observations };
}

interface KwContext {
  qsByBucket: { total: number; high: number; mid: number; low: number };
  matchMix: Array<{ match: string; share: number; cost: number }>;
  topKeywords: Array<{ text: string; match_type: string; cost: number; impressions: number; clicks: number; cpm: number; cpc: number; ctr: number; qs?: number }>;
  ctrCurrent: number;
  ctrPrev: number | null;
}

async function fetchSearchKeywordContext(
  customerId: string, loginCustomerId: string | undefined,
  campaignId: string, from: string, to: string
): Promise<KwContext> {
  const rows = await search<{
    adGroupCriterion?: { keyword?: { text?: string; matchType?: string }; qualityInfo?: { qualityScore?: number } };
    metrics?: Record<string, unknown>;
  }>({
    customerId, loginCustomerId,
    query: `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
                   ad_group_criterion.quality_info.quality_score,
                   metrics.cost_micros, metrics.impressions, metrics.clicks
            FROM keyword_view WHERE segments.date BETWEEN '${from}' AND '${to}'
              AND campaign.id = ${campaignId}
              AND ad_group_criterion.type = 'KEYWORD'
              AND metrics.impressions > 0`,
  }).catch(() => []);

  const qsBuckets = { total: 0, high: 0, mid: 0, low: 0 };
  const matchSpend: Record<string, number> = {};
  const kws: KwContext['topKeywords'] = [];
  let totalCost = 0;

  for (const r of rows) {
    const text = r.adGroupCriterion?.keyword?.text ?? '?';
    const match = r.adGroupCriterion?.keyword?.matchType ?? 'UNKNOWN';
    const qs = r.adGroupCriterion?.qualityInfo?.qualityScore;
    const m = r.metrics ?? {};
    const cost = Number(m.costMicros ?? 0) / 1_000_000;
    const impressions = Number(m.impressions ?? 0);
    const clicks = Number(m.clicks ?? 0);
    if (qs != null) {
      qsBuckets.total += 1;
      if (qs >= 7) qsBuckets.high += 1;
      else if (qs >= 4) qsBuckets.mid += 1;
      else qsBuckets.low += 1;
    }
    matchSpend[match] = (matchSpend[match] ?? 0) + cost;
    totalCost += cost;
    kws.push({
      text, match_type: match,
      cost, impressions, clicks,
      cpm: impressions ? (cost / impressions) * 1000 : 0,
      cpc: clicks ? cost / clicks : 0,
      ctr: impressions ? clicks / impressions : 0,
      qs,
    });
  }

  const matchMix = Object.entries(matchSpend)
    .map(([match, cost]) => ({ match, cost, share: totalCost ? cost / totalCost : 0 }))
    .sort((a, b) => b.cost - a.cost);
  kws.sort((a, b) => b.cost - a.cost);

  // Compare CTR vs prev half of window — quick split
  const ctrCurrent = kws.length ? kws.reduce((a, k) => a + k.clicks, 0) / Math.max(1, kws.reduce((a, k) => a + k.impressions, 0)) : 0;
  return { qsByBucket: qsBuckets, matchMix, topKeywords: kws, ctrCurrent, ctrPrev: null };
}

// ────────────────────────────────────────────────────────────────────────────
// CTR diagnosis

async function buildCtr(args: BuildArgs): Promise<{ signals: Signal[]; contributors?: ContributorList[]; observations: string[] }> {
  const { current_value, brand_avg, channel_avg, prev_value, channel_type, subject_metric } = args;
  const signals: Signal[] = [];
  const observations: string[] = [];
  const fmt = (n: number) => fmtPct(n);

  const s1 = channel_avg != null ? deltaSignal(current_value, channel_avg, `vs same-channel avg (${channel_type})`, true, fmt) : null;
  if (s1) signals.push(s1);
  const s2 = deltaSignal(current_value, brand_avg, 'vs brand avg', true, fmt);
  if (s2) signals.push(s2);
  const s3 = deltaSignal(current_value, prev_value, 'vs previous period', true, fmt);
  if (s3) signals.push(s3);

  signals.push({ label: 'Impressions', value: subject_metric.impressions.toLocaleString('en-IN') });
  signals.push({ label: 'Clicks', value: subject_metric.clicks.toLocaleString('en-IN') });

  if (channel_type === 'SEARCH' || channel_type === 'SHOPPING') {
    const { topKeywords } = await fetchSearchKeywordContext(args.customer_id, args.login_customer_id, args.campaign_id, args.from, args.to);
    // Worst offenders: keywords with high impressions but low CTR
    const worst = topKeywords
      .filter((k) => k.impressions > 100)
      .sort((a, b) => a.ctr - b.ctr)
      .slice(0, 10);
    return {
      signals,
      observations,
      contributors: [{
        label: 'Lowest-CTR keywords by impressions (≥100 impr)',
        columns: ['Keyword', 'Match', 'Impressions', 'CTR', 'QS'],
        rows: worst.map((k) => ({ name: k.text, metric: k.ctr, secondary: { impressions: k.impressions, qs: k.qs ?? 0, match_type: k.match_type as unknown as number } })),
      }],
    };
  }
  return { signals, observations };
}

// ────────────────────────────────────────────────────────────────────────────
// Conv rate diagnosis

async function buildConvRate(args: BuildArgs): Promise<{ signals: Signal[]; contributors?: ContributorList[]; observations: string[] }> {
  const { current_value, brand_avg, channel_avg, prev_value, subject_metric, channel_type } = args;
  const signals: Signal[] = [];
  const fmt = (n: number) => fmtPct(n);
  const s1 = channel_avg != null ? deltaSignal(current_value, channel_avg, `vs same-channel avg (${channel_type})`, true, fmt) : null;
  if (s1) signals.push(s1);
  const s2 = deltaSignal(current_value, brand_avg, 'vs brand avg', true, fmt);
  if (s2) signals.push(s2);
  const s3 = deltaSignal(current_value, prev_value, 'vs previous period', true, fmt);
  if (s3) signals.push(s3);
  signals.push({ label: 'Clicks', value: subject_metric.clicks.toLocaleString('en-IN') });
  signals.push({ label: 'Conversions', value: subject_metric.conversions.toFixed(0) });
  return { signals, observations: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// ROAS / CPA diagnosis

async function buildRoasOrCpa(args: BuildArgs): Promise<{ signals: Signal[]; contributors?: ContributorList[]; observations: string[] }> {
  const { metric, current_value, brand_avg, channel_avg, prev_value, subject_metric, peer_campaigns, channel_type } = args;
  const fmt = metric === 'calc_roas' ? fmtMul : fmtINR;
  const better = higherIsBetter(metric);

  const signals: Signal[] = [];
  const s1 = channel_avg != null ? deltaSignal(current_value, channel_avg, `vs same-channel avg (${channel_type})`, better, fmt) : null;
  if (s1) signals.push(s1);
  const s2 = deltaSignal(current_value, brand_avg, 'vs brand avg', better, fmt);
  if (s2) signals.push(s2);
  const s3 = deltaSignal(current_value, prev_value, 'vs previous period', better, fmt);
  if (s3) signals.push(s3);

  signals.push({ label: 'Spend', value: fmtINR(subject_metric.cost) });
  if (subject_metric.ncs != null) signals.push({ label: 'NCs (post-RTO)', value: subject_metric.ncs.toFixed(0) });
  if (subject_metric.aov != null) signals.push({ label: 'AOV', value: fmtINR(subject_metric.aov) });

  // Top campaigns in same channel by metric — gives benchmark
  const peerSorted = [...peer_campaigns]
    .filter((p) => p.channel_type === channel_type && p.metrics.cost > 5000)
    .sort((a, b) => {
      const va = metricFromRow(a.metrics, metric);
      const vb = metricFromRow(b.metrics, metric);
      return better ? vb - va : va - vb;
    })
    .slice(0, 8);
  const contributors: ContributorList[] = peerSorted.length ? [{
    label: `Best peers in ${channel_type}`,
    columns: ['Campaign', 'Spend', metric === 'calc_roas' ? 'Calc ROAS' : metric === 'calc_cpa' ? 'Calc CPA' : 'CPA'],
    rows: peerSorted.map((p) => ({
      name: p.campaign_name ?? '?',
      metric: metricFromRow(p.metrics, metric),
      secondary: { spend: p.metrics.cost },
    })),
  }] : [];

  return { signals, contributors, observations: [] };
}
