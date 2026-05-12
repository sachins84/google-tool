import { useEffect, useMemo, useState } from 'react';
import { api, type AudienceRow } from '../lib/api';
import { fmtINR, fmtMul, fmtNum } from '../lib/format';

interface Props {
  brandId: number;
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
  campaignId?: string;
}

type SortKey = 'cost' | 'impressions' | 'clicks' | 'conversions' | 'roas';
type ChannelFilter = 'all' | 'SEARCH' | 'PERFORMANCE_MAX' | 'DEMAND_GEN' | 'DISPLAY' | 'SHOPPING' | 'VIDEO';

export function Audiences({ brandId, from, to, compareFrom, compareTo, campaignId }: Props) {
  const [rows, setRows] = useState<AudienceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('cost');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.audiences({
      brand_id: brandId, from, to,
      compare_from: compareFrom, compare_to: compareTo,
      campaign_id: campaignId,
    })
      .then((res) => { if (!cancelled) setRows(res.rows); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, from, to, compareFrom, compareTo, campaignId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => channelFilter === 'all' || r.channel_type === channelFilter)
      .filter((r) => !q
        || (r.audience_label?.toLowerCase().includes(q) ?? false)
        || (r.campaign_name?.toLowerCase().includes(q) ?? false))
      .slice()
      .sort((a, b) => {
        const av = sortValue(a, sort);
        const bv = sortValue(b, sort);
        return bv - av;
      });
  }, [rows, channelFilter, search, sort]);

  const channels = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.channel_type && s.add(r.channel_type));
    return Array.from(s);
  }, [rows]);

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Loading audiences…</div>;
  if (error) return <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>;
  if (!rows.length) {
    return (
      <div className="text-sm text-gray-500 py-8 text-center bg-white rounded border">
        No audience criteria with performance in this window.
        <div className="text-xs text-gray-400 mt-1">
          Audience segments are reported for campaigns that have observed or targeted audience criteria (mostly Search, Demand Gen, Display).
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search audience or campaign…"
          className="border rounded px-3 py-1.5 text-sm w-64"
        />
        <select
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value as ChannelFilter)}
          className="border rounded px-3 py-1.5 text-sm"
        >
          <option value="all">All channels</option>
          {channels.map((c) => (
            <option key={c} value={c}>{c.replace('_', ' ')}</option>
          ))}
        </select>
        <span className="text-xs text-gray-500 ml-auto">
          {filtered.length} of {rows.length} audiences
        </span>
      </div>

      <div className="bg-white rounded shadow border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-gray-600 border-b bg-gray-50">
            <tr>
              <th className="px-4 py-2 font-medium">Audience</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Campaign</th>
              <SortableHead label="Spend" sortKey="cost" active={sort} setSort={setSort} />
              <SortableHead label="Impr" sortKey="impressions" active={sort} setSort={setSort} />
              <SortableHead label="Clicks" sortKey="clicks" active={sort} setSort={setSort} />
              <SortableHead label="Conv" sortKey="conversions" active={sort} setSort={setSort} />
              <th className="px-4 py-2 font-medium text-right">Conv. value</th>
              <SortableHead label="ROAS (RTO)" sortKey="roas" active={sort} setSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const m = r.metrics;
              const c = r.comparison;
              const key = `${r.customer_id}|${r.campaign_id}|${r.criterion_id}`;
              return (
                <tr key={key} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-1.5">
                    <div className="text-sm">{r.audience_label || '—'}</div>
                  </td>
                  <td className="px-4 py-1.5 text-xs text-gray-600">{r.audience_type ?? '—'}</td>
                  <td className="px-4 py-1.5">
                    <div className="text-xs truncate max-w-[260px]" title={r.campaign_name}>{r.campaign_name ?? '—'}</div>
                    {r.channel_type && (
                      <div className="text-[10px] uppercase text-gray-400">{r.channel_type.replace('_', ' ')}</div>
                    )}
                  </td>
                  <Cell value={m?.cost} prev={c?.cost} fmt={fmtINR} betterIs="lower" deltaKind="pct" />
                  <Cell value={m?.impressions} prev={c?.impressions} fmt={fmtNum} betterIs="neutral" deltaKind="pct" />
                  <Cell value={m?.clicks} prev={c?.clicks} fmt={fmtNum} betterIs="higher" deltaKind="pct" />
                  <Cell value={m?.conversions} prev={c?.conversions} fmt={(n) => fmtNum(n, 0)} betterIs="higher" deltaKind="pct" />
                  <Cell value={m?.conversions_value_post_rto} prev={c?.conversions_value_post_rto} fmt={fmtINR} betterIs="higher" deltaKind="pct" />
                  <Cell value={m?.roas_post_rto} prev={c?.roas_post_rto} fmt={fmtMul} betterIs="higher" deltaKind="absolute" bold />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sortValue(r: AudienceRow, key: SortKey): number {
  const m = r.metrics;
  if (!m) return 0;
  switch (key) {
    case 'cost': return m.cost ?? 0;
    case 'impressions': return m.impressions ?? 0;
    case 'clicks': return m.clicks ?? 0;
    case 'conversions': return m.conversions ?? 0;
    case 'roas': return m.roas_post_rto ?? 0;
  }
}

function SortableHead({
  label, sortKey, active, setSort,
}: { label: string; sortKey: SortKey; active: SortKey; setSort: (k: SortKey) => void }) {
  return (
    <th className="px-4 py-2 font-medium text-right">
      <button
        onClick={() => setSort(sortKey)}
        className={`hover:text-black ${active === sortKey ? 'text-black' : 'text-gray-600'}`}
      >
        {label}{active === sortKey && ' ↓'}
      </button>
    </th>
  );
}

function Cell({ value, prev, fmt, betterIs, deltaKind, bold }: {
  value: number | null | undefined;
  prev: number | null | undefined;
  fmt: (n: number) => string;
  betterIs: 'higher' | 'lower' | 'neutral';
  deltaKind: 'pct' | 'absolute';
  bold?: boolean;
}) {
  if (value == null || !Number.isFinite(value)) {
    return <td className="px-4 py-1.5 text-right text-gray-400">—</td>;
  }
  const v = value;
  const hasCompare = prev != null && Number.isFinite(prev);
  let deltaStr = '';
  let toneClass = 'text-gray-400';
  if (hasCompare) {
    if (deltaKind === 'pct') {
      if (prev === 0) deltaStr = v === 0 ? '—' : '+∞%';
      else {
        const pct = (v - (prev as number)) / (prev as number);
        deltaStr = `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(0)}%`;
        if (betterIs !== 'neutral') {
          const better = betterIs === 'higher' ? pct > 0 : pct < 0;
          toneClass = better ? 'text-emerald-600' : pct === 0 ? 'text-gray-400' : 'text-red-600';
        }
      }
    } else {
      const d = v - (prev as number);
      deltaStr = `${d >= 0 ? '+' : ''}${d.toFixed(2)}`;
      if (betterIs !== 'neutral') {
        const better = betterIs === 'higher' ? d > 0 : d < 0;
        toneClass = better ? 'text-emerald-600' : d === 0 ? 'text-gray-400' : 'text-red-600';
      }
    }
  }
  return (
    <td className="px-4 py-1.5 text-right">
      <div className={bold ? 'font-medium' : ''}>{fmt(v)}</div>
      {hasCompare && <div className={`text-[10px] ${toneClass}`}>{deltaStr}</div>}
    </td>
  );
}
