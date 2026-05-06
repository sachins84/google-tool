import type { NetworkSplitEntry } from '../lib/api';
import { fmtINR } from '../lib/format';

interface Props {
  entries: NetworkSplitEntry[];
}

const TONE: Record<string, string> = {
  Search: 'bg-blue-500',
  'Search Partners': 'bg-blue-300',
  Display: 'bg-purple-500',
  YouTube: 'bg-red-500',
  'Google TV': 'bg-orange-500',
  'PMax (mixed)': 'bg-emerald-500',
};

export function NetworkSplit({ entries }: Props) {
  if (!entries.length) return null;
  const total = entries.reduce((a, e) => a + e.cost, 0);
  if (!total) return null;

  return (
    <div className="bg-white rounded shadow border px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500">Spend by network</span>
        <span className="text-xs text-gray-500">{fmtINR(total)} total</span>
      </div>
      <div className="flex h-3 rounded overflow-hidden mb-3">
        {entries.map((e) => {
          const pct = (e.cost / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={e.network}
              className={TONE[e.network] ?? 'bg-gray-400'}
              style={{ width: `${pct}%` }}
              title={`${e.network}: ${fmtINR(e.cost)} (${pct.toFixed(0)}%)`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {entries.map((e) => {
          const pct = ((e.cost / total) * 100).toFixed(0);
          return (
            <div key={e.network} className="flex items-center gap-1">
              <span className={`inline-block w-2 h-2 rounded-sm ${TONE[e.network] ?? 'bg-gray-400'}`} />
              <span className="text-gray-700">{e.network}</span>
              <span className="text-gray-500">{fmtINR(e.cost)} ({pct}%)</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
