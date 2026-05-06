import { useEffect, useState } from 'react';
import { api, type AuditEntry } from '../lib/api';

export function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDryRuns, setShowDryRuns] = useState(true);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.audit({ limit: 200 });
      setEntries(res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const visible = entries.filter((e) => showDryRuns || !e.dry_run);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">Audit log</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={showDryRuns}
              onChange={(e) => setShowDryRuns(e.target.checked)}
            />
            Show dry-runs
          </label>
          <button onClick={refresh} className="text-xs text-blue-700 hover:underline">Refresh</button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>}

      {loading ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
      ) : (
        <div className="bg-white rounded shadow border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-3 py-2 font-medium text-left text-gray-600">Time</th>
                <th className="px-3 py-2 font-medium text-left text-gray-600">User</th>
                <th className="px-3 py-2 font-medium text-left text-gray-600">Action</th>
                <th className="px-3 py-2 font-medium text-left text-gray-600">Brand</th>
                <th className="px-3 py-2 font-medium text-left text-gray-600">Target</th>
                <th className="px-3 py-2 font-medium text-left text-gray-600">Before → After</th>
                <th className="px-3 py-2 font-medium text-left text-gray-600">Mode</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.id} className={`border-t ${e.action.endsWith('_failed') ? 'bg-red-50' : ''}`}>
                  <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">
                    {new Date(e.created_at * 1000).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-xs">{e.username ?? '—'}</td>
                  <td className="px-3 py-2 text-xs font-mono">{e.action}</td>
                  <td className="px-3 py-2 text-xs">{e.brand_name ?? '—'}</td>
                  <td className="px-3 py-2 text-xs font-mono text-gray-600 truncate max-w-[260px]" title={e.target_resource ?? ''}>
                    {e.target_resource ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <BeforeAfter before={e.before} after={e.after} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {e.dry_run ? (
                      <span className="inline-block px-2 py-0.5 rounded bg-gray-100 text-gray-700 text-[11px]">DRY</span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[11px]">LIVE</span>
                    )}
                  </td>
                </tr>
              ))}
              {!visible.length && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-gray-500">No entries.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BeforeAfter({ before, after }: { before: unknown; after: unknown }) {
  const fmt = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  };
  const b = fmt(before);
  const a = fmt(after);
  if (!b && !a) return <span className="text-gray-400">—</span>;
  if (!b) return <span className="text-emerald-700">{a}</span>;
  if (!a) return <span className="text-gray-700">{b}</span>;
  return (
    <span>
      <span className="text-gray-500">{b}</span>
      <span className="mx-1 text-gray-400">→</span>
      <span className="text-emerald-700">{a}</span>
    </span>
  );
}
