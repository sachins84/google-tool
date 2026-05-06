import type { PerfRow } from '../lib/api';

export type StatusFilter = 'enabled' | 'paused' | 'all';

export interface FilterState {
  status: StatusFilter;
  channelTypes: Set<string>; // empty = all
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
  rows: PerfRow[]; // used to count available channel types
}

export function Filters({ state, onChange, showChannelType, rows }: Props) {
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
    </div>
  );
}

export function defaultFilterState(): FilterState {
  return { status: 'enabled', channelTypes: new Set() };
}

export function applyFilters(rows: PerfRow[], f: FilterState): PerfRow[] {
  return rows.filter((r) => {
    if (f.status !== 'all') {
      const want = f.status === 'enabled' ? 'ENABLED' : 'PAUSED';
      if ((r.status ?? '').toUpperCase() !== want) return false;
    }
    if (f.channelTypes.size > 0 && r.channel_type && !f.channelTypes.has(r.channel_type)) {
      return false;
    }
    return true;
  });
}
