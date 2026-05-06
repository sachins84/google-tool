import { useEffect, useState } from 'react';
import { api, type PerfRow } from '../lib/api';
import { KpiStrip } from '../components/KpiStrip';
import { MetricsTable } from '../components/MetricsTable';

interface Props {
  brandId: number;
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
}

type Tab = 'campaigns' | 'ad_groups' | 'ads';

interface Drill {
  campaignId?: string;
  campaignName?: string;
  adGroupId?: string;
  adGroupName?: string;
}

export function Performance({ brandId, from, to, compareFrom, compareTo }: Props) {
  const [tab, setTab] = useState<Tab>('campaigns');
  const [drill, setDrill] = useState<Drill>({});
  const [rows, setRows] = useState<PerfRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hasCompare = !!(compareFrom && compareTo);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const level = tab === 'campaigns' ? 'campaigns' : tab === 'ad_groups' ? 'ad-groups' : 'ads';
    api
      .perf(level, {
        brand_id: brandId,
        from,
        to,
        compare_from: compareFrom,
        compare_to: compareTo,
        campaign_id: drill.campaignId,
        ad_group_id: drill.adGroupId,
      })
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [brandId, from, to, compareFrom, compareTo, tab, drill.campaignId, drill.adGroupId]);

  function handleDrillIntoAdGroups(row: PerfRow) {
    setDrill({ campaignId: row.campaign_id, campaignName: row.campaign_name });
    setTab('ad_groups');
  }

  function handleDrillIntoAds(row: PerfRow) {
    setDrill({
      ...drill,
      campaignId: row.campaign_id ?? drill.campaignId,
      campaignName: row.campaign_name ?? drill.campaignName,
      adGroupId: row.ad_group_id,
      adGroupName: row.ad_group_name,
    });
    setTab('ads');
  }

  return (
    <div className="space-y-6">
      <KpiStrip rows={rows} hasCompare={hasCompare} />

      <div className="border-b border-gray-200">
        <nav className="flex gap-6">
          {(['campaigns', 'ad_groups', 'ads'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); if (t === 'campaigns') setDrill({}); else if (t === 'ad_groups') setDrill((d) => ({ campaignId: d.campaignId, campaignName: d.campaignName })); }}
              className={`pb-2 -mb-px border-b-2 text-sm font-medium transition-colors ${
                tab === t ? 'border-black text-black' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'campaigns' ? 'Campaigns' : t === 'ad_groups' ? 'Ad Groups' : 'Ads'}
            </button>
          ))}
        </nav>
      </div>

      {(drill.campaignName || drill.adGroupName) && (
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => setDrill({})} className="text-blue-700 hover:underline">All campaigns</button>
          {drill.campaignName && (
            <>
              <span className="text-gray-400">›</span>
              {tab === 'ads' && drill.adGroupName ? (
                <button
                  onClick={() => { setDrill({ campaignId: drill.campaignId, campaignName: drill.campaignName }); setTab('ad_groups'); }}
                  className="text-blue-700 hover:underline"
                >
                  {drill.campaignName}
                </button>
              ) : (
                <span className="text-gray-700">{drill.campaignName}</span>
              )}
            </>
          )}
          {drill.adGroupName && tab === 'ads' && (
            <>
              <span className="text-gray-400">›</span>
              <span className="text-gray-700">{drill.adGroupName}</span>
            </>
          )}
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>}
      {loading ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
      ) : tab === 'campaigns' ? (
        <MetricsTable level="campaign" rows={rows} hasCompare={hasCompare} onDrillIn={handleDrillIntoAdGroups} />
      ) : tab === 'ad_groups' ? (
        <MetricsTable level="ad_group" rows={rows} hasCompare={hasCompare} onDrillIn={handleDrillIntoAds} />
      ) : (
        <MetricsTable level="ad" rows={rows} hasCompare={hasCompare} />
      )}
    </div>
  );
}
