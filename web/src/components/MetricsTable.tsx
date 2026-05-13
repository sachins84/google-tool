import { useMemo, useState } from 'react';
import type { PerfRow, DerivedMetrics } from '../lib/api';
import { fmtINR, fmtMul, fmtNum, fmtPct, truncate } from '../lib/format';
import { METRIC_COLUMNS, type MetricColumn } from '../lib/metricColumns';

export type TableLevel = 'campaign' | 'ad_group' | 'asset_group' | 'ad' | 'keyword' | 'search_term';

export type RowAction =
  | { kind: 'pause' | 'enable'; level: 'campaign' | 'ad_group' | 'asset_group' | 'ad' | 'keyword'; row: PerfRow }
  | { kind: 'update_budget'; row: PerfRow }
  | { kind: 'add_negative'; row: PerfRow } // for search terms / keywords
  | { kind: 'add_keyword'; row: PerfRow } // synthesized from drill state
  | { kind: 'edit_campaign'; row: PerfRow }; // edit settings (name, dates, bid targets)

interface Props {
  level: TableLevel;
  rows: PerfRow[];
  hasCompare: boolean;
  showCalcMetrics?: boolean; // true when at least one row has Redshift NCs attached
  visibleMetrics?: Set<string>; // which metric columns to render; defaults to all .default columns
  onDrillIn?: (row: PerfRow) => void;
  onAction?: (action: RowAction) => void;
}

type SortKey = 'name' | 'quality_score' | keyof DerivedMetrics;

function fmtFor(kind: MetricColumn['fmt']): (n: number) => string {
  switch (kind) {
    case 'INR': return fmtINR;
    case 'NUM': return (n: number) => fmtNum(n);
    case 'NUM0': return (n: number) => fmtNum(n, 0);
    case 'PCT': return (n: number) => fmtPct(n, 1);
    case 'MUL': return fmtMul;
  }
}

function nameOf(r: PerfRow, level: TableLevel): string {
  if (level === 'campaign') return r.campaign_name ?? '—';
  if (level === 'ad_group') return r.ad_group_name ?? '—';
  if (level === 'asset_group') return r.asset_group_name ?? '—';
  if (level === 'ad') return r.ad_name || (r.headlines?.[0] ?? '—');
  if (level === 'keyword') return r.keyword_text ?? '—';
  return r.search_term ?? '—';
}

export function MetricsTable({ level, rows, hasCompare, showCalcMetrics = false, visibleMetrics, onDrillIn, onAction }: Props) {
  const [sortBy, setSortBy] = useState<SortKey>('cost');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter] = useState('');
  const [openActionsFor, setOpenActionsFor] = useState<string | null>(null);

  const cols = useMemo(() => {
    const set = visibleMetrics ?? new Set(METRIC_COLUMNS.filter((c) => c.default).map((c) => c.key as string));
    return METRIC_COLUMNS.filter((c) => {
      if (!set.has(c.key as string)) return false;
      if (c.calcOnly && !showCalcMetrics) return false;
      return true;
    });
  }, [visibleMetrics, showCalcMetrics]);

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
    : level === 'asset_group' ? 'Asset Group'
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
              {level === 'asset_group' && <th className="px-3 py-2 font-medium text-gray-600">Strength</th>}
              {level === 'asset_group' && <th className="px-3 py-2 font-medium text-gray-600">Theme</th>}
              {(level === 'keyword' || level === 'search_term') && (
                <th className="px-3 py-2 font-medium text-gray-600">Match</th>
              )}
              {level === 'keyword' && header('QS', 'quality_score', 'right')}
              <th className="px-3 py-2 font-medium text-gray-600">Status</th>
              {cols.map((col) => (
                <th
                  key={col.key as string}
                  className={`px-3 py-2 font-medium cursor-pointer select-none text-right ${
                    sortBy === col.key ? 'text-black' : 'text-gray-600'
                  }`}
                  onClick={() => toggleSort(col.key as SortKey)}
                  title={col.longLabel}
                >
                  {col.label}{sortBy === col.key && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                </th>
              ))}
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
                <tr key={rowKey} className={`border-t hover:bg-gray-50 ${r.synthetic ? 'bg-amber-50/50 italic' : ''}`}>
                  <td className="px-3 py-2">
                    {r.synthetic ? (
                      <span
                        className="text-amber-800"
                        title={
                          r.synthetic_samples && r.synthetic_samples.length
                            ? `Residual NCs from utm_campaigns that don't map to any Google Ads campaign. Examples: ${r.synthetic_samples.join(', ')}`
                            : 'Residual NCs not attributable to any Google Ads campaign'
                        }
                      >
                        {truncate(name, 60)}
                      </span>
                    ) : onDrillIn ? (
                      <button onClick={() => onDrillIn(r)} className="text-left hover:underline text-blue-700">
                        {truncate(name, 60)}
                      </button>
                    ) : (
                      <span title={name}>{truncate(name, 60)}</span>
                    )}
                  </td>
                  {level === 'campaign' && <td className="px-3 py-2 text-xs text-gray-600">{r.channel_type ?? '—'}</td>}
                  {level === 'asset_group' && (
                    <td className="px-3 py-2"><StrengthPill strength={r.ad_strength} /></td>
                  )}
                  {level === 'asset_group' && (
                    <td className="px-3 py-2 text-xs text-gray-600 max-w-[200px] truncate" title={(r.final_urls ?? []).join(', ')}>
                      {(r.path1 || r.path2)
                        ? `/${r.path1 ?? ''}${r.path2 ? '/' + r.path2 : ''}`
                        : (r.final_urls?.[0] ?? '—')}
                    </td>
                  )}
                  {(level === 'keyword' || level === 'search_term') && (
                    <td className="px-3 py-2 text-xs text-gray-600">{r.match_type ?? '—'}</td>
                  )}
                  {level === 'keyword' && (
                    <td className="px-3 py-2 text-right">
                      {r.quality_score != null ? <QsPill qs={r.quality_score} /> : <span className="text-gray-400">—</span>}
                    </td>
                  )}
                  <td className="px-3 py-2 text-xs"><StatusPill status={r.status} /></td>
                  {cols.map((col) => {
                    const v = (m as unknown as Record<string, number | null | undefined>)[col.key as string];
                    const p = (c as unknown as Record<string, number | null | undefined> | undefined)?.[col.key as string];
                    return (
                      <MetricCell
                        key={col.key as string}
                        value={v}
                        prev={p ?? null}
                        fmt={fmtFor(col.fmt)}
                        betterIs={col.betterIs}
                        deltaKind={col.deltaKind}
                        hasCompare={hasCompare}
                        bold={col.bold}
                        nullable={col.nullable}
                        className={col.key === 'calc_roas' ? 'text-emerald-700' : undefined}
                      />
                    );
                  })}
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
                          {(level === 'campaign' || level === 'ad_group' || level === 'asset_group' || level === 'ad' || level === 'keyword') && (
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
                          {level === 'campaign' && (
                            <ActionButton onClick={() => { setOpenActionsFor(null); onAction({ kind: 'edit_campaign', row: r }); }}>
                              Edit settings…
                            </ActionButton>
                          )}
                          {level === 'search_term' && (
                            <ActionButton onClick={() => { setOpenActionsFor(null); onAction({ kind: 'add_negative', row: r }); }}>
                              Add as negative…
                            </ActionButton>
                          )}
                          {level === 'keyword' && (
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
    : s === 'ADDED' ? 'bg-blue-100 text-blue-800'
    : s === 'NONE' ? 'bg-gray-100 text-gray-700'
    : s === 'EXCLUDED' ? 'bg-red-100 text-red-800'
    : 'bg-gray-100 text-gray-700';
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${color}`}>{s}</span>;
}

function QsPill({ qs }: { qs: number }) {
  const tone = qs >= 7 ? 'bg-emerald-100 text-emerald-800' : qs >= 4 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800';
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${tone}`}>{qs}</span>;
}

interface MetricCellProps {
  value: number | null | undefined;
  prev: number | null | undefined;
  fmt: (n: number) => string;
  betterIs: 'higher' | 'lower' | 'neutral';
  deltaKind: 'pct' | 'absolute';
  hasCompare: boolean;
  bold?: boolean;
  nullable?: boolean;
  className?: string;
}

function MetricCell({ value, prev, fmt, betterIs, deltaKind, hasCompare, bold, nullable, className }: MetricCellProps) {
  if (nullable && (value == null || !Number.isFinite(value))) {
    return <td className="px-3 py-2 text-right text-gray-400">—</td>;
  }
  const v = (value ?? 0) as number;
  const p = (prev ?? null) as number | null;
  const showDelta = hasCompare && p != null && Number.isFinite(p);

  let deltaStr = '';
  let toneClass = 'text-gray-400';
  if (showDelta) {
    if (deltaKind === 'pct') {
      if (p === 0) {
        deltaStr = v === 0 ? '—' : '+∞%';
      } else {
        const pct = (v - p) / p;
        deltaStr = `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(0)}%`;
        if (betterIs !== 'neutral') {
          const better = betterIs === 'higher' ? pct > 0 : pct < 0;
          toneClass = better ? 'text-emerald-600' : pct === 0 ? 'text-gray-400' : 'text-red-600';
        }
      }
    } else {
      const d = v - p;
      deltaStr = `${d >= 0 ? '+' : ''}${d.toFixed(2)}`;
      if (betterIs !== 'neutral') {
        const better = betterIs === 'higher' ? d > 0 : d < 0;
        toneClass = better ? 'text-emerald-600' : d === 0 ? 'text-gray-400' : 'text-red-600';
      }
    }
  }

  return (
    <td className={`px-3 py-2 text-right ${className ?? ''}`}>
      <div className={bold ? 'font-medium' : ''}>{fmt(v)}</div>
      {showDelta && <div className={`text-[10px] ${toneClass}`}>{deltaStr}</div>}
    </td>
  );
}

function StrengthPill({ strength }: { strength?: string }) {
  if (!strength) return <span className="text-gray-400">—</span>;
  const s = strength.toUpperCase();
  const tone =
    s === 'EXCELLENT' ? 'bg-emerald-100 text-emerald-800'
    : s === 'GOOD' ? 'bg-blue-100 text-blue-800'
    : s === 'AVERAGE' ? 'bg-amber-100 text-amber-800'
    : s === 'POOR' ? 'bg-red-100 text-red-800'
    : s === 'NO_ADS' ? 'bg-red-200 text-red-900'
    : 'bg-gray-100 text-gray-700';
  const label = s === 'AD_STRENGTH_UNSPECIFIED' || s === 'UNKNOWN' ? '—' : s;
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${tone}`}>{label}</span>;
}
