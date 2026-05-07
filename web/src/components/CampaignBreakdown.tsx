import { useEffect, useState } from 'react';
import { api, type CampaignBreakdown } from '../lib/api';
import { fmtINR, fmtNum, truncate } from '../lib/format';

interface Props {
  brandId: number;
  campaignId: string;
  customerId?: string;
  from: string;
  to: string;
}

export function CampaignBreakdownPanel({ brandId, campaignId, customerId, from, to }: Props) {
  const [data, setData] = useState<CampaignBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.campaignBreakdown({ brand_id: brandId, campaign_id: campaignId, customer_id: customerId, from, to })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, campaignId, customerId, from, to]);

  if (loading) return <div className="text-xs text-gray-500">Loading breakdown…</div>;
  if (error) return <div className="bg-red-50 border border-red-200 text-red-800 rounded p-2 text-xs">{error}</div>;
  if (!data) return null;

  const totalSpend = data.by_device.reduce((a, e) => a + e.cost, 0);

  return (
    <div className="bg-white rounded shadow border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Campaign breakdown</div>
          <div className="text-xs text-gray-500">{data.channel_type} • {fmtINR(totalSpend)} total</div>
        </div>
      </div>

      {data.notes.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs space-y-1">
          {data.notes.map((n, i) => <div key={i} className="text-amber-900">{n}</div>)}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-700 uppercase tracking-wide">By device</div>
          <SplitList entries={data.by_device.map((e) => ({ label: e.device, cost: e.cost, sub: `${fmtNum(e.clicks)} clicks` }))} total={totalSpend} />
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-700 uppercase tracking-wide">
            {data.pmax_channel_split && data.pmax_channel_split.length > 0 ? 'By channel (PMax)' : 'By network'}
          </div>
          {data.pmax_channel_split && data.pmax_channel_split.length > 0 ? (
            <SplitList
              entries={data.pmax_channel_split.map((e) => ({
                label: e.channel,
                cost: e.cost,
                sub: `${fmtNum(e.clicks)} clicks · ${fmtNum(e.conversions, 0)} conv`,
              }))}
              total={data.pmax_channel_split.reduce((a, e) => a + e.cost, 0)}
            />
          ) : data.network_breakdown_available ? (
            <SplitList entries={data.by_network.map((e) => ({ label: e.network, cost: e.cost, sub: `${fmtNum(e.clicks)} clicks` }))} total={totalSpend} />
          ) : (
            <div className="text-xs text-gray-500 italic">
              No channel attribution data for this PMax campaign in this window.
            </div>
          )}
        </div>
      </div>

      {data.pmax_top_placements && data.pmax_top_placements.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-700 uppercase tracking-wide">
            PMax YouTube placements (top 25 by impressions)
          </div>
          <div className="text-xs text-gray-500">
            {(data.pmax_total_impr ?? 0).toLocaleString('en-IN')} total impressions on YouTube — cost not exposed by Google's API for PMax.
            {' '}Use this list to identify low-quality channels and add them as account-level negatives.
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-gray-600">
                <tr>
                  <th className="px-2 py-1">Type</th>
                  <th className="px-2 py-1">Channel / Video</th>
                  <th className="px-2 py-1 text-right">Impressions</th>
                </tr>
              </thead>
              <tbody>
                {data.pmax_top_placements.map((p, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1 text-gray-600">{p.placement_type}</td>
                    <td className="px-2 py-1">
                      {p.target_url ? (
                        <a href={p.target_url} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">
                          {truncate(p.display_name ?? p.target_url, 70)}
                        </a>
                      ) : (
                        truncate(p.display_name ?? p.placement ?? '—', 70)
                      )}
                    </td>
                    <td className="px-2 py-1 text-right">{fmtNum(p.impressions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.placements.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-700 uppercase tracking-wide">Top 25 placements</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-gray-600">
                <tr>
                  <th className="px-2 py-1">Type</th>
                  <th className="px-2 py-1">Placement</th>
                  <th className="px-2 py-1 text-right">Spend</th>
                  <th className="px-2 py-1 text-right">Impr</th>
                  <th className="px-2 py-1 text-right">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {data.placements.map((p, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1 text-gray-600">{p.placement_type}</td>
                    <td className="px-2 py-1">
                      {p.target_url ? (
                        <a href={p.target_url} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">
                          {truncate(p.display_name ?? p.target_url, 60)}
                        </a>
                      ) : (
                        truncate(p.display_name ?? '—', 60)
                      )}
                    </td>
                    <td className="px-2 py-1 text-right">{fmtINR(p.cost)}</td>
                    <td className="px-2 py-1 text-right">{fmtNum(p.impressions)}</td>
                    <td className="px-2 py-1 text-right">{fmtNum(p.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

interface SplitEntry { label: string; cost: number; sub?: string; }

function SplitList({ entries, total }: { entries: SplitEntry[]; total: number }) {
  if (!entries.length) return <div className="text-xs text-gray-500">No data</div>;
  const max = Math.max(...entries.map((e) => e.cost), 1);
  return (
    <ul className="space-y-1.5">
      {entries.map((e) => {
        const pct = total ? (e.cost / total) * 100 : 0;
        const widthPct = (e.cost / max) * 100;
        return (
          <li key={e.label} className="text-xs">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-gray-800">{e.label}</span>
              <span className="text-gray-700">{fmtINR(e.cost)} <span className="text-gray-500">({pct.toFixed(0)}%)</span></span>
            </div>
            <div className="h-1.5 rounded bg-gray-100 overflow-hidden">
              <div className="h-full bg-blue-500" style={{ width: `${widthPct}%` }} />
            </div>
            {e.sub && <div className="text-gray-500 mt-0.5">{e.sub}</div>}
          </li>
        );
      })}
    </ul>
  );
}
