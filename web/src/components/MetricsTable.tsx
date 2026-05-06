import { useMemo, useState } from 'react';
import type { PerfRow } from '../lib/api';
import { deltaTone, fmtDelta, fmtINR, fmtMul, fmtNum, fmtPct, truncate } from '../lib/format';

export type TableLevel = 'campaign' | 'ad_group' | 'ad' | 'keyword' | 'search_term';

export type RowAction =
  | { kind: 'pause' | 'enable'; level: 'campaign' | 'ad_group' | 'ad' | 'keyword'; row: PerfRow }
  | { kind: 'update_budget'; row: PerfRow }
  | { kind: 'add_negative'; row: PerfRow }; // for search terms

interface Props {
  level: TableLevel;
  rows: PerfRow[];
  hasCompare: boolean;
  onDrillIn?: (row: PerfRow) => void;
  onAction?: (action: RowAction) => void;
}

type SortKey =
  | 'name' | 'cost' | 'impressions' | 'clicks' | 'ctr' | 'cpc' | 'cpm'
  | 'conversions' | 'cpa' | 'roas_post_rto' | 'quality_score';

function nameOf(r: PerfRow, level: TableLevel): string {
  if (level === 'campaign') return r.campaign_name ?? '—';
  if (level === 'ad_group') return r.ad_group_name ?? '—';
  if (level === 'ad') return r.ad_name || (r.headlines?.[0] ?? '—');
  if (level === 'keyword') return r.keyword_text ?? '—';
  return r.search_term ?? '—';
}

export function MetricsTable({ level, rows, hasCompare, onDrillIn, onAction }: Props) {
  const [sortBy, setSortBy] = useState<SortKey>('cost');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter] = useState('');
  const [openActionsFor, setOpenActionsFor] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const filtered = filter
      ? rows.filter((r) => nameOf(r, level).toLowerCase().includes(filter.toLowerCase()))
      : rows;
    return [...filtered].sort((a, b) => {
      let va: string | number;
      let vb: string | number;
      if (sortBy === 'name') { va = nameOf(a, level); vb = nameOf(b, level); }
      else if (sortBy === 'quality_score') { va = a.quality_score ?? 0; vb = b.quality_score ?? 0; }
      else {
        va = (a.metrics as unknown as Record<string, number>)[sortBy] ?? 0;
        vb = (b.metrics as unknown as Record<string, number>)[sortBy] ?? 0;
      }
      const cmp = typeof va === 'string' && typeof vb === 'string'
        ? va.localeCompare(vb)
        : (va as number) - (vb as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sortBy, sortDir, filter, level]);

  function toggleSort(key: SortKey): void {
    if (key === sortBy) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(key); setSortDir('desc'); }
  }

  function header(label: string, key: SortKey, align: 'left' | 'right' = 'left') {
    const active = sortBy === key;
    return (
      <th
        className={`px-3 py-2 font-medium cursor-pointer select-none ${
          align === 'right' ? 'text-right' : 'text-left'
        } ${active ? 'text-black' : 'text-gray-600'}`}
        onClick={() => toggleSort(key)}
      >
        {label}{active && (sortDir === 'asc' ? ' ↑' : ' ↓')}
      </th>
    );
  }

  const titleCol =
    level === 'campaign' ? 'Campaign'
    : level === 'ad_group' ? 'Ad Group'
    : level === 'ad' ? 'Ad'
    : level === 'keyword' ? 'Keyword'
    : 'Search Term';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${titleCol.toLowerCase()}…`}
          className="border rounded px-3 py-1.5 text-sm w-64"
        />
        <span className="text-xs text-gray-500">{sorted.length} rows</span>
      </div>

      <div className="bg-white rounded shadow border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              {header(titleCol, 'name')}
              {level === 'campaign' && <th className="px-3 py-2 font-medium text-gray-600">Type</th>}
              {(level === 'keyword' || level === 'search_term') && (
                <th className="px-3 py-2 font-medium text-gray-600">Match</th>
              )}
              {level === 'keyword' && header('QS', 'quality_score', 'right')}
              <th className="px-3 py-2 font-medium text-gray-600">Status</th>
              {header('Spend', 'cost', 'right')}
              {header('Impr', 'impressions', 'right')}
              {header('Clicks', 'clicks', 'right')}
              {header('CTR', 'ctr', 'right')}
              {header('CPC', 'cpc', 'right')}
              {header('CPM', 'cpm', 'right')}
              {header('Conv', 'conversions', 'right')}
              {header('CPA', 'cpa', 'right')}
              {header('ROAS (RTO)', 'roas_post_rto', 'right')}
              {hasCompare && <th className="px-3 py-2 font-medium text-right text-gray-600">Δ Spend</th>}
              {hasCompare && <th className="px-3 py-2 font-medium text-right text-gray-600">Δ ROAS</th>}
              {onAction && <th className="px-3 py-2 font-medium text-right text-gray-600">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const m = r.metrics;
              const c = r.comparison;
              const name = nameOf(r, level);
              const rowKey = `${r.customer_id}|${r.campaign_id}|${r.ad_group_id ?? ''}|${r.ad_id ?? r.criterion_id ?? r.search_term ?? ''}`;
              return (
                <tr key={rowKey} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-2">
                    {onDrillIn ? (
                      <button onClick={() => onDrillIn(r)} className="text-left hover:underline text-blue-700">
                        {truncate(name, 60)}
                      </button>
                    ) : (
                      <span title={name}>{truncate(name, 60)}</span>
                    )}
                  </td>
                  {level === 'campaign' && <td className="px-3 py-2 text-xs text-gray-600">{r.channel_type ?? '—'}</td>}
                  {(level === 'keyword' || level === 'search_term') && (
                    <td className="px-3 py-2 text-xs text-gray-600">{r.match_type ?? '—'}</td>
                  )}
                  {level === 'keyword' && (
                    <td className="px-3 py-2 text-right">
                      {r.quality_score != null ? <QsPill qs={r.quality_score} /> : <span className="text-gray-400">—</span>}
                    </td>
                  )}
                  <td className="px-3 py-2 text-xs"><StatusPill status={r.status} /></td>
                  <td className="px-3 py-2 text-right">{fmtINR(m.cost)}</td>
                  <td className="px-3 py-2 text-right">{fmtNum(m.impressions)}</td>
                  <td className="px-3 py-2 text-right">{fmtNum(m.clicks)}</td>
                  <td className="px-3 py-2 text-right">{fmtPct(m.ctr)}</td>
                  <td className="px-3 py-2 text-right">{fmtINR(m.cpc)}</td>
                  <td className="px-3 py-2 text-right">{fmtINR(m.cpm)}</td>
                  <td className="px-3 py-2 text-right">{fmtNum(m.conversions, 0)}</td>
                  <td className="px-3 py-2 text-right">{fmtINR(m.cpa)}</td>
                  <td className="px-3 py-2 text-right font-medium">{fmtMul(m.roas_post_rto)}</td>
                  {hasCompare && (
                    <td className={`px-3 py-2 text-right ${deltaTone(m.cost, c?.cost, false)}`}>
                      {fmtDelta(m.cost, c?.cost, 'pct')}
                    </td>
                  )}
                  {hasCompare && (
                    <td className={`px-3 py-2 text-right ${deltaTone(m.roas_post_rto, c?.roas_post_rto, true)}`}>
                      {fmtDelta(m.roas_post_rto, c?.roas_post_rto, 'absolute')}
                    </td>
                  )}
                  {onAction && (
                    <td className="px-3 py-2 text-right relative">
                      <button
                        onClick={() => setOpenActionsFor(openActionsFor === rowKey ? null : rowKey)}
                        className="text-gray-500 hover:text-black px-2 py-1 rounded hover:bg-gray-100 text-xs"
                      >
                        ⋯
                      </button>
                      {openActionsFor === rowKey && (
                        <div className="absolute right-2 top-9 bg-white border rounded shadow-lg z-20 min-w-[180px] py-1 text-left">
                          {(level === 'campaign' || level === 'ad_group' || level === 'ad' || level === 'keyword') && (
                            <>
                              {r.status !== 'PAUSED' && (
                                <ActionButton onClick={() => { setOpenActionsFor(null); onAction({ kind: 'pause', level: level as 'campaign' | 'ad_group' | 'ad' | 'keyword', row: r }); }}>
                                  Pause
                                </ActionButton>
                              )}
                              {r.status !== 'ENABLED' && (
                                <ActionButton onClick={() => { setOpenActionsFor(null); onAction({ kind: 'enable', level: level as 'campaign' | 'ad_group' | 'ad' | 'keyword', row: r }); }}>
                                  Enable
                                </ActionButton>
                              )}
                            </>
                          )}
                          {level === 'campaign' && (
                            <ActionButton onClick={() => { setOpenActionsFor(null); onAction({ kind: 'update_budget', row: r }); }}>
                              Update budget…
                            </ActionButton>
                          )}
                          {level === 'search_term' && (
                            <ActionButton onClick={() => { setOpenActionsFor(null); onAction({ kind: 'add_negative', row: r }); }}>
                              Add as negative…
                            </ActionButton>
                          )}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {!sorted.length && (
              <tr>
                <td colSpan={20} className="px-3 py-8 text-center text-sm text-gray-500">
                  No data for the selected range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50">
      {children}
    </button>
  );
}

function StatusPill({ status }: { status?: string }) {
  if (!status) return <span className="text-gray-400">—</span>;
  const s = status.toUpperCase();
  const color =
    s === 'ENABLED' ? 'bg-emerald-100 text-emerald-800'
    : s === 'PAUSED' ? 'bg-amber-100 text-amber-800'
    : s === 'REMOVED' ? 'bg-gray-200 text-gray-600'
    : s === 'ADDED' || s === 'NONE' ? 'bg-blue-100 text-blue-800'
    : 'bg-gray-100 text-gray-700';
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${color}`}>{s}</span>;
}

function QsPill({ qs }: { qs: number }) {
  const tone = qs >= 7 ? 'bg-emerald-100 text-emerald-800' : qs >= 4 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800';
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${tone}`}>{qs}</span>;
}
