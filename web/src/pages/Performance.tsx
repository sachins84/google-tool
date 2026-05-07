import { useEffect, useMemo, useState } from 'react';
import { api, type PerfRow } from '../lib/api';
import { KpiStrip } from '../components/KpiStrip';
import { MetricsTable, type RowAction, type TableLevel } from '../components/MetricsTable';
import { MutationModal } from '../components/MutationModal';
import { Assets } from './Assets';
import { Filters, applyFilters, defaultFilterState, type FilterState } from '../components/Filters';
import { NetworkSplit } from '../components/NetworkSplit';
import { CampaignBreakdownPanel } from '../components/CampaignBreakdown';
import type { NetworkSplitEntry } from '../lib/api';

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
  campaignCustomerId?: string;
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
  const [brandTotals, setBrandTotals] = useState<{
    primary?: { ncs: number; amount: number };
    compare?: { ncs: number; amount: number };
  } | undefined>(undefined);
  const [networkSplit, setNetworkSplit] = useState<NetworkSplitEntry[]>([]);
  const [pmaxBrandSplit, setPmaxBrandSplit] = useState<Array<{
    channel: string; cost: number; impressions: number; clicks: number; conversions: number;
  }>>([]);

  const hasCompare = !!(compareFrom && compareTo);
  const isAssetTab = tab === 'assets';
  const isPmaxDrill = drill.campaignChannelType === 'PERFORMANCE_MAX';

  useEffect(() => {
    if (isAssetTab) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    // PMax has a different search-terms endpoint (campaign_search_term_insight,
    // returns aggregated category labels rather than raw queries).
    const usePmaxSearchTerms = tab === 'search_terms' && isPmaxDrill && drill.campaignId;
    const promise = usePmaxSearchTerms
      ? api.pmaxSearchTerms({ brand_id: brandId, from, to, campaign_id: drill.campaignId })
      : api.perf(PATH_FOR_TAB[tab], {
          brand_id: brandId, from, to,
          compare_from: compareFrom, compare_to: compareTo,
          campaign_id: drill.campaignId, ad_group_id: drill.adGroupId, asset_group_id: drill.assetGroupId,
        });

    promise
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        const r = res as {
          brand_redshift_totals?: typeof brandTotals;
          network_split?: NetworkSplitEntry[];
          pmax_channel_split?: typeof pmaxBrandSplit;
        };
        setBrandTotals(r.brand_redshift_totals);
        setNetworkSplit(r.network_split ?? []);
        setPmaxBrandSplit(r.pmax_channel_split ?? []);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, from, to, compareFrom, compareTo, tab, drill.campaignId, drill.adGroupId, drill.assetGroupId, refreshTick, isAssetTab, isPmaxDrill]);

  const isPmaxSearchInsights = tab === 'search_terms' && isPmaxDrill && !!drill.campaignId;
  const filteredRows = useMemo(
    () => applyFilters(rows, filter, {
      isSearchTerms: tab === 'search_terms',
      isPmaxSearchInsights,
    }),
    [rows, filter, tab, isPmaxSearchInsights]
  );

  const hasCalcMetrics = useMemo(
    () => filteredRows.some((r) => r.metrics?.ncs != null),
    [filteredRows]
  );

  function handleDrillFromCampaign(row: PerfRow) {
    const isPmax = row.channel_type === 'PERFORMANCE_MAX';
    setDrill({
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      campaignChannelType: row.channel_type,
      campaignCustomerId: row.customer_id,
    });
    // PMax → Asset Groups (intermediate level), other types → Ad Groups
    setTab(isPmax ? 'asset_groups' : 'ad_groups');
  }

  function handleDrillFromAdGroup(row: PerfRow) {
    setDrill({
      campaignId: row.campaign_id ?? drill.campaignId,
      campaignName: row.campaign_name ?? drill.campaignName,
      campaignChannelType: drill.campaignChannelType,
      campaignCustomerId: drill.campaignCustomerId ?? row.customer_id,
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
    if (isPmaxDrill && (t === 'ad_groups' || t === 'ads' || t === 'keywords')) {
      return { disabled: true, tip: 'Not applicable to Performance Max — use Asset Groups / Assets' };
    }
    // Search Terms IS available for PMax (campaign_search_term_insight) — but as
    // privacy-aggregated category labels, not raw queries.
    if (drill.campaignChannelType && !isPmaxDrill && t === 'asset_groups') {
      return { disabled: true, tip: `Asset Groups are PMax-only (this is ${drill.campaignChannelType.replace('_', ' ')})` };
    }
    return { disabled: false };
  }

  return (
    <div className="space-y-5">
      {!isAssetTab && (
        <>
          <KpiStrip
            rows={filteredRows}
            hasCompare={hasCompare}
            brandTotals={tab === 'campaigns' ? brandTotals : undefined}
          />
          {tab === 'campaigns' && !drill.campaignId && (networkSplit.length > 0 || pmaxBrandSplit.length > 0) && (
            <NetworkSplit entries={networkSplit} pmaxBrandSplit={pmaxBrandSplit} />
          )}
          {drill.campaignId && (
            <CampaignBreakdownPanel
              brandId={brandId}
              campaignId={drill.campaignId}
              customerId={drill.campaignCustomerId}
              from={from}
              to={to}
            />
          )}
        </>
      )}

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
                  <CrossTabButton active={tab === 'search_terms'} onClick={() => setTab('search_terms')}>Search Insights</CrossTabButton>
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
        <div className="flex items-center justify-between gap-3">
          <Filters
            state={filter}
            onChange={setFilter}
            showChannelType={tab === 'campaigns'}
            isSearchTerms={tab === 'search_terms'}
            rows={rows}
          />
          {tab === 'keywords' && drill.adGroupId && (
            <button
              onClick={() => setPendingAction({
                kind: 'add_keyword',
                row: {
                  customer_id: rows[0]?.customer_id ?? '',
                  campaign_id: drill.campaignId,
                  campaign_name: drill.campaignName,
                  ad_group_id: drill.adGroupId,
                  ad_group_name: drill.adGroupName,
                  metrics: rows[0]?.metrics ?? {} as PerfRow['metrics'],
                } as PerfRow,
              })}
              className="text-sm bg-black text-white px-3 py-1.5 rounded hover:opacity-90 whitespace-nowrap"
            >
              + Add keyword
            </button>
          )}
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>}

      {isPmaxSearchInsights && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900">
          <strong>Note:</strong> Google's API doesn't expose per-category cost on PMax search insights, so the Spend / CPC / CPM / ROAS columns will all be ₹0 here. Use Impressions, Clicks, Conv and Conv. value as the activity signals — same data the Google Ads UI shows under PMax → Insights.
        </div>
      )}

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
          showCalcMetrics={hasCalcMetrics}
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
