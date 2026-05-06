import { useEffect, useState } from 'react';
import { api, type BrandPayload } from '../lib/api';

interface Account {
  customer_id: string;
  descriptive_name: string | null;
  currency_code: string | null;
  is_manager: boolean;
}

interface Brand {
  id: number;
  name: string;
  rto_factor: number;
  rto_mode: string;
  accounts: Array<{ customer_id: string; customer_name: string | null }>;
}

export function Settings() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Brand | null>(null);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [b, a] = await Promise.all([api.brandsList(), api.accountsAccessible()]);
      setBrands(b.brands);
      setAccounts(a.accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function handleSave(payload: BrandPayload, id: number | null) {
    try {
      if (id) await api.brandUpdate(id, payload);
      else await api.brandCreate(payload);
      setEditing(null);
      setCreating(false);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this brand?')) return;
    try {
      await api.brandDelete(id);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Brands</h2>
          <button
            onClick={() => setCreating(true)}
            className="text-sm bg-black text-white px-3 py-1.5 rounded hover:opacity-90"
          >
            + New brand
          </button>
        </div>

        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (
          <div className="bg-white rounded shadow border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">RTO factor</th>
                  <th className="px-3 py-2 font-medium">RTO mode</th>
                  <th className="px-3 py-2 font-medium">Linked accounts</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {brands.map((b) => (
                  <tr key={b.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{b.name}</td>
                    <td className="px-3 py-2">{(b.rto_factor * 100).toFixed(0)}%</td>
                    <td className="px-3 py-2">
                      <span className="inline-block px-2 py-0.5 rounded bg-gray-100 text-xs">
                        {b.rto_mode}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {b.accounts.length === 0 ? (
                        <span className="text-amber-600">none — pick at least one</span>
                      ) : (
                        b.accounts.map((a) => {
                          const meta = accounts.find((acc) => acc.customer_id === a.customer_id);
                          return (
                            <span key={a.customer_id} className="inline-block bg-gray-100 rounded px-2 py-0.5 mr-1 mb-1">
                              {meta?.descriptive_name ?? a.customer_id}
                            </span>
                          );
                        })
                      )}
                    </td>
                    <td className="px-3 py-2 text-right space-x-3">
                      <button onClick={() => setEditing(b)} className="text-blue-700 hover:underline">Edit</button>
                      <button onClick={() => handleDelete(b.id)} className="text-red-700 hover:underline">Delete</button>
                    </td>
                  </tr>
                ))}
                {!brands.length && (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-gray-500">No brands yet — add one to start.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-gray-500">
          RTO mode <strong>flat</strong> uses the factor above. Modes <strong>csv</strong> and <strong>redshift</strong>{' '}
          are placeholders — Redshift live join will activate when credentials and a funnel table are configured.
        </p>
      </section>

      {(editing || creating) && (
        <BrandForm
          accounts={accounts}
          initial={editing}
          onCancel={() => { setEditing(null); setCreating(false); }}
          onSave={(p) => handleSave(p, editing?.id ?? null)}
        />
      )}
    </div>
  );
}

interface FormProps {
  accounts: Account[];
  initial: Brand | null;
  onCancel: () => void;
  onSave: (p: BrandPayload) => void;
}

function BrandForm({ accounts, initial, onCancel, onSave }: FormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [rtoFactor, setRtoFactor] = useState(initial ? Math.round(initial.rto_factor * 100) : 0);
  const [rtoMode, setRtoMode] = useState<'flat' | 'csv' | 'redshift'>(
    (initial?.rto_mode as 'flat' | 'csv' | 'redshift') ?? 'flat'
  );
  const [picked, setPicked] = useState<Set<string>>(
    new Set(initial?.accounts.map((a) => a.customer_id) ?? [])
  );

  function toggle(cid: string) {
    const next = new Set(picked);
    if (next.has(cid)) next.delete(cid);
    else next.add(cid);
    setPicked(next);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b">
          <h3 className="font-semibold">{initial ? `Edit ${initial.name}` : 'Add brand'}</h3>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Brand name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border rounded px-3 py-2"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">RTO factor (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                step="0.1"
                value={rtoFactor}
                onChange={(e) => setRtoFactor(Number(e.target.value))}
                className="w-full border rounded px-3 py-2"
              />
              <p className="text-xs text-gray-500 mt-1">
                Subtracted from Google's reported revenue when computing post-RTO ROAS.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">RTO mode</label>
              <select
                value={rtoMode}
                onChange={(e) => setRtoMode(e.target.value as 'flat' | 'csv' | 'redshift')}
                className="w-full border rounded px-3 py-2"
              >
                <option value="flat">Flat factor (v1)</option>
                <option value="csv" disabled>CSV upload (coming)</option>
                <option value="redshift" disabled>Redshift live (placeholder)</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Linked Google Ads accounts</label>
            <div className="border rounded max-h-64 overflow-y-auto divide-y">
              {accounts.map((a) => {
                const checked = picked.has(a.customer_id);
                return (
                  <label key={a.customer_id} className="flex items-center px-3 py-2 hover:bg-gray-50 cursor-pointer">
                    <input type="checkbox" checked={checked} onChange={() => toggle(a.customer_id)} className="mr-3" />
                    <span className="flex-1">
                      <span className="font-medium">{a.descriptive_name ?? '(no access)'}</span>
                      <span className="ml-2 text-xs text-gray-500 font-mono">{a.customer_id}</span>
                      {a.is_manager && <span className="ml-2 text-xs text-purple-600">MCC</span>}
                    </span>
                    <span className="text-xs text-gray-500">{a.currency_code ?? '—'}</span>
                  </label>
                );
              })}
              {!accounts.length && <div className="px-3 py-6 text-center text-sm text-gray-500">No accessible accounts found</div>}
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t bg-gray-50 flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-1.5 rounded border bg-white hover:bg-gray-100 text-sm">
            Cancel
          </button>
          <button
            onClick={() => onSave({
              name: name.trim(),
              rto_factor: rtoFactor / 100,
              rto_mode: rtoMode,
              account_ids: Array.from(picked),
            })}
            disabled={!name.trim()}
            className="px-4 py-1.5 rounded bg-black text-white hover:opacity-90 text-sm disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
