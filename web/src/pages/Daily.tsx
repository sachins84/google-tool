import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

interface Props {
  brandId: number;
  brandName: string;
  from: string;
  to: string;
}

type Row = Awaited<ReturnType<typeof api.daily>>['rows'][number];

const inr = (n: number | null | undefined): string => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const num = (n: number | null | undefined): string => (n == null ? '—' : Math.round(n).toLocaleString('en-IN'));
const mul = (n: number | null | undefined): string => (n == null ? '—' : `${n.toFixed(2)}x`);
const pf = (n: number | null | undefined): string => (n == null ? '—' : `${(n * 100).toFixed(2)}%`);
const fmtDate = (d: string): string => {
  // Show as Day, Mon DD — easier to scan than ISO
  try {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
  } catch { return d; }
};

export function Daily({ brandId, brandName, from, to }: Props) {
  const [data, setData] = useState<{ rows: Row[]; rto_factor: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await api.daily(brandId, from, to)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, [brandId, from, to]);
  useEffect(() => { void load(); }, [load]);

  const rows = data?.rows ?? [];
  const totals = useMemo(() => {
    let cost = 0, conv = 0, convVal = 0, ncs = 0, amt = 0;
    let convPR = 0, convValPR = 0;
    for (const r of rows) {
      cost += r.cost; conv += r.conversions; convVal += r.conversions_value;
      convPR += r.conversions_post_rto; convValPR += r.conversions_value_post_rto;
      ncs += r.ncs; amt += r.ncs_amount;
    }
    return {
      cost, conv, convVal, convPR, convValPR, ncs, amt,
      aov: ncs > 0 ? amt / ncs : 0,
      calc_roas: cost > 0 ? amt / cost : 0,
      calc_cpa: ncs > 0 ? cost / ncs : 0,
      google_roas: cost > 0 ? convValPR / cost : 0,
      google_cpa: convPR > 0 ? cost / convPR : 0,
    };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="bg-white border rounded-lg p-4 flex flex-wrap items-center gap-6">
        <div>
          <div className="text-xs text-gray-500">Daily summary</div>
          <div className="font-semibold">{brandName}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Range</div>
          <div className="text-sm">{from} → {to} <span className="text-gray-400">· {rows.length} day{rows.length === 1 ? '' : 's'}</span></div>
        </div>
        <div>
          <div className="text-xs text-gray-500">RTO factor</div>
          <div className="text-sm">{data ? `${(data.rto_factor * 100).toFixed(1)}%` : '—'}</div>
        </div>
        <div className="flex-1" />
        <button onClick={load} disabled={loading} className="text-xs px-3 py-1.5 rounded border hover:bg-gray-50 disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {loading && !data ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-gray-500 py-8 text-center">No data for the selected range.</div>
      ) : (
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
          <p className="text-[11px] text-gray-400 px-3 py-2">
            Spend / conversions from Google Ads (segments.date). NCs &amp; NC Amount from Redshift funnel, post-RTO at the brand's configured factor.
            <strong className="text-gray-500"> Drill-down by campaign / product is on the way</strong> — this v1 shows brand-wide totals only.
          </p>
        </div>
      )}
    </div>
  );
}
