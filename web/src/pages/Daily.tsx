import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

interface Props {
  brandId: number;
  brandName: string;
  from: string;
  to: string;
}

type BrandRow = Awaited<ReturnType<typeof api.daily>>['rows'][number];
type CampaignPivot = Awaited<ReturnType<typeof api.dailyByCampaign>>;

const inr = (n: number | null | undefined): string => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const num = (n: number | null | undefined): string => (n == null ? '—' : Math.round(n).toLocaleString('en-IN'));
const mul = (n: number | null | undefined): string => (n == null ? '—' : `${n.toFixed(2)}x`);
const pf = (n: number | null | undefined): string => (n == null ? '—' : `${(n * 100).toFixed(2)}%`);
const fmtDate = (d: string): string => {
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }); }
  catch { return d; }
};
const fmtDateShort = (d: string): string => {
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); }
  catch { return d; }
};

type Metric = 'cost' | 'ncs' | 'amount' | 'calc_roas' | 'calc_cpa' | 'google_roas';
const METRICS: Array<{ key: Metric; label: string; fmt: (n: number) => string }> = [
  { key: 'cost',        label: 'Spend',          fmt: inr },
  { key: 'ncs',         label: 'NCs',            fmt: num },
  { key: 'amount',      label: 'NC Amount',      fmt: inr },
  { key: 'calc_roas',   label: 'Calc ROAS',      fmt: mul },
  { key: 'calc_cpa',    label: 'Calc CPA',       fmt: inr },
  { key: 'google_roas', label: 'G ROAS (post-RTO)', fmt: mul },
];

export function Daily({ brandId, brandName, from, to }: Props) {
  const [mode, setMode] = useState<'brand' | 'campaign'>('brand');
  const [brandData, setBrandData] = useState<{ rows: BrandRow[]; rto_factor: number } | null>(null);
  const [pivot, setPivot] = useState<CampaignPivot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>('cost');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (mode === 'brand') setBrandData(await api.daily(brandId, from, to));
      else setPivot(await api.dailyByCampaign(brandId, from, to));
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, [brandId, from, to, mode]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="bg-white border rounded-lg p-4 flex flex-wrap items-center gap-6">
        <div>
          <div className="text-xs text-gray-500">Daily summary</div>
          <div className="font-semibold">{brandName}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Range</div>
          <div className="text-sm">{from} → {to}</div>
        </div>
        <div className="inline-flex rounded-lg border overflow-hidden text-sm">
          <button onClick={() => setMode('brand')} className={`px-3 py-1.5 ${mode === 'brand' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'}`}>Brand totals</button>
          <button onClick={() => setMode('campaign')} className={`px-3 py-1.5 ${mode === 'campaign' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'}`}>By campaign</button>
        </div>
        {mode === 'campaign' && (
          <div className="flex items-center gap-1 text-xs">
            <span className="text-gray-500 mr-1">Metric:</span>
            {METRICS.map((m) => (
              <button key={m.key} onClick={() => setMetric(m.key)}
                className={`px-2 py-1 rounded ${metric === m.key ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
                {m.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex-1" />
        <button onClick={load} disabled={loading} className="text-xs px-3 py-1.5 rounded border hover:bg-gray-50 disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {mode === 'brand'
        ? <BrandTable data={brandData} loading={loading} />
        : <CampaignPivotTable pivot={pivot} metric={metric} loading={loading} />}
    </div>
  );
}

function BrandTable({ data, loading }: { data: { rows: BrandRow[]; rto_factor: number } | null; loading: boolean }) {
  const rows = data?.rows ?? [];
  const totals = useMemo(() => {
    let cost = 0, conv = 0, convVal = 0, convPR = 0, convValPR = 0, ncs = 0, amt = 0;
    for (const r of rows) {
      cost += r.cost; conv += r.conversions; convVal += r.conversions_value;
      convPR += r.conversions_post_rto; convValPR += r.conversions_value_post_rto;
      ncs += r.ncs; amt += r.ncs_amount;
    }
    return { cost, conv, convVal, convPR, convValPR, ncs, amt,
      aov: ncs > 0 ? amt / ncs : 0, calc_roas: cost > 0 ? amt / cost : 0,
      calc_cpa: ncs > 0 ? cost / ncs : 0,
      google_roas: cost > 0 ? convValPR / cost : 0, google_cpa: convPR > 0 ? cost / convPR : 0 };
  }, [rows]);

  if (loading && !data) return <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>;
  if (rows.length === 0) return <div className="text-sm text-gray-500 py-8 text-center">No data.</div>;

  return (
    <div className="bg-white border rounded-lg overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-xs text-gray-500 border-b bg-gray-50">
            <th className="text-left font-medium py-2 px-3">Date</th>
            <th className="text-right font-medium py-2 px-2">Spend</th>
            <th className="text-right font-medium py-2 px-2">NCs (post-RTO)</th>
            <th className="text-right font-medium py-2 px-2">NC Amt</th>
            <th className="text-right font-medium py-2 px-2">AOV</th>
            <th className="text-right font-medium py-2 px-2">Calc ROAS</th>
            <th className="text-right font-medium py-2 px-2">Calc CPA</th>
            <th className="text-right font-medium py-2 px-2">Conv (G, post-RTO)</th>
            <th className="text-right font-medium py-2 px-2">G ROAS (post-RTO)</th>
            <th className="text-right font-medium py-2 px-2">G CPA</th>
            <th className="text-right font-medium py-2 px-2">CTR</th>
            <th className="text-right font-medium py-2 px-3">CPC</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date} className="border-b last:border-0 hover:bg-gray-50 tabular-nums">
              <td className="py-2 px-3 whitespace-nowrap font-medium">{fmtDate(r.date)}</td>
              <td className="px-2 text-right">{inr(r.cost)}</td>
              <td className="px-2 text-right">{num(r.ncs)}</td>
              <td className="px-2 text-right">{inr(r.ncs_amount)}</td>
              <td className="px-2 text-right">{inr(r.aov)}</td>
              <td className="px-2 text-right font-semibold">{mul(r.calc_roas)}</td>
              <td className="px-2 text-right">{inr(r.calc_cpa)}</td>
              <td className="px-2 text-right">{num(r.conversions_post_rto)}</td>
              <td className="px-2 text-right">{mul(r.google_roas)}</td>
              <td className="px-2 text-right">{inr(r.google_cpa)}</td>
              <td className="px-2 text-right text-gray-500">{pf(r.ctr)}</td>
              <td className="px-3 text-right text-gray-500">{inr(r.cpc)}</td>
            </tr>
          ))}
          <tr className="bg-gray-50 font-semibold border-t-2 tabular-nums">
            <td className="py-2 px-3">Total / Avg</td>
            <td className="px-2 text-right">{inr(totals.cost)}</td>
            <td className="px-2 text-right">{num(totals.ncs)}</td>
            <td className="px-2 text-right">{inr(totals.amt)}</td>
            <td className="px-2 text-right">{inr(totals.aov)}</td>
            <td className="px-2 text-right">{mul(totals.calc_roas)}</td>
            <td className="px-2 text-right">{inr(totals.calc_cpa)}</td>
            <td className="px-2 text-right">{num(totals.convPR)}</td>
            <td className="px-2 text-right">{mul(totals.google_roas)}</td>
            <td className="px-2 text-right">{inr(totals.google_cpa)}</td>
            <td className="px-2 text-right text-gray-500">—</td>
            <td className="px-3 text-right text-gray-500">—</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function CampaignPivotTable({ pivot, metric, loading }: { pivot: CampaignPivot | null; metric: Metric; loading: boolean }) {
  if (loading && !pivot) return <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>;
  if (!pivot || pivot.rows.length === 0) return <div className="text-sm text-gray-500 py-8 text-center">No data.</div>;
  const fmt = METRICS.find((m) => m.key === metric)!.fmt;
  const metricLabel = METRICS.find((m) => m.key === metric)!.label;
  const cellValue = (cell: { cost: number; ncs: number; amount: number; calc_roas: number; calc_cpa: number; google_roas: number } | undefined): number => {
    if (!cell) return 0;
    switch (metric) {
      case 'cost': return cell.cost;
      case 'ncs': return cell.ncs;
      case 'amount': return cell.amount;
      case 'calc_roas': return cell.calc_roas;
      case 'calc_cpa': return cell.calc_cpa;
      case 'google_roas': return cell.google_roas;
    }
  };
  const totalValue = (t: CampaignPivot['rows'][number]['totals']): number => {
    switch (metric) {
      case 'cost': return t.cost;
      case 'ncs': return t.ncs;
      case 'amount': return t.amount;
      case 'calc_roas': return t.calc_roas;
      case 'calc_cpa': return t.calc_cpa;
      case 'google_roas': return t.google_roas;
    }
  };
  const brandDailyValue = (b: CampaignPivot['brand_daily'][number]): number => {
    switch (metric) {
      case 'cost': return b.cost;
      case 'ncs': return b.ncs;
      case 'amount': return b.amount;
      case 'calc_roas': return b.cost > 0 ? b.amount / b.cost : 0;
      case 'calc_cpa': return b.ncs > 0 ? b.cost / b.ncs : 0;
      case 'google_roas': return 0; // Not applicable at brand-daily footer for this metric
    }
  };
  return (
    <div className="bg-white border rounded-lg overflow-x-auto">
      <table className="text-sm border-collapse">
        <thead>
          <tr className="text-xs text-gray-500 border-b bg-gray-50">
            <th className="text-left font-medium py-2 px-3 sticky left-0 bg-gray-50 z-10 min-w-[260px]">
              Campaign <span className="text-gray-400 font-normal">· {metricLabel}</span>
            </th>
            {pivot.dates.map((d) => (
              <th key={d} className="text-right font-medium py-2 px-2 whitespace-nowrap">{fmtDateShort(d)}</th>
            ))}
            <th className="text-right font-medium py-2 px-3 whitespace-nowrap bg-gray-100">Total</th>
          </tr>
        </thead>
        <tbody>
          {pivot.rows.map((r) => (
            <tr key={`${r.customer_id}|${r.campaign_id}`} className="border-b last:border-0 hover:bg-gray-50 tabular-nums">
              <td className="py-1.5 px-3 sticky left-0 bg-white max-w-[260px]">
                <div className="truncate font-medium" title={r.campaign_name}>{r.campaign_name}</div>
                <div className="text-[10px] text-gray-400">{r.channel_type} · {r.status}</div>
              </td>
              {pivot.dates.map((d) => (
                <td key={d} className="px-2 text-right">{fmt(cellValue(r.by_date[d]))}</td>
              ))}
              <td className="px-3 text-right font-semibold bg-gray-50/60">{fmt(totalValue(r.totals))}</td>
            </tr>
          ))}
          <tr className="bg-gray-100 font-semibold border-t-2 tabular-nums">
            <td className="py-2 px-3 sticky left-0 bg-gray-100">Brand daily total</td>
            {pivot.brand_daily.map((b) => (
              <td key={b.date} className="px-2 text-right">{fmt(brandDailyValue(b))}</td>
            ))}
            <td className="px-3 text-right">{fmt(pivot.brand_daily.reduce((s, b) => s + brandDailyValue(b), 0))}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-[11px] text-gray-400 px-3 py-2 max-w-3xl">
        Per-day cell NCs are distributed across campaigns proportionally to each campaign's share of the day's brand spend
        — column totals reconcile to the Brand-totals view. <strong className="text-gray-500">Per-campaign Calc ROAS</strong> in
        this pivot therefore equals the day's brand ROAS by construction; for true per-campaign ROAS use the main Campaigns table
        (which has the full utm_campaign attribution).
      </p>
    </div>
  );
}
