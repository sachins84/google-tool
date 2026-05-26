import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { rangeForPreset, buildCompareRange, type Preset } from '../lib/dates';

export interface DashState {
  brandId: number | null;
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
}

export type View = 'performance' | 'insights' | 'settings' | 'audit' | 'youtube';

interface Props {
  username: string;
  view: View;
  state: DashState;
  brands: Array<{ id: number; name: string }>;
  onState: (s: DashState) => void;
  onView: (v: View) => void;
  onLogout: () => void;
}

export function Header({ username, view, state, brands, onState, onView, onLogout }: Props) {
  const [preset, setPreset] = useState<Preset>('last_7');
  const [compareOn, setCompareOn] = useState(true);

  // Bootstrap default brand selection once brands are loaded.
  useEffect(() => {
    if (state.brandId == null && brands[0]) {
      const r = rangeForPreset('last_7');
      onState({ brandId: brands[0].id, from: r.from, to: r.to, compareFrom: r.compareFrom, compareTo: r.compareTo });
    }
  }, [brands, state.brandId]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyPreset(p: Preset) {
    setPreset(p);
    const r = rangeForPreset(p);
    onState({
      ...state,
      from: r.from,
      to: r.to,
      compareFrom: compareOn ? r.compareFrom : undefined,
      compareTo: compareOn ? r.compareTo : undefined,
    });
  }

  function applyCustomDates(from: string, to: string) {
    setPreset('custom');
    if (compareOn) {
      const c = buildCompareRange(from, to);
      onState({ ...state, from, to, compareFrom: c.compareFrom, compareTo: c.compareTo });
    } else {
      onState({ ...state, from, to, compareFrom: undefined, compareTo: undefined });
    }
  }

  function toggleCompare(on: boolean) {
    setCompareOn(on);
    if (on) {
      const c = buildCompareRange(state.from, state.to);
      onState({ ...state, compareFrom: c.compareFrom, compareTo: c.compareTo });
    } else {
      onState({ ...state, compareFrom: undefined, compareTo: undefined });
    }
  }

  async function handleLogout() {
    try { await api.logout(); } finally { onLogout(); }
  }

  return (
    <header className="bg-white border-b sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
        <h1 className="font-semibold mr-2">Google Ads Tool</h1>

        <select
          value={state.brandId ?? ''}
          onChange={(e) => onState({ ...state, brandId: Number(e.target.value) })}
          className="border rounded px-3 py-1.5 text-sm"
        >
          {!brands.length && <option value="">No brands</option>}
          {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>

        <div className="flex items-center gap-1 text-sm">
          {(['today', 'yesterday', 'last_3', 'last_7', 'last_14', 'last_30', 'mtd'] as Preset[]).map((p) => (
            <button
              key={p}
              onClick={() => applyPreset(p)}
              className={`px-2.5 py-1 rounded text-xs ${
                preset === p ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200'
              }`}
            >
              {labelFor(p)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-sm">
          <input
            type="date"
            value={state.from}
            onChange={(e) => applyCustomDates(e.target.value, state.to)}
            className="border rounded px-2 py-1 text-xs"
          />
          <span className="text-gray-400">→</span>
          <input
            type="date"
            value={state.to}
            onChange={(e) => applyCustomDates(state.from, e.target.value)}
            className="border rounded px-2 py-1 text-xs"
          />
        </div>

        <label className="flex items-center gap-1 text-xs text-gray-700">
          <input type="checkbox" checked={compareOn} onChange={(e) => toggleCompare(e.target.checked)} />
          Compare prev
        </label>

        <div className="flex-1" />

        <nav className="flex items-center gap-1 text-sm">
          <button
            onClick={() => onView('performance')}
            className={`px-3 py-1.5 rounded ${view === 'performance' ? 'bg-black text-white' : 'hover:bg-gray-100'}`}
          >
            Dashboard
          </button>
          <button
            onClick={() => onView('insights')}
            className={`px-3 py-1.5 rounded ${view === 'insights' ? 'bg-black text-white' : 'hover:bg-gray-100'}`}
          >
            Insights
          </button>
          <button
            onClick={() => onView('youtube')}
            className={`px-3 py-1.5 rounded ${view === 'youtube' ? 'bg-black text-white' : 'hover:bg-gray-100'}`}
          >
            YT Upload
          </button>
          <button
            onClick={() => onView('audit')}
            className={`px-3 py-1.5 rounded ${view === 'audit' ? 'bg-black text-white' : 'hover:bg-gray-100'}`}
          >
            Audit Log
          </button>
          <button
            onClick={() => onView('settings')}
            className={`px-3 py-1.5 rounded ${view === 'settings' ? 'bg-black text-white' : 'hover:bg-gray-100'}`}
          >
            Settings
          </button>
        </nav>

        <div className="text-xs text-gray-600 flex items-center gap-2">
          <span>{username}</span>
          <button onClick={handleLogout} className="text-gray-500 hover:text-gray-900 hover:underline">Sign out</button>
        </div>
      </div>
    </header>
  );
}

function labelFor(p: Preset): string {
  switch (p) {
    case 'today': return 'Today';
    case 'yesterday': return 'Yest';
    case 'last_3': return '3d';
    case 'last_7': return '7d';
    case 'last_14': return '14d';
    case 'last_30': return '30d';
    case 'mtd': return 'MTD';
    default: return p;
  }
}
