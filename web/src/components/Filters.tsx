import type { PerfRow } from '../lib/api';

export type StatusFilter = 'enabled' | 'paused' | 'all';

// Search-term status is unrelated to enabled/paused — it tracks whether the term
// has been added as a keyword/negative. Filter values: 'none' = show only queries
// that haven't been actioned (most actionable). 'all' = show everything.
export type SearchTermStatusFilter = 'none' | 'added' | 'excluded' | 'all';

export interface FilterState {
  status: StatusFilter;
  searchTermStatus: SearchTermStatusFilter;
  channelTypes: Set<string>; // empty = all
  hideZeroSpend: boolean;
}

const ALL_CHANNEL_TYPES = [
  'SEARCH',
  'PERFORMANCE_MAX',
  'SHOPPING',
  'DISPLAY',
  'VIDEO',
  'DEMAND_GEN',
  'DISCOVERY',
] as const;

interface Props {
  state: FilterState;
  onChange: (s: FilterState) => void;
  showChannelType: boolean;
  isSearchTerms?: boolean; // search terms use a different status concept
  rows: PerfRow[]; // used to count available channel types
}

export function Filters({ state, onChange, showChannelType, isSearchTerms = false, rows }: Props) {
  const presentTypes = new Set<string>();
  for (const r of rows) if (r.channel_type) presentTypes.add(r.channel_type);

  function toggleType(t: string) {
    const next = new Set(state.channelTypes);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    onChange({ ...state, channelTypes: next });
  }

  return (
    <div className="flex items-center gap-3 flex-wrap text-sm">
      {isSearchTerms ? (
        <>
          <span className="text-xs text-gray-500">Status:</span>
          {(['none', 'added', 'excluded', 'all'] as SearchTermStatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => onChange({ ...state, searchTermStatus: s })}
              className={`px-2.5 py-1 rounded text-xs ${
                state.searchTermStatus === s ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200'
              }`}
              title={
                s === 'none' ? 'Queries you haven\'t actioned yet — most actionable'
                : s === 'added' ? 'Already added as a keyword'
                : s === 'excluded' ? 'Already added as a negative keyword'
                : 'Show all queries'
              }
            >
              {s === 'none' ? 'Unactioned' : s === 'added' ? 'Added as KW' : s === 'excluded' ? 'Added as Negative' : 'All'}
            </button>
          ))}
        </>
      ) : (
        <>
          <span className="text-xs text-gray-500">Status:</span>
          {(['enabled', 'paused', 'all'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => onChange({ ...state, status: s })}
              className={`px-2.5 py-1 rounded text-xs ${
                state.status === s ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200'
              }`}
            >
              {s === 'enabled' ? 'Active' : s === 'paused' ? 'Paused' : 'All'}
            </button>
          ))}
        </>
      )}

      {showChannelType && presentTypes.size > 0 && (
        <>
          <span className="text-xs text-gray-500 ml-3">Type:</span>
          {ALL_CHANNEL_TYPES.filter((t) => presentTypes.has(t)).map((t) => {
            const on = state.channelTypes.has(t);
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                className={`px-2.5 py-1 rounded text-xs ${
                  on ? 'bg-blue-600 text-white' : 'bg-gray-100 hover:bg-gray-200'
                }`}
                title={state.channelTypes.size === 0 ? 'No filter — all types shown' : `${on ? 'Hide' : 'Show'} ${t}`}
              >
                {t.replace('PERFORMANCE_MAX', 'PMAX').replace('DEMAND_GEN', 'DG')}
              </button>
            );
          })}
          {state.channelTypes.size > 0 && (
            <button
              onClick={() => onChange({ ...state, channelTypes: new Set() })}
              className="text-xs text-gray-500 hover:text-gray-900 underline ml-1"
            >
              clear
            </button>
          )}
        </>
      )}

      <label className="flex items-center gap-1 text-xs text-gray-700 ml-3">
        <input
          type="checkbox"
          checked={state.hideZeroSpend}
          onChange={(e) => onChange({ ...state, hideZeroSpend: e.target.checked })}
        />
        Hide zero-spend
      </label>
    </div>
  );
}

export function defaultFilterState(): FilterState {
  return {
    // Default to 'all' so the KPI strip and the visible row sums always
    // reconcile — operators can flip to 'enabled' for the working view.
    status: 'all',
    searchTermStatus: 'none', // most actionable by default
    channelTypes: new Set(),
    hideZeroSpend: true,
  };
}

export function applyFilters(
  rows: PerfRow[],
  f: FilterState,
  options: { isSearchTerms?: boolean; isPmaxSearchInsights?: boolean } = {}
): PerfRow[] {
  return rows.filter((r) => {
    if (options.isSearchTerms) {
      if (f.searchTermStatus !== 'all') {
        const s = (r.status ?? '').toUpperCase();
        const want = f.searchTermStatus.toUpperCase();
        const effective = !s || s === 'UNKNOWN' ? 'NONE' : s;
        if (effective !== want) return false;
      }
    } else {
      if (f.status !== 'all') {
        const want = f.status === 'enabled' ? 'ENABLED' : 'PAUSED';
        if ((r.status ?? '').toUpperCase() !== want) return false;
      }
    }
    if (f.channelTypes.size > 0 && r.channel_type && !f.channelTypes.has(r.channel_type)) {
      return false;
    }
    // synthetic rows ("Other PMax" residual buckets) have cost=0 by design but real
    // NCs/revenue — keep them visible regardless of the zero-spend filter.
    // PMax search insights also have cost=0 by design (Google's API doesn't expose
    // per-category cost on campaign_search_term_insight) — fall back to impressions
    // > 0 as the activity threshold instead.
    if (f.hideZeroSpend && !r.synthetic) {
      if (options.isPmaxSearchInsights) {
        if ((r.metrics?.impressions ?? 0) <= 0) return false;
      } else if ((r.metrics?.cost ?? 0) <= 0 && !((r.metrics?.ncs ?? 0) > 0)) {
        // Keep zero-spend rows that still carry attributed NCs (late conversions
        // on now-paused campaigns) so the KPI tile reconciles with the visible
        // row sums. Drop only rows with NO spend AND no attributed NCs.
        return false;
      }
    }
    return true;
  });
}
