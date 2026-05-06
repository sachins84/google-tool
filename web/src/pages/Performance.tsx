import { useEffect, useMemo, useState } from 'react';
import { api, type PerfRow } from '../lib/api';
import { KpiStrip } from '../components/KpiStrip';
import { MetricsTable, type RowAction, type TableLevel } from '../components/MetricsTable';
import { MutationModal } from '../components/MutationModal';
import { Assets } from './Assets';
import { Filters, applyFilters, defaultFilterState, type FilterState } from '../components/Filters';

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
  campaignChannelType?: string; // captured at click time so we can hint to the user
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
  const [filter, setFilter] = useState<FilterState>(defaultFilterState());

  const hasCompare = !!(compareFrom && compareTo);
  const isAssetTab = tab === 'assets';
  const isPmaxDrill = drill.campaignChannelType === 'PERFORMANCE_MAX';

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

  const filteredRows = useMemo(() => applyFilters(rows, filter), [rows, filter]);

  function handleDrillFromCampaign(row: PerfRow) {
    const isPmax = row.channel_type === 'PERFORMANCE_MAX';
    setDrill({
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      campaignChannelType: row.channel_type,
    });
    // PMax has no ad_groups — go straight to Assets tab
    setTab(isPmax ? 'assets' : 'ad_groups');
  }

  function handleDrillFromAdGroup(row: PerfRow) {
    setDrill({
      campaignId: row.campaign_id ?? drill.campaignId,
      campaignName: row.campaign_name ?? drill.campaignName,
      campaignChannelType: drill.campaignChannelType,
      adGroupId: row.ad_group_id,
      adGroupName: row.ad_group_name,
    });
    setTab('ads');
  }

  function handleAction(action: RowAction) {
    setPendingAction(action);
  }

  function selectTab(t: Tab) {
    // Drill state is preserved across tab switches — clear only via the breadcrumb.
    setTab(t);
  }

  function clearDrill() {
    setDrill({});
    setTab('campaigns');
  }

  function clearAdGroupDrill() {
    setDrill((d) => ({
      campaignId: d.campaignId,
      campaignName: d.campaignName,
      campaignChannelType: d.campaignChannelType,
    }));
    setTab('ad_groups');
  }

  return (
    <div className="space-y-5">
      {!isAssetTab && <KpiStrip rows={filteredRows} hasCompare={hasCompare} />}

      <div className="border-b border-gray-200">
        <nav className="flex gap-6 overflow-x-auto">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
            // disable Ad Groups tab if drilled into a PMax campaign (it'll just be empty)
            const disabled = t === 'ad_groups' && isPmaxDrill;
            return (
              <button
                key={t}
                onClick={() => !disabled && selectTab(t)}
                disabled={disabled}
                className={`pb-2 -mb-px border-b-2 text-sm font-medium transition-colors whitespace-nowrap ${
                  tab === t ? 'border-black text-black'
                  : disabled ? 'border-transparent text-gray-300 cursor-not-allowed'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
                title={disabled ? 'PMax campaigns use Asset Groups — see Assets tab' : ''}
              >
                {TAB_LABELS[t]}
              </button>
            );
          })}
        </nav>
      </div>

      {(drill.campaignName || drill.adGroupName) && (
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <button onClick={clearDrill} className="text-blue-700 hover:underline">All campaigns</button>
          {drill.campaignName && (
            <>
              <span className="text-gray-400">›</span>
              {drill.adGroupName ? (
                <button onClick={clearAdGroupDrill} className="text-blue-700 hover:underline">{drill.campaignName}</button>
              ) : (
                <span className="text-gray-700">{drill.campaignName}</span>
              )}
              {drill.campaignChannelType && (
                <span className="text-[10px] uppercase bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                  {drill.campaignChannelType.replace('PERFORMANCE_MAX', 'PMAX').replace('DEMAND_GEN', 'DG')}
                </span>
              )}
            </>
          )}
          {drill.adGroupName && (
            <>
              <span className="text-gray-400">›</span>
              <span className="text-gray-700">{drill.adGroupName}</span>
            </>
          )}

          {/* Cross-tab navigation: when drilled into a campaign or ad-group, let user
              see the same scope at a different granularity in one click. */}
          {drill.campaignId && (
            <div className="ml-auto flex items-center gap-1 text-xs">
              <span className="text-gray-500 mr-1">View:</span>
              {!isPmaxDrill && (
                <CrossTabButton active={tab === 'ad_groups'} onClick={() => setTab('ad_groups')}>Ad Groups</CrossTabButton>
              )}
              {!isPmaxDrill && (
                <CrossTabButton active={tab === 'ads'} onClick={() => setTab('ads')}>Ads</CrossTabButton>
              )}
              {!isPmaxDrill && (
                <CrossTabButton active={tab === 'keywords'} onClick={() => setTab('keywords')}>Keywords</CrossTabButton>
              )}
              {!isPmaxDrill && (
                <CrossTabButton active={tab === 'search_terms'} onClick={() => setTab('search_terms')}>Search Terms</CrossTabButton>
              )}
              <CrossTabButton active={tab === 'assets'} onClick={() => setTab('assets')}>Assets</CrossTabButton>
            </div>
          )}
        </div>
      )}

      {/* Filter bar — channel type only on Campaigns tab; status filter applies whenever rows have a status field */}
      {!isAssetTab && (
        <Filters
          state={filter}
          onChange={setFilter}
          showChannelType={tab === 'campaigns'}
          rows={rows}
        />
      )}

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>}

      {isAssetTab ? (
        <Assets brandId={brandId} campaignId={drill.campaignId} />
      ) : loading ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
      ) : tab === 'ad_groups' && isPmaxDrill ? (
        <PmaxNoAdGroups onSwitch={() => setTab('assets')} />
      ) : (
        <MetricsTable
          level={LEVEL_FOR_TAB[tab]}
          rows={filteredRows}
          hasCompare={hasCompare}
          onDrillIn={
            tab === 'campaigns' ? handleDrillFromCampaign
            : tab === 'ad_groups' ? handleDrillFromAdGroup
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

function CrossTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-xs ${
        active ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
      }`}
    >
      {children}
    </button>
  );
}

function PmaxNoAdGroups({ onSwitch }: { onSwitch: () => void }) {
  return (
    <div className="bg-white rounded shadow border p-8 text-center text-sm">
      <div className="text-gray-700 font-medium mb-1">PMax campaigns don't have ad groups</div>
      <div className="text-gray-500 mb-3">Performance Max uses <strong>asset groups</strong> instead — bundles of headlines, descriptions, images and videos that Google's AI assembles into ads.</div>
      <button onClick={onSwitch} className="text-blue-700 hover:underline text-sm">View Assets →</button>
    </div>
  );
}
