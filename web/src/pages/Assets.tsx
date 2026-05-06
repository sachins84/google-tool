import { useEffect, useMemo, useState } from 'react';
import { api, type AssetRow } from '../lib/api';
import { truncate } from '../lib/format';

interface Props {
  brandId: number;
  campaignId?: string;
}

const FIELD_TYPE_ORDER = [
  'HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME',
  'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'LOGO',
  'YOUTUBE_VIDEO', 'CALL_TO_ACTION_SELECTION', 'SITELINK',
];

export function Assets({ brandId, campaignId }: Props) {
  const [rows, setRows] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [labelFilter, setLabelFilter] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.assets({ brand_id: brandId, campaign_id: campaignId })
      .then((res) => { if (!cancelled) setRows(res.rows); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, campaignId]);

  const grouped = useMemo(() => {
    const filter = labelFilter
      ? rows.filter((r) => r.performance_label === labelFilter)
      : rows;
    const m = new Map<string, AssetRow[]>();
    for (const r of filter) {
      const key = r.asset_group_id ?? '(unknown)';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r);
    }
    return Array.from(m.entries()).map(([id, items]) => ({
      id,
      name: items[0]?.asset_group_name ?? '—',
      campaign: items[0]?.campaign_name ?? '—',
      items,
    }));
  }, [rows, labelFilter]);

  const labelCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) {
      const k = r.performance_label ?? 'UNKNOWN';
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Loading assets…</div>;
  if (error) return <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-gray-700">Performance label:</span>
        {(['', 'BEST', 'GOOD', 'LOW', 'PENDING', 'UNKNOWN'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLabelFilter(l)}
            className={`px-2.5 py-1 rounded text-xs ${
              labelFilter === l ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200'
            }`}
          >
            {l || 'All'}{l && <span className="ml-1 opacity-60">{labelCounts[l] ?? 0}</span>}
          </button>
        ))}
        <span className="text-xs text-gray-500 ml-auto">
          {rows.length} assets across {grouped.length} asset groups
        </span>
      </div>

      <div className="space-y-4">
        {grouped.map((g) => (
          <div key={g.id} className="bg-white rounded shadow border overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 border-b flex items-center justify-between">
              <div>
                <div className="font-medium text-sm">{g.name}</div>
                <div className="text-xs text-gray-500">{g.campaign}</div>
              </div>
              <div className="text-xs text-gray-500">{g.items.length} assets</div>
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-gray-600 border-b">
                <tr>
                  <th className="px-4 py-1.5 font-medium">Type</th>
                  <th className="px-4 py-1.5 font-medium">Asset</th>
                  <th className="px-4 py-1.5 font-medium text-right">Performance</th>
                </tr>
              </thead>
              <tbody>
                {g.items
                  .slice()
                  .sort((a, b) => {
                    const ai = FIELD_TYPE_ORDER.indexOf(a.field_type ?? '');
                    const bi = FIELD_TYPE_ORDER.indexOf(b.field_type ?? '');
                    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                  })
                  .map((a) => (
                    <tr key={`${g.id}|${a.asset_id}|${a.field_type}`} className="border-t">
                      <td className="px-4 py-1.5 text-xs text-gray-600">{a.field_type ?? '—'}</td>
                      <td className="px-4 py-1.5">
                        {a.image_url ? (
                          <img src={a.image_url} alt="" className="h-10 w-10 object-cover rounded" />
                        ) : a.youtube_video_id ? (
                          <span className="text-xs text-gray-700">▶ youtu.be/{a.youtube_video_id}</span>
                        ) : (
                          <span className="text-sm">{truncate(a.text ?? '—', 100)}</span>
                        )}
                      </td>
                      <td className="px-4 py-1.5 text-right">
                        <PerfPill label={a.performance_label} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
        {!grouped.length && (
          <div className="text-sm text-gray-500 py-8 text-center bg-white rounded border">
            No PMax assets for this brand{labelFilter ? ` with label ${labelFilter}` : ''}.
          </div>
        )}
      </div>
    </div>
  );
}

function PerfPill({ label }: { label?: string }) {
  if (!label) return <span className="text-gray-400">—</span>;
  const tone =
    label === 'BEST' ? 'bg-emerald-100 text-emerald-800'
    : label === 'GOOD' ? 'bg-blue-100 text-blue-800'
    : label === 'LOW' ? 'bg-red-100 text-red-800'
    : label === 'PENDING' ? 'bg-amber-100 text-amber-800'
    : 'bg-gray-100 text-gray-700';
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${tone}`}>{label}</span>;
}
