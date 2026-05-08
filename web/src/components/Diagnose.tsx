import { useEffect, useMemo, useState } from 'react';
import { api, type DiagnoseResult, type PerfRow } from '../lib/api';
import { fmtINR, fmtMul, fmtPct, fmtNum, truncate } from '../lib/format';

interface Props {
  brandId: number;
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
  rows: PerfRow[];
}

type Metric = 'cpm' | 'cpc' | 'ctr' | 'conv_rate' | 'calc_roas' | 'calc_cpa' | 'cpa';

const METRIC_OPTIONS: Array<{ value: Metric; label: string }> = [
  { value: 'cpm', label: 'CPM' },
  { value: 'cpc', label: 'Avg CPC' },
  { value: 'ctr', label: 'CTR' },
  { value: 'conv_rate', label: 'Conversion rate' },
  { value: 'calc_roas', label: 'Calc ROAS (post-RTO)' },
  { value: 'calc_cpa', label: 'Calc CPA (post-RTO)' },
  { value: 'cpa', label: 'CPA (Google reported)' },
];

function formatMetricValue(value: number, unit: 'INR' | '%' | 'x' | 'count'): string {
  if (unit === 'INR') return fmtINR(value);
  if (unit === '%') return fmtPct(value);
  if (unit === 'x') return fmtMul(value);
  return fmtNum(value, 0);
}

export function Diagnose({ brandId, from, to, compareFrom, compareTo, rows }: Props) {
  const [campaignId, setCampaignId] = useState<string>('');
  const [metric, setMetric] = useState<Metric>('cpm');
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligibleCampaigns = useMemo(() => {
    return rows
      .filter((r) => !r.synthetic && (r.metrics?.cost ?? 0) > 0)
      .sort((a, b) => (b.metrics?.cost ?? 0) - (a.metrics?.cost ?? 0));
  }, [rows]);

  useEffect(() => {
    if (!campaignId && eligibleCampaigns[0]?.campaign_id) {
      setCampaignId(eligibleCampaigns[0].campaign_id);
    }
  }, [eligibleCampaigns, campaignId]);

  async function run() {
    if (!campaignId) return;
    const target = eligibleCampaigns.find((c) => c.campaign_id === campaignId);
    if (!target?.customer_id) { setError('Could not resolve customer_id for this campaign'); return; }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.diagnose({
        brand_id: brandId,
        customer_id: target.customer_id,
        campaign_id: campaignId,
        metric,
        from, to,
        compare_from: compareFrom, compare_to: compareTo,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="space-y-4">
      <h3 className="font-medium">Diagnose a metric</h3>
      <p className="text-xs text-gray-500">
        Pick a campaign + a metric. The tool surfaces the signals that move that metric (peer comparison, trend, QS distribution, match-type mix, top contributors) so you can see the cause.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm flex-1 min-w-[260px]"
        >
          {eligibleCampaigns.length === 0 && <option value="">No spending campaigns</option>}
          {eligibleCampaigns.map((c) => (
            <option key={c.campaign_id} value={c.campaign_id}>
              {truncate(c.campaign_name ?? c.campaign_id ?? '?', 50)} — {c.channel_type} — {fmtINR(c.metrics?.cost ?? 0)}
            </option>
          ))}
        </select>

        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as Metric)}
          className="border rounded px-3 py-1.5 text-sm"
        >
          {METRIC_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <button
          onClick={run}
          disabled={loading || !campaignId}
          className="bg-black text-white px-4 py-1.5 rounded text-sm hover:opacity-90 disabled:opacity-40"
        >
          {loading ? 'Analysing…' : 'Diagnose'}
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>}

      {result && (
        <div className="space-y-4">
          <div className="bg-white rounded shadow border p-4 space-y-3">
            <div>
              <div className="text-xs text-gray-500">{result.metric_label} for {result.campaign_name}</div>
              <div className="text-2xl font-semibold mt-0.5">
                {formatMetricValue(result.current_value, result.unit)}
              </div>
            </div>

            {result.signals.length > 0 && (
              <ul className="space-y-2">
                {result.signals.map((s, i) => (
                  <li
                    key={i}
                    className={`border-l-4 pl-3 py-1 text-sm ${
                      s.severity === 'high' ? 'border-l-red-500'
                      : s.severity === 'warn' ? 'border-l-amber-500'
                      : 'border-l-gray-300'
                    }`}
                  >
                    <div className="text-xs text-gray-600">{s.label}</div>
                    <div className="text-gray-900">{s.value}</div>
                    {s.note && <div className="text-xs text-gray-500 mt-0.5">{s.note}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {result.observations.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded p-3 space-y-1 text-sm">
              <div className="text-xs font-medium text-amber-900 uppercase tracking-wide">Likely cause</div>
              {result.observations.map((o, i) => <div key={i} className="text-amber-900">{o}</div>)}
            </div>
          )}

          {result.trend.length > 1 && (
            <TrendSparkline trend={result.trend} unit={result.unit} />
          )}

          {(result.contributors ?? []).map((c, i) => (
            <div key={i} className="bg-white rounded shadow border overflow-hidden">
              <div className="bg-gray-50 px-3 py-2 text-xs font-medium border-b">{c.label}</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-600 border-b">
                    <tr>
                      {c.columns.map((col, j) => (
                        <th key={j} className={`px-3 py-1.5 ${j === 0 ? 'text-left' : 'text-right'} font-medium`}>
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {c.rows.map((r, j) => (
                      <tr key={j} className="border-t">
                        <td className="px-3 py-1.5">{truncate(r.name, 50)}</td>
                        {c.columns.slice(1).map((col, k) => {
                          const v = renderCellValue(col, r);
                          return <td key={k} className="px-3 py-1.5 text-right text-gray-700">{v}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function renderCellValue(column: string, r: { metric: number; secondary?: Record<string, number | string> }): string {
  const sec = r.secondary ?? {};
  const c = column.toLowerCase();
  if (c.includes('match')) return String(sec.match_type ?? '—');
  if (c === 'qs') return sec.qs == null || sec.qs === 0 ? '—' : String(sec.qs);
  if (c.includes('spend')) return typeof sec.spend === 'number' ? fmtINR(sec.spend) : String(sec.spend ?? '—');
  if (c === 'impressions') return typeof sec.impressions === 'number' ? fmtNum(sec.impressions) : String(sec.impressions ?? '—');
  if (c === 'cpm' || c === 'cpc') return fmtINR(r.metric);
  if (c === 'ctr' || c === 'conv. rate' || c === 'conv rate') return fmtPct(r.metric);
  if (c.includes('roas')) return fmtMul(r.metric);
  if (c.includes('cpa')) return fmtINR(r.metric);
  if (typeof sec.ctr === 'number' && c === 'ctr') return fmtPct(sec.ctr);
  return fmtNum(r.metric);
}

function TrendSparkline({ trend, unit }: { trend: Array<{ date: string; value: number }>; unit: 'INR' | '%' | 'x' | 'count' }) {
  const max = Math.max(...trend.map((p) => p.value), 0.0001);
  const W = 600, H = 60;
  const stepX = trend.length > 1 ? W / (trend.length - 1) : 0;
  const points = trend.map((p, i) => {
    const y = H - (p.value / max) * (H - 4) - 2;
    return `${i * stepX},${y}`;
  }).join(' ');

  return (
    <div className="bg-white rounded shadow border p-3">
      <div className="text-xs text-gray-600 mb-2">Daily trend</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16">
        <polyline fill="none" stroke="rgb(59 130 246)" strokeWidth="2" points={points} />
      </svg>
      <div className="flex justify-between text-[10px] text-gray-500 mt-1">
        <span>{trend[0]?.date}</span>
        <span>{trend[trend.length - 1]?.date}</span>
      </div>
      <div className="text-xs text-gray-600 mt-1">
        Range: {formatMetricValue(Math.min(...trend.map((p) => p.value)), unit)} – {formatMetricValue(max, unit)}
      </div>
    </div>
  );
}
