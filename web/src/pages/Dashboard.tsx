import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Account {
  customer_id: string;
  descriptive_name: string | null;
  currency_code: string | null;
  time_zone: string | null;
  is_manager: boolean;
}

interface Brand {
  id: number;
  name: string;
  rto_factor: number;
  rto_mode: string;
  accounts: Array<{ customer_id: string; customer_name: string | null }>;
}

interface Props {
  username: string;
  onLogout: () => void;
}

export function Dashboard({ username, onLogout }: Props) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.accountsAccessible(), api.brandsList()])
      .then(([a, b]) => {
        if (cancelled) return;
        setAccounts(a.accounts);
        setBrands(b.brands);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function handleLogout(): Promise<void> {
    try {
      await api.logout();
    } finally {
      onLogout();
    }
  }

  return (
    <div className="min-h-full">
      <header className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="font-semibold">Google Ads Tool</h1>
          <div className="text-sm text-gray-600 flex items-center gap-3">
            <span>{username}</span>
            <button
              onClick={handleLogout}
              className="text-gray-500 hover:text-gray-900 underline-offset-2 hover:underline"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-8">
        {loading && <div className="text-sm text-gray-500">Loading…</div>}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">
            {error}
          </div>
        )}

        {brands && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Brands</h2>
              <span className="text-xs text-gray-500">{brands.length} configured</span>
            </div>
            <div className="bg-white rounded shadow border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">RTO factor</th>
                    <th className="px-3 py-2 font-medium">RTO mode</th>
                    <th className="px-3 py-2 font-medium">Linked accounts</th>
                  </tr>
                </thead>
                <tbody>
                  {brands.map((b) => (
                    <tr key={b.id} className="border-t">
                      <td className="px-3 py-2">{b.name}</td>
                      <td className="px-3 py-2">{(b.rto_factor * 100).toFixed(0)}%</td>
                      <td className="px-3 py-2">{b.rto_mode}</td>
                      <td className="px-3 py-2">
                        {b.accounts.map((a) => a.customer_id).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {accounts && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Accessible Google Ads accounts</h2>
              <span className="text-xs text-gray-500">{accounts.length} total</span>
            </div>
            <div className="bg-white rounded shadow border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">Customer ID</th>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Currency</th>
                    <th className="px-3 py-2 font-medium">Time zone</th>
                    <th className="px-3 py-2 font-medium">Manager</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.customer_id} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs">{a.customer_id}</td>
                      <td className="px-3 py-2">{a.descriptive_name ?? '—'}</td>
                      <td className="px-3 py-2">{a.currency_code ?? '—'}</td>
                      <td className="px-3 py-2">{a.time_zone ?? '—'}</td>
                      <td className="px-3 py-2">{a.is_manager ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500">
              Phase 0 milestone — proves auth + Google Ads API connectivity end-to-end. Brand mapping
              CRUD UI, dashboard tabs, and mutations come in Phase 1.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
