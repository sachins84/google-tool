import { useEffect, useState } from 'react';
import { api, type PerfRow } from '../lib/api';
import { KpiStrip } from '../components/KpiStrip';
import { MetricsTable, type RowAction, type TableLevel } from '../components/MetricsTable';
import { MutationModal } from '../components/MutationModal';
import { Assets } from './Assets';

interface Props {
  brandId: number;
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
}

type Tab = 'campaigns' | 'ad_groups' | 'ads' | 'keywords' | 'search_terms' | 'assets';

interface Drill {
  campaignId?: string;
  campaignName?: string;
  adGroupId?: string;
  adGroupName?: string;
}

const TAB_LABELS: Record<Tab, string> = {
  campaigns: 'Campaigns',
  ad_groups: 'Ad Groups',
  ads: 'Ads',
  keywords: 'Keywords',
  search_terms: 'Search Terms',
  assets: 'Assets',
};

const PATH_FOR_TAB: Record<Exclude<Tab, 'assets'>, 'campaigns' | 'ad-groups' | 'ads' | 'keywords' | 'search-terms'> = {
  campaigns: 'campaigns',
  ad_groups: 'ad-groups',
  ads: 'ads',
  keywords: 'keywords',
  search_terms: 'search-terms',
};

const LEVEL_FOR_TAB: Record<Exclude<Tab, 'assets'>, TableLevel> = {
  campaigns: 'campaign',
  ad_groups: 'ad_group',
  ads: 'ad',
  keywords: 'keyword',
  search_terms: 'search_term',
};

export function Performance({ brandId, from, to, compareFrom, compareTo }: Props) {
  const [tab, setTab] = useState<Tab>('campaigns');
  const [drill, setDrill] = useState<Drill>({});
  const [rows, setRows] = useState<PerfRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<RowAction | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const hasCompare = !!(compareFrom && compareTo);
  const isAssetTab = tab === 'assets';

  useEffect(() => {
    if (isAssetTab) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const path = PATH_FOR_TAB[tab];
    api
      .perf(path, {
        brand_id: brandId,
        from,
        to,
        compare_from: compareFrom,
        compare_to: compareTo,
        campaign_id: drill.campaignId,
        ad_group_id: drill.adGroupId,
      })
      .then((res) => { if (!cancelled) setRows(res.rows); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, from, to, compareFrom, compareTo, tab, drill.campaignId, drill.adGroupId, refreshTick, isAssetTab]);

  function handleDrillIntoAdGroups(row: PerfRow) {
    setDrill({ campaignId: row.campaign_id, campaignName: row.campaign_name });
    setTab('ad_groups');
  }

  function handleDrillIntoAds(row: PerfRow) {
    setDrill({
      campaignId: row.campaign_id ?? drill.campaignId,
      campaignName: row.campaign_name ?? drill.campaignName,
      adGroupId: row.ad_group_id,
      adGroupName: row.ad_group_name,
    });
    setTab('ads');
  }

  function handleAction(action: RowAction) {
    setPendingAction(action);
  }

  function selectTab(t: Tab) {
    setTab(t);
    if (t === 'campaigns' || t === 'assets') setDrill({});
    else if (t === 'ad_groups') setDrill((d) => ({ campaignId: d.campaignId, campaignName: d.campaignName }));
  }

  return (
    <div className="space-y-6">
      {!isAssetTab && <KpiStrip rows={rows} hasCompare={hasCompare} />}

      <div className="border-b border-gray-200">
        <nav className="flex gap-6 overflow-x-auto">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => selectTab(t)}
              className={`pb-2 -mb-px border-b-2 text-sm font-medium transition-colors whitespace-nowrap ${
                tab === t ? 'border-black text-black' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      </div>

      {(drill.campaignName || drill.adGroupName) && !isAssetTab && (
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => setDrill({})} className="text-blue-700 hover:underline">All campaigns</button>
          {drill.campaignName && (
            <>
              <span className="text-gray-400">›</span>
              {(tab === 'ads' || tab === 'keywords' || tab === 'search_terms') && drill.adGroupName ? (
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
          {drill.adGroupName && (tab === 'ads' || tab === 'keywords' || tab === 'search_terms') && (
            <>
              <span className="text-gray-400">›</span>
              <span className="text-gray-700">{drill.adGroupName}</span>
            </>
          )}
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>}

      {isAssetTab ? (
        <Assets brandId={brandId} campaignId={drill.campaignId} />
      ) : loading ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
      ) : (
        <MetricsTable
          level={LEVEL_FOR_TAB[tab]}
          rows={rows}
          hasCompare={hasCompare}
          onDrillIn={
            tab === 'campaigns' ? handleDrillIntoAdGroups
            : tab === 'ad_groups' ? handleDrillIntoAds
            : undefined
          }
          onAction={handleAction}
        />
      )}

      {pendingAction && (
        <MutationModal
          brandId={brandId}
          action={pendingAction}
          onClose={() => setPendingAction(null)}
          onSuccess={() => {
            setPendingAction(null);
            setRefreshTick((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
