import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Props {
  brandId: number;
  brandName: string;
  onClose: () => void;
}

/**
 * Brand-level utm_campaign alias editor.
 * Key (left) = the raw utm_campaign value as it appears in the funnel table
 *              (e.g. "IBK", "Calcium_Gummies").
 * Value (right) = the Google Ads asset_group_name or campaign_name to resolve to
 *                 (e.g. "Immunity Boosting Kit"). Lookup is case-insensitive and
 *                 normalized (punctuation stripped) when matching against asset
 *                 group names.
 */
export function UtmAliasModal({ brandId, brandName, onClose }: Props) {
  const [pairs, setPairs] = useState<Array<{ key: string; value: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.brandUtmAliases(brandId)
      .then((res) => {
        const entries = Object.entries(res.aliases ?? {}).map(([key, value]) => ({ key, value }));
        if (!entries.length) entries.push({ key: '', value: '' });
        setPairs(entries);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [brandId]);

  function setPair(i: number, k: 'key' | 'value', v: string) {
    setSaved(false);
    setPairs((prev) => prev.map((p, idx) => (idx === i ? { ...p, [k]: v } : p)));
  }
  function addPair() {
    setSaved(false);
    setPairs((prev) => [...prev, { key: '', value: '' }]);
  }
  function removePair(i: number) {
    setSaved(false);
    setPairs((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const aliases: Record<string, string> = {};
      for (const { key, value } of pairs) {
        const k = key.trim();
        const v = value.trim();
        if (k && v) aliases[k] = v;
      }
      await api.brandUtmAliasesUpdate(brandId, aliases);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full">
        <div className="px-5 py-4 border-b">
          <h3 className="font-semibold">UTM campaign aliases — {brandName}</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Maps a raw <code>utm_campaign</code> value from the funnel table to an asset-group / campaign name
            in Google Ads. Use this for shorthand tags like <code>IBK</code> that don't auto-resolve.
          </p>
        </div>

        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="text-sm text-gray-500 py-4">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500">
                <tr>
                  <th className="text-left py-1.5 px-1">utm_campaign value</th>
                  <th className="text-left py-1.5 px-1">→ resolves to (asset group / campaign name)</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((p, i) => (
                  <tr key={i}>
                    <td className="py-1 px-1">
                      <input
                        type="text"
                        value={p.key}
                        onChange={(e) => setPair(i, 'key', e.target.value)}
                        placeholder="e.g. IBK"
                        className="w-full border rounded px-2 py-1 text-sm font-mono"
                      />
                    </td>
                    <td className="py-1 px-1">
                      <input
                        type="text"
                        value={p.value}
                        onChange={(e) => setPair(i, 'value', e.target.value)}
                        placeholder="e.g. Immunity Boosting Kit"
                        className="w-full border rounded px-2 py-1 text-sm"
                      />
                    </td>
                    <td className="py-1 px-1">
                      <button
                        onClick={() => removePair(i)}
                        className="text-gray-400 hover:text-red-700 text-lg leading-none"
                        title="Remove"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button
            onClick={addPair}
            className="mt-2 text-xs text-blue-700 hover:underline"
          >
            + Add another alias
          </button>

          {error && (
            <div className="mt-3 bg-red-50 border border-red-200 text-red-800 rounded p-3 text-xs whitespace-pre-wrap">{error}</div>
          )}
          {saved && !error && (
            <div className="mt-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-3 text-xs">
              ✓ Saved. NC attribution updates on next reload.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 rounded border bg-white hover:bg-gray-100 text-sm">Close</button>
          <button
            onClick={save}
            disabled={busy || loading}
            className="px-4 py-1.5 rounded bg-black text-white hover:opacity-90 text-sm disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
