import type { NetworkSplitEntry } from '../lib/api';
import { fmtINR, fmtNum } from '../lib/format';

interface Props {
  entries: NetworkSplitEntry[];
  pmaxBrandSplit?: Array<{ channel: string; cost: number; impressions: number; clicks: number; conversions: number }>;
}

const NETWORK_TONE: Record<string, string> = {
  Search: 'bg-blue-500',
  'Search Partners': 'bg-blue-300',
  Display: 'bg-purple-500',
  YouTube: 'bg-red-500',
  'Google TV': 'bg-orange-500',
  'PMax (mixed)': 'bg-emerald-500',
};
const PMAX_TONE: Record<string, string> = {
  Search: 'bg-blue-500',
  Display: 'bg-purple-500',
  YouTube: 'bg-red-500',
  Shared: 'bg-amber-500',
  Other: 'bg-gray-400',
};

export function NetworkSplit({ entries, pmaxBrandSplit = [] }: Props) {
  const hasNetwork = entries.length > 0;
  const hasPmax = pmaxBrandSplit.length > 0;
  if (!hasNetwork && !hasPmax) return null;

  const networkTotal = entries.reduce((a, e) => a + e.cost, 0);
  const pmaxTotal = pmaxBrandSplit.reduce((a, e) => a + e.cost, 0);

  return (
    <div className="grid md:grid-cols-2 gap-3">
      {hasNetwork && (
        <div className="bg-white rounded shadow border px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-500">Spend by network (campaign-level)</span>
            <span className="text-xs text-gray-500">{fmtINR(networkTotal)}</span>
          </div>
          <div className="flex h-3 rounded overflow-hidden mb-3">
            {entries.map((e) => {
              const pct = (e.cost / networkTotal) * 100;
              if (pct < 0.5) return null;
              return (
                <div
                  key={e.network}
                  className={NETWORK_TONE[e.network] ?? 'bg-gray-400'}
                  style={{ width: `${pct}%` }}
                  title={`${e.network}: ${fmtINR(e.cost)} (${pct.toFixed(0)}%)`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {entries.map((e) => {
              const pct = ((e.cost / networkTotal) * 100).toFixed(0);
              return (
                <div key={e.network} className="flex items-center gap-1">
                  <span className={`inline-block w-2 h-2 rounded-sm ${NETWORK_TONE[e.network] ?? 'bg-gray-400'}`} />
                  <span className="text-gray-700">{e.network}</span>
                  <span className="text-gray-500">{fmtINR(e.cost)} ({pct}%)</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {hasPmax && (
        <div className="bg-white rounded shadow border px-4 py-3 ring-1 ring-emerald-100">
          <div className="flex items-center justify-between mb-2">
            <div>
              <span className="text-xs text-gray-500">PMax channel split</span>
              <span
                className="block text-[10px] text-gray-400"
                title="Asset-level cost attribution. Each click typically involves multiple assets (HEADLINE+DESCRIPTION+IMAGE etc.), so absolute totals can be 2–3× actual PMax spend. Trust the percentages."
              >
                all PMax campaigns · asset-level (trust %, not absolute)
              </span>
            </div>
            <span className="text-xs text-gray-500">{fmtINR(pmaxTotal)}</span>
          </div>
          <div className="flex h-3 rounded overflow-hidden mb-3">
            {pmaxBrandSplit.map((e) => {
              const pct = (e.cost / pmaxTotal) * 100;
              if (pct < 0.5) return null;
              return (
                <div
                  key={e.channel}
                  className={PMAX_TONE[e.channel] ?? 'bg-gray-400'}
                  style={{ width: `${pct}%` }}
                  title={`${e.channel}: ${fmtINR(e.cost)} (${pct.toFixed(0)}%) · ${fmtNum(e.conversions, 0)} conv`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {pmaxBrandSplit.map((e) => {
              const pct = ((e.cost / pmaxTotal) * 100).toFixed(0);
              return (
                <div key={e.channel} className="flex items-center gap-1">
                  <span className={`inline-block w-2 h-2 rounded-sm ${PMAX_TONE[e.channel] ?? 'bg-gray-400'}`} />
                  <span className="text-gray-700">{e.channel}</span>
                  <span className="text-gray-500">{fmtINR(e.cost)} ({pct}%)</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
