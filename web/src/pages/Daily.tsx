import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
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

// Metric selector is gone — flat layout now shows every metric on every row.

export function Daily({ brandId, brandName, from, to }: Props) {
  const [mode, setMode] = useState<'brand' | 'campaign'>('brand');
  const [brandData, setBrandData] = useState<{ rows: BrandRow[]; rto_factor: number } | null>(null);
  const [pivot, setPivot] = useState<CampaignPivot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        <div className="flex-1" />
        <button onClick={load} disabled={loading} className="text-xs px-3 py-1.5 rounded border hover:bg-gray-50 disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {mode === 'brand'
        ? <BrandTable data={brandData} loading={loading} />
        : <CampaignPivotTable pivot={pivot} loading={loading} />}
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

function CampaignPivotTable({ pivot, loading }: { pivot: CampaignPivot | null; loading: boolean }) {
  if (loading && !pivot) return <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>;
  if (!pivot || pivot.rows.length === 0) return <div className="text-sm text-gray-500 py-8 text-center">No data.</div>;

  // For each date, build a sorted list of (campaign, cell) entries that have
  // any signal (cost > 0 OR ncs > 0), descending by spend.
  const perDate = pivot.dates.map((date) => {
    const entries = pivot.rows
      .map((r) => ({ row: r, cell: r.by_date[date] }))
      .filter(({ cell }) => cell && ((cell.cost ?? 0) > 0 || (cell.ncs ?? 0) > 0))
      .sort((a, b) => (b.cell?.cost ?? 0) - (a.cell?.cost ?? 0));
    const brand = pivot.brand_daily.find((b) => b.date === date);
    return { date, entries, brand };
  });

  return (
    <div className="bg-white border rounded-lg overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-xs text-gray-500 border-b bg-gray-50">
            <th className="text-left font-medium py-2 px-3">Date</th>
            <th className="text-left font-medium py-2 px-2">Campaign</th>
            <th className="text-right font-medium py-2 px-2">Spend</th>
            <th className="text-right font-medium py-2 px-2">NCs</th>
            <th className="text-right font-medium py-2 px-2">NC Amt</th>
            <th className="text-right font-medium py-2 px-2">AOV</th>
            <th className="text-right font-medium py-2 px-2">Calc ROAS</th>
            <th className="text-right font-medium py-2 px-3">G ROAS (post-RTO)</th>
          </tr>
        </thead>
        <tbody>
          {perDate.map(({ date, entries, brand }) => (
            <Fragment key={date}>
              {entries.map(({ row, cell }, idx) => (
                <tr key={`${date}|${row.customer_id}|${row.campaign_id}`}
                    className={`hover:bg-gray-50 tabular-nums ${idx === 0 ? 'border-t-2 border-t-gray-300' : 'border-b'}`}>
                  <td className="py-1.5 px-3 whitespace-nowrap font-medium align-top">
                    {idx === 0 ? fmtDate(date) : ''}
                  </td>
                  <td className="px-2">
                    <div className="font-medium truncate max-w-[280px]" title={row.campaign_name}>{row.campaign_name}</div>
                    <div className="text-[10px] text-gray-400">{row.channel_type} · {row.status}</div>
                  </td>
                  <td className="px-2 text-right">{inr(cell!.cost)}</td>
                  <td className="px-2 text-right">{num(cell!.ncs)}</td>
                  <td className="px-2 text-right">{inr(cell!.amount)}</td>
                  <td className="px-2 text-right">{cell!.ncs > 0 ? inr(cell!.amount / cell!.ncs) : '—'}</td>
                  <td className="px-2 text-right">{mul(cell!.calc_roas)}</td>
                  <td className="px-3 text-right">{mul(cell!.google_roas)}</td>
                </tr>
              ))}
              {brand && (
                <tr className="bg-gray-50 font-semibold border-b border-t tabular-nums">
                  <td className="py-1.5 px-3"></td>
                  <td className="px-2 text-gray-600">— Brand total —</td>
                  <td className="px-2 text-right">{inr(brand.cost)}</td>
                  <td className="px-2 text-right">{num(brand.ncs)}</td>
                  <td className="px-2 text-right">{inr(brand.amount)}</td>
                  <td className="px-2 text-right">{brand.ncs > 0 ? inr(brand.amount / brand.ncs) : '—'}</td>
                  <td className="px-2 text-right">{brand.cost > 0 ? mul(brand.amount / brand.cost) : '—'}</td>
                  <td className="px-3 text-right text-gray-400">—</td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-gray-400 px-3 py-2 max-w-3xl">
        Per-(date, campaign) NCs are distributed by each campaign's share of that day's brand spend so daily totals reconcile to
        the Brand-totals view. <strong className="text-gray-500">Per-campaign Calc ROAS</strong> in this view therefore equals
        the day's brand ROAS by construction — for true per-campaign ROAS use the main Campaigns tab (which has the full
        utm_campaign attribution). All NC / ROAS values shown here are post-RTO at the brand's configured factor.
      </p>
    </div>
  );
}
