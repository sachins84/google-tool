import { useEffect, useState } from 'react';
import { api, type YoutubeAuthChannel } from '../lib/api';

interface Brand {
  id: number;
  name: string;
}

function fmtTs(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

export function YoutubeAuth() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [channels, setChannels] = useState<YoutubeAuthChannel[]>([]);
  const [selectedBrand, setSelectedBrand] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);

  // Show consent-flow result banner from URL on first mount, then strip the params.
  useEffect(() => {
    const u = new URL(window.location.href);
    const connected = u.searchParams.get('yt_auth_connected');
    const err = u.searchParams.get('yt_auth_error');
    if (connected) {
      setBanner({ kind: 'success', msg: `Connected: ${connected}` });
    } else if (err) {
      setBanner({ kind: 'error', msg: err });
    }
    if (connected || err) {
      u.searchParams.delete('yt_auth_connected');
      u.searchParams.delete('yt_auth_error');
      window.history.replaceState({}, '', u.toString());
    }
  }, []);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [b, c] = await Promise.all([api.brandsList(), api.ytAuthChannels()]);
      setBrands(b.brands);
      setChannels(c.channels);
      setSelectedBrand((curr) => curr ?? b.brands[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function connect() {
    setError(null);
    if (!selectedBrand) {
      setError('Pick a brand to connect a channel to.');
      return;
    }
    setConnecting(true);
    try {
      const res = await api.ytAuthStart(selectedBrand);
      // Full-page redirect — Google consent screen will redirect back to /api/youtube/auth/callback,
      // which then redirects the browser back to "/" with ?yt_auth_connected=… (handled on mount).
      window.location.href = res.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConnecting(false);
    }
  }

  async function disconnect(id: number, title: string) {
    if (!window.confirm(`Disconnect "${title}"? Uploads to this channel will stop until it's reconnected.`)) {
      return;
    }
    try {
      await api.ytAuthDisconnect(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Group channels by brand for the table
  const byBrand = new Map<string, YoutubeAuthChannel[]>();
  for (const c of channels) {
    const key = c.brand_name ?? `Brand #${c.brand_id}`;
    if (!byBrand.has(key)) byBrand.set(key, []);
    byBrand.get(key)!.push(c);
  }

  return (
    <div className="space-y-6">
      {banner && (
        <div
          className={`rounded border p-3 text-sm flex items-center justify-between ${
            banner.kind === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <span>{banner.msg}</span>
          <button
            onClick={() => setBanner(null)}
            className="text-xs underline opacity-70 hover:opacity-100"
          >
            dismiss
          </button>
        </div>
      )}

      <section className="bg-white rounded border p-4 space-y-3">
        <h2 className="font-semibold">Connect a YouTube channel</h2>
        <p className="text-xs text-gray-600">
          Pick the brand, then go through Google's consent screen as a{' '}
          <code className="bg-gray-100 px-1 rounded">@mosaicwellness.in</code> admin and{' '}
          <strong>select the Brand Account / channel</strong> you want to connect. Repeat per
          channel to connect multiple channels under the same brand.
        </p>

        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-sm">
            <div className="text-gray-600 mb-1">Brand</div>
            <select
              value={selectedBrand ?? ''}
              onChange={(e) => setSelectedBrand(Number(e.target.value))}
              className="border rounded px-2 py-1.5 min-w-[200px]"
            >
              {!brands.length && <option value="">No brands</option>}
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>

          <button
            onClick={() => void connect()}
            disabled={connecting || !selectedBrand}
            className="bg-black text-white text-sm px-4 py-1.5 rounded disabled:opacity-50"
          >
            {connecting ? 'Redirecting…' : 'Connect channel via Google'}
          </button>

          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </section>

      <section className="bg-white rounded border">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h2 className="font-semibold text-sm">Connected channels</h2>
          <button onClick={() => void refresh()} className="text-xs text-gray-600 hover:underline">
            refresh
          </button>
        </div>

        {loading ? (
          <div className="p-6 text-sm text-gray-500">Loading…</div>
        ) : !channels.length ? (
          <div className="p-6 text-sm text-gray-500">
            No channels connected yet. Use the form above to connect one.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-3 py-2">Brand</th>
                <th className="text-left px-3 py-2">Channel</th>
                <th className="text-left px-3 py-2">Connected by</th>
                <th className="text-left px-3 py-2">Granted at</th>
                <th className="text-left px-3 py-2">Last used</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...byBrand.entries()].flatMap(([brandName, rows]) =>
                rows.map((r, i) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 text-gray-700">
                      {i === 0 ? brandName : ''}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {r.channel_thumbnail && (
                          <img
                            src={r.channel_thumbnail}
                            alt=""
                            className="w-6 h-6 rounded-full"
                          />
                        )}
                        <div>
                          <div className="font-medium">{r.channel_title}</div>
                          <div className="text-[10px] text-gray-400 font-mono">{r.channel_id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-600">{r.granted_by_email}</td>
                    <td className="px-3 py-2 text-gray-600">{fmtTs(r.granted_at)}</td>
                    <td className="px-3 py-2 text-gray-600">{fmtTs(r.last_used_at)}</td>
                    <td className="px-3 py-2">
                      {r.last_refresh_error ? (
                        <span
                          className="text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded"
                          title={r.last_refresh_error}
                        >
                          needs reconnect
                        </span>
                      ) : (
                        <span className="text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 rounded">
                          healthy
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => void disconnect(r.id, r.channel_title)}
                        className="text-red-700 hover:underline"
                      >
                        Disconnect
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
