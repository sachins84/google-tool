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

type Tab = 'campaigns' | 'ad_groups' | 'asset_groups' | 'ads' | 'keywords' | 'search_terms' | 'assets';

interface Drill {
  campaignId?: string;
  campaignName?: string;
  campaignChannelType?: string;
  adGroupId?: string;
  adGroupName?: string;
  assetGroupId?: string;
  assetGroupName?: string;
}

const TAB_LABELS: Record<Tab, string> = {
  campaigns: 'Campaigns',
  ad_groups: 'Ad Groups',
  asset_groups: 'Asset Groups',
  ads: 'Ads',
  keywords: 'Keywords',
  search_terms: 'Search Terms',
  assets: 'Assets',
};

const PATH_FOR_TAB: Record<Exclude<Tab, 'assets'>, 'campaigns' | 'ad-groups' | 'asset-groups' | 'ads' | 'keywords' | 'search-terms'> = {
  campaigns: 'campaigns',
  ad_groups: 'ad-groups',
  asset_groups: 'asset-groups',
  ads: 'ads',
  keywords: 'keywords',
  search_terms: 'search-terms',
};

const LEVEL_FOR_TAB: Record<Exclude<Tab, 'assets'>, TableLevel> = {
  campaigns: 'campaign',
  ad_groups: 'ad_group',
  asset_groups: 'asset_group',
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
        asset_group_id: drill.assetGroupId,
      })
      .then((res) => { if (!cancelled) setRows(res.rows); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, from, to, compareFrom, compareTo, tab, drill.campaignId, drill.adGroupId, drill.assetGroupId, refreshTick, isAssetTab]);

  const filteredRows = useMemo(
    () => applyFilters(rows, filter, { isSearchTerms: tab === 'search_terms' }),
    [rows, filter, tab]
  );

  function handleDrillFromCampaign(row: PerfRow) {
    const isPmax = row.channel_type === 'PERFORMANCE_MAX';
    setDrill({
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      campaignChannelType: row.channel_type,
    });
    // PMax → Asset Groups (intermediate level), other types → Ad Groups
    setTab(isPmax ? 'asset_groups' : 'ad_groups');
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

  function handleDrillFromAssetGroup(row: PerfRow) {
    setDrill({
      ...drill,
      assetGroupId: row.asset_group_id,
      assetGroupName: row.asset_group_name,
    });
    setTab('assets');
  }

  function handleAction(action: RowAction) {
    setPendingAction(action);
  }

  function selectTab(t: Tab) {
    // Drill state preserved across tab switches — clear only via the breadcrumb.
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
    setTab(isPmaxDrill ? 'asset_groups' : 'ad_groups');
  }

  function clearAssetGroupDrill() {
    setDrill((d) => ({
      campaignId: d.campaignId,
      campaignName: d.campaignName,
      campaignChannelType: d.campaignChannelType,
    }));
    setTab('asset_groups');
  }

  // Tab-availability helper: PMax campaigns show {asset_groups, assets};
  // non-PMax campaigns show {ad_groups, ads, keywords, search_terms}.
  function isTabDisabled(t: Tab): { disabled: boolean; tip?: string } {
    if (!drill.campaignId) {
      // No drill yet — only Campaigns is meaningful (Assets is too, just shows everything)
      return { disabled: false };
    }
    if (isPmaxDrill && (t === 'ad_groups' || t === 'ads' || t === 'keywords' || t === 'search_terms')) {
      return { disabled: true, tip: 'Not applicable to Performance Max — use Asset Groups / Assets' };
    }
    if (drill.campaignChannelType && !isPmaxDrill && t === 'asset_groups') {
      return { disabled: true, tip: `Asset Groups are PMax-only (this is ${drill.campaignChannelType.replace('_', ' ')})` };
    }
    return { disabled: false };
  }

  return (
    <div className="space-y-5">
      {!isAssetTab && <KpiStrip rows={filteredRows} hasCompare={hasCompare} />}

      <div className="border-b border-gray-200">
        <nav className="flex gap-6 overflow-x-auto">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
            const { disabled, tip } = isTabDisabled(t);
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
                title={tip ?? ''}
              >
                {TAB_LABELS[t]}
              </button>
            );
          })}
        </nav>
      </div>

      {(drill.campaignName || drill.adGroupName || drill.assetGroupName) && (
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <button onClick={clearDrill} className="text-blue-700 hover:underline">All campaigns</button>
          {drill.campaignName && (
            <>
              <span className="text-gray-400">›</span>
              {drill.adGroupName || drill.assetGroupName ? (
                <button
                  onClick={drill.assetGroupName ? clearAssetGroupDrill : clearAdGroupDrill}
                  className="text-blue-700 hover:underline"
                >
                  {drill.campaignName}
                </button>
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
          {drill.assetGroupName && (
            <>
              <span className="text-gray-400">›</span>
              <span className="text-gray-700">{drill.assetGroupName}</span>
            </>
          )}

          {/* Cross-tab "View:" buttons. Tabs shown depend on whether the drill is PMax or not. */}
          {drill.campaignId && (
            <div className="ml-auto flex items-center gap-1 text-xs">
              <span className="text-gray-500 mr-1">View:</span>
              {isPmaxDrill ? (
                <>
                  <CrossTabButton active={tab === 'asset_groups'} onClick={() => setTab('asset_groups')}>Asset Groups</CrossTabButton>
                  <CrossTabButton active={tab === 'assets'} onClick={() => setTab('assets')}>Assets</CrossTabButton>
                </>
              ) : (
                <>
                  <CrossTabButton active={tab === 'ad_groups'} onClick={() => setTab('ad_groups')}>Ad Groups</CrossTabButton>
                  <CrossTabButton active={tab === 'ads'} onClick={() => setTab('ads')}>Ads</CrossTabButton>
                  <CrossTabButton active={tab === 'keywords'} onClick={() => setTab('keywords')}>Keywords</CrossTabButton>
                  <CrossTabButton active={tab === 'search_terms'} onClick={() => setTab('search_terms')}>Search Terms</CrossTabButton>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {!isAssetTab && (
        <Filters
          state={filter}
          onChange={setFilter}
          showChannelType={tab === 'campaigns'}
          isSearchTerms={tab === 'search_terms'}
          rows={rows}
        />
      )}

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>}

      {isAssetTab ? (
        <Assets
          brandId={brandId}
          from={from}
          to={to}
          campaignId={drill.campaignId}
          assetGroupId={drill.assetGroupId}
        />
      ) : loading ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
      ) : (
        <MetricsTable
          level={LEVEL_FOR_TAB[tab]}
          rows={filteredRows}
          hasCompare={hasCompare}
          onDrillIn={
            tab === 'campaigns' ? handleDrillFromCampaign
            : tab === 'ad_groups' ? handleDrillFromAdGroup
            : tab === 'asset_groups' ? handleDrillFromAssetGroup
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
