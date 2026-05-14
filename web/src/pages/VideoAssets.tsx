import { useEffect, useMemo, useState } from 'react';
import { api, type VideoAssetRow } from '../lib/api';
import { fmtINR, fmtMul, fmtNum, fmtPct } from '../lib/format';

interface Props {
  brandId: number;
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
  campaignId?: string;
}

type SortKey = 'cost' | 'impressions' | 'clicks' | 'ctr' | 'cpc' | 'conversions' | 'roas';
type ChannelFilter = 'all' | 'PERFORMANCE_MAX' | 'DEMAND_GEN' | 'MULTI_CHANNEL' | 'VIDEO' | 'DISPLAY';
type LabelFilter = 'all' | 'BEST' | 'GOOD' | 'LOW' | 'PENDING' | 'UNKNOWN';

export function VideoAssets({ brandId, from, to, compareFrom, compareTo, campaignId }: Props) {
  const [rows, setRows] = useState<VideoAssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('cost');
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [labelFilter, setLabelFilter] = useState<LabelFilter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hideZeroSpend, setHideZeroSpend] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.videoAssets({
      brand_id: brandId, from, to,
      compare_from: compareFrom, compare_to: compareTo,
      campaign_id: campaignId,
    })
      .then((res) => { if (!cancelled) setRows(res.rows); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, from, to, compareFrom, compareTo, campaignId]);

  const channels = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.usages.forEach((u) => u.channel_type && s.add(u.channel_type)));
    return Array.from(s);
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (hideZeroSpend && !(r.metrics?.cost ?? 0)) return false;
        if (channelFilter !== 'all' && !r.usages.some((u) => u.channel_type === channelFilter)) return false;
        if (labelFilter !== 'all' && r.best_label !== labelFilter) return false;
        if (q) {
          const titleHit = r.title?.toLowerCase().includes(q);
          const idHit = r.youtube_video_id.toLowerCase().includes(q);
          const campHit = r.usages.some((u) => u.campaign_name?.toLowerCase().includes(q));
          if (!titleHit && !idHit && !campHit) return false;
        }
        return true;
      })
      .slice()
      .sort((a, b) => sortValue(b, sort) - sortValue(a, sort));
  }, [rows, search, channelFilter, labelFilter, sort, hideZeroSpend]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Loading video assets…</div>;
  if (error) return <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>;
  if (!rows.length) {
    return (
      <div className="text-sm text-gray-500 py-8 text-center bg-white rounded border">
        No YouTube video assets found in this window.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900">
        <strong>Note:</strong> Spend / impressions / clicks are attributed to each video asset across all campaigns it's used in.
        Conversions are only meaningful when the video came from Demand Gen / non-PMax campaigns —
        for PMax, Google attributes conversions at the asset-group level, not per asset (use the <strong>BEST/GOOD/LOW</strong> label as the per-asset quality signal).
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, video ID or campaign…"
          className="border rounded px-3 py-1.5 text-sm w-72"
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
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-700">Label:</span>
          {(['all', 'BEST', 'GOOD', 'LOW', 'PENDING', 'UNKNOWN'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLabelFilter(l)}
              className={`px-2 py-1 rounded ${labelFilter === l ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200'}`}
            >
              {l === 'all' ? 'All' : l}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-700">
          <input type="checkbox" checked={hideZeroSpend} onChange={(e) => setHideZeroSpend(e.target.checked)} />
          Hide zero spend
        </label>
        <span className="text-xs text-gray-500 ml-auto">{filtered.length} of {rows.length} videos</span>
      </div>

      <div className="bg-white rounded shadow border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-gray-600 border-b bg-gray-50">
            <tr>
              <th className="px-3 py-2 font-medium w-8"></th>
              <th className="px-3 py-2 font-medium">Video</th>
              <th className="px-3 py-2 font-medium text-center">Best label</th>
              <th className="px-3 py-2 font-medium text-center">Used in</th>
              <SortableHead label="Spend" sortKey="cost" active={sort} setSort={setSort} />
              <SortableHead label="Impr" sortKey="impressions" active={sort} setSort={setSort} />
              <SortableHead label="Clicks" sortKey="clicks" active={sort} setSort={setSort} />
              <SortableHead label="CTR" sortKey="ctr" active={sort} setSort={setSort} />
              <SortableHead label="CPC" sortKey="cpc" active={sort} setSort={setSort} />
              <SortableHead label="Conv*" sortKey="conversions" active={sort} setSort={setSort} />
              <SortableHead label="ROAS (RTO)" sortKey="roas" active={sort} setSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const isOpen = expanded.has(r.youtube_video_id);
              const m = r.metrics;
              const c = r.comparison;
              const thumb = `https://i.ytimg.com/vi/${r.youtube_video_id}/mqdefault.jpg`;
              return (
                <>
                  <tr key={r.youtube_video_id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <button
                        onClick={() => toggle(r.youtube_video_id)}
                        className="text-gray-500 hover:text-black w-6 h-6"
                        aria-label="Expand usages"
                      >
                        {isOpen ? '▾' : '▸'}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-3">
                        <a
                          href={`https://youtu.be/${r.youtube_video_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0"
                          title="Open on YouTube"
                        >
                          <img
                            src={thumb}
                            alt=""
                            className="h-12 w-20 object-cover rounded bg-gray-100"
                            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
                          />
                        </a>
                        <div className="min-w-0">
                          <div className="text-sm font-medium leading-snug line-clamp-2" title={r.title}>
                            {r.title || <span className="text-gray-400 italic">(no title)</span>}
                          </div>
                          <div className="text-[10px] text-gray-500 font-mono">{r.youtube_video_id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <PerfPill label={r.best_label} />
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      <button onClick={() => toggle(r.youtube_video_id)} className="text-blue-700 hover:underline">
                        {r.usage_count} {r.usage_count === 1 ? 'group' : 'groups'}
                      </button>
                    </td>
                    <Cell value={m?.cost} prev={c?.cost} fmt={fmtINR} betterIs="lower" deltaKind="pct" />
                    <Cell value={m?.impressions} prev={c?.impressions} fmt={fmtNum} betterIs="neutral" deltaKind="pct" />
                    <Cell value={m?.clicks} prev={c?.clicks} fmt={fmtNum} betterIs="higher" deltaKind="pct" />
                    <Cell value={m?.ctr} prev={c?.ctr} fmt={(n) => fmtPct(n, 1)} betterIs="higher" deltaKind="absolute" />
                    <Cell value={m?.cpc} prev={c?.cpc} fmt={fmtINR} betterIs="lower" deltaKind="pct" />
                    <Cell
                      value={m?.conversions}
                      prev={c?.conversions}
                      fmt={(n) => fmtNum(n, 0)}
                      betterIs={r.has_conversions_data ? 'higher' : 'neutral'}
                      deltaKind="pct"
                      faded={!r.has_conversions_data}
                    />
                    <Cell
                      value={m?.roas_post_rto}
                      prev={c?.roas_post_rto}
                      fmt={fmtMul}
                      betterIs={r.has_conversions_data ? 'higher' : 'neutral'}
                      deltaKind="absolute"
                      bold
                      faded={!r.has_conversions_data}
                    />
                  </tr>
                  {isOpen && (
                    <tr className="bg-gray-50">
                      <td colSpan={11} className="px-3 py-3">
                        <UsageList row={r} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-gray-500">
        * Conv shown for PMax usages is the asset-level attribution Google exposes (typically 0).
        Use the ROAS column primarily for Demand Gen / non-PMax video assets.
      </div>
    </div>
  );
}

function UsageList({ row }: { row: VideoAssetRow }) {
  return (
    <div className="bg-white rounded border">
      <table className="w-full text-xs">
        <thead className="text-gray-500 bg-gray-50 border-b">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Campaign</th>
            <th className="px-3 py-1.5 text-left font-medium">Group</th>
            <th className="px-3 py-1.5 text-center font-medium">Channel</th>
            <th className="px-3 py-1.5 text-center font-medium">Perf</th>
            <th className="px-3 py-1.5 text-right font-medium">Spend</th>
            <th className="px-3 py-1.5 text-right font-medium">Impr</th>
            <th className="px-3 py-1.5 text-right font-medium">Clicks</th>
            <th className="px-3 py-1.5 text-right font-medium">Conv</th>
          </tr>
        </thead>
        <tbody>
          {row.usages.map((u, i) => (
            <tr key={`${u.campaign_id}-${u.group_id}-${i}`} className="border-t">
              <td className="px-3 py-1 max-w-[260px] truncate" title={u.campaign_name}>{u.campaign_name ?? '—'}</td>
              <td className="px-3 py-1 max-w-[200px] truncate" title={u.group_name}>
                {u.group_name ?? '—'}
                <span className="ml-1 text-[10px] text-gray-400">({u.group_kind === 'asset_group' ? 'PMax' : 'DG'})</span>
              </td>
              <td className="px-3 py-1 text-center text-[10px] uppercase text-gray-500">
                {u.channel_type?.replace('_', ' ')}
              </td>
              <td className="px-3 py-1 text-center"><PerfPill label={u.performance_label} /></td>
              <td className="px-3 py-1 text-right">{fmtINR(u.cost)}</td>
              <td className="px-3 py-1 text-right">{fmtNum(u.impressions)}</td>
              <td className="px-3 py-1 text-right">{fmtNum(u.clicks)}</td>
              <td className="px-3 py-1 text-right">{u.group_kind === 'asset_group' ? <span className="text-gray-300">—</span> : fmtNum(u.conversions, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerfPill({ label }: { label?: string }) {
  if (!label) return <span className="text-gray-400">—</span>;
  const tone =
    label === 'BEST' ? 'bg-emerald-100 text-emerald-800'
    : label === 'GOOD' ? 'bg-blue-100 text-blue-800'
    : label === 'LOW' ? 'bg-red-100 text-red-800'
    : label === 'PENDING' ? 'bg-amber-100 text-amber-800'
    : 'bg-gray-100 text-gray-700';
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${tone}`}>{label}</span>;
}

function SortableHead({
  label, sortKey, active, setSort,
}: { label: string; sortKey: SortKey; active: SortKey; setSort: (k: SortKey) => void }) {
  return (
    <th className="px-3 py-2 font-medium text-right">
      <button
        onClick={() => setSort(sortKey)}
        className={`hover:text-black ${active === sortKey ? 'text-black' : 'text-gray-600'}`}
      >
        {label}{active === sortKey && ' ↓'}
      </button>
    </th>
  );
}

function sortValue(r: VideoAssetRow, key: SortKey): number {
  const m = r.metrics;
  if (!m) return 0;
  switch (key) {
    case 'cost': return m.cost ?? 0;
    case 'impressions': return m.impressions ?? 0;
    case 'clicks': return m.clicks ?? 0;
    case 'ctr': return m.ctr ?? 0;
    case 'cpc': return m.cpc ?? 0;
    case 'conversions': return m.conversions ?? 0;
    case 'roas': return m.roas_post_rto ?? 0;
  }
}

function Cell({ value, prev, fmt, betterIs, deltaKind, bold, faded }: {
  value: number | null | undefined;
  prev: number | null | undefined;
  fmt: (n: number) => string;
  betterIs: 'higher' | 'lower' | 'neutral';
  deltaKind: 'pct' | 'absolute';
  bold?: boolean;
  faded?: boolean;
}) {
  if (value == null || !Number.isFinite(value)) {
    return <td className="px-3 py-2 text-right text-gray-400">—</td>;
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
    <td className={`px-3 py-2 text-right ${faded ? 'text-gray-400' : ''}`}>
      <div className={bold ? 'font-medium' : ''}>{fmt(v)}</div>
      {hasCompare && <div className={`text-[10px] ${toneClass}`}>{deltaStr}</div>}
    </td>
  );
}
