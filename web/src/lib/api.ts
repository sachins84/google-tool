export interface ApiError {
  error: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as ApiError;
      if (body.error) message = body.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => request<{ user: { id: number; username: string; role: string } }>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: { id: number; username: string; role: string } }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  accountsAccessible: () =>
    request<{
      accounts: Array<{
        customer_id: string;
        descriptive_name: string | null;
        currency_code: string | null;
        time_zone: string | null;
        is_manager: boolean;
      }>;
    }>('/api/accounts/accessible'),

  brandsList: () =>
    request<{
      brands: Array<{
        id: number;
        name: string;
        rto_factor: number;
        revenue_rto_factor: number | null;
        rto_mode: string;
        accounts: Array<{ customer_id: string; customer_name: string | null }>;
      }>;
    }>('/api/brands'),

  brandCreate: (body: BrandPayload) =>
    request<{ id: number }>('/api/brands', { method: 'POST', body: JSON.stringify(body) }),
  brandUpdate: (id: number, body: BrandPayload) =>
    request<{ ok: true }>(`/api/brands/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  brandDelete: (id: number) =>
    request<{ ok: true }>(`/api/brands/${id}`, { method: 'DELETE' }),

  perf: (
    level: 'campaigns' | 'ad-groups' | 'asset-groups' | 'ads' | 'keywords' | 'search-terms',
    params: PerfParams
  ) => {
    const qs = new URLSearchParams();
    qs.set('brand_id', String(params.brand_id));
    qs.set('from', params.from);
    qs.set('to', params.to);
    if (params.compare_from) qs.set('compare_from', params.compare_from);
    if (params.compare_to) qs.set('compare_to', params.compare_to);
    if (params.campaign_id) qs.set('campaign_id', params.campaign_id);
    if (params.ad_group_id) qs.set('ad_group_id', params.ad_group_id);
    if (params.asset_group_id) qs.set('asset_group_id', params.asset_group_id);
    return request<{
      rows: PerfRow[];
      brand_redshift_totals?: {
        primary?: { ncs: number; amount: number };
        compare?: { ncs: number; amount: number };
      };
      network_split?: NetworkSplitEntry[];
      pmax_channel_split?: Array<{
        channel: string;
        cost: number;
        impressions: number;
        clicks: number;
        conversions: number;
      }>;
    }>(`/api/${level}?${qs.toString()}`);
  },

  pmaxSearchTerms: (params: PerfParams) => {
    const qs = new URLSearchParams();
    qs.set('brand_id', String(params.brand_id));
    qs.set('from', params.from);
    qs.set('to', params.to);
    if (params.campaign_id) qs.set('campaign_id', params.campaign_id);
    return request<{ rows: PerfRow[] }>(`/api/pmax-search-terms?${qs.toString()}`);
  },

  insightsDaily: (
    params: { brand_id: number; from: string; to: string; compare_from?: string; compare_to?: string },
    rows: PerfRow[]
  ) => {
    const qs = new URLSearchParams();
    qs.set('brand_id', String(params.brand_id));
    qs.set('from', params.from);
    qs.set('to', params.to);
    if (params.compare_from) qs.set('compare_from', params.compare_from);
    if (params.compare_to) qs.set('compare_to', params.compare_to);
    return request<{ insights: DailyInsight[] }>(`/api/insights/daily?${qs.toString()}`, {
      method: 'POST',
      body: JSON.stringify({ rows }),
    });
  },

  insightsAsk: (
    params: { brand_id: number; from: string; to: string },
    body: { question: string; rows: PerfRow[]; brand_totals?: { ncs: number; amount: number } }
  ) => {
    const qs = new URLSearchParams();
    qs.set('brand_id', String(params.brand_id));
    qs.set('from', params.from);
    qs.set('to', params.to);
    return request<{ answer: string }>(`/api/insights/ask?${qs.toString()}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  campaignBreakdown: (params: {
    brand_id: number; campaign_id: string; customer_id?: string; from: string; to: string;
  }) => {
    const qs = new URLSearchParams();
    qs.set('brand_id', String(params.brand_id));
    qs.set('campaign_id', params.campaign_id);
    if (params.customer_id) qs.set('customer_id', params.customer_id);
    qs.set('from', params.from);
    qs.set('to', params.to);
    return request<CampaignBreakdown>(`/api/campaign-breakdown?${qs.toString()}`);
  },

  diagnose: (params: {
    brand_id: number; customer_id: string; campaign_id: string;
    metric: 'cpm' | 'cpc' | 'ctr' | 'conv_rate' | 'calc_roas' | 'calc_cpa' | 'cpa';
    from: string; to: string; compare_from?: string; compare_to?: string;
  }) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v != null && qs.set(k, String(v)));
    return request<DiagnoseResult>(`/api/diagnose?${qs.toString()}`);
  },

  assets: (params: {
    brand_id: number;
    from: string;
    to: string;
    campaign_id?: string;
    asset_group_id?: string;
  }) => {
    const qs = new URLSearchParams();
    qs.set('brand_id', String(params.brand_id));
    qs.set('from', params.from);
    qs.set('to', params.to);
    if (params.campaign_id) qs.set('campaign_id', params.campaign_id);
    if (params.asset_group_id) qs.set('asset_group_id', params.asset_group_id);
    return request<{ rows: AssetRow[] }>(`/api/assets?${qs.toString()}`);
  },

  mutate: (body: MutatePayload) =>
    request<{ ok: true; dry_run: boolean; response: unknown }>('/api/mutate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  audit: (params: { brand_id?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.brand_id) qs.set('brand_id', String(params.brand_id));
    qs.set('limit', String(params.limit ?? 100));
    return request<{ entries: AuditEntry[] }>(`/api/audit?${qs.toString()}`);
  },
};

export interface AssetRow {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  channel_type?: string;
  asset_group_id?: string;
  asset_group_name?: string;
  asset_id?: string;
  asset_type?: string;
  field_type?: string;
  performance_label?: string;
  status?: string;
  text?: string;
  image_url?: string;
  youtube_video_id?: string;
  metrics?: DerivedMetrics;
}

export type AssetFieldType =
  | 'HEADLINE' | 'LONG_HEADLINE' | 'DESCRIPTION' | 'BUSINESS_NAME'
  | 'CALL_TO_ACTION_SELECTION' | 'MARKETING_IMAGE' | 'SQUARE_MARKETING_IMAGE'
  | 'PORTRAIT_MARKETING_IMAGE' | 'LOGO' | 'LANDSCAPE_LOGO' | 'YOUTUBE_VIDEO';

export type AssetTextFieldType = 'HEADLINE' | 'LONG_HEADLINE' | 'DESCRIPTION' | 'BUSINESS_NAME';

export const ASSET_TEXT_LIMITS: Record<AssetTextFieldType, number> = {
  HEADLINE: 30,
  LONG_HEADLINE: 90,
  DESCRIPTION: 90,
  BUSINESS_NAME: 25,
};

export type MutatePayload =
  | {
      action: 'pause' | 'enable';
      level: 'campaign' | 'ad_group' | 'asset_group' | 'ad' | 'keyword';
      brand_id: number;
      customer_id: string;
      campaign_id?: string;
      ad_group_id?: string;
      asset_group_id?: string;
      ad_id?: string;
      criterion_id?: string;
      dry_run: boolean;
    }
  | {
      action: 'update_budget';
      brand_id: number;
      customer_id: string;
      campaign_id: string;
      daily_budget_inr: number;
      dry_run: boolean;
    }
  | {
      action: 'add_negative_keyword';
      scope: 'campaign' | 'ad_group';
      brand_id: number;
      customer_id: string;
      campaign_id?: string;
      ad_group_id?: string;
      text: string;
      match_type: 'EXACT' | 'PHRASE' | 'BROAD';
      dry_run: boolean;
    }
  | {
      action: 'add_keyword';
      brand_id: number;
      customer_id: string;
      ad_group_id: string;
      text: string;
      match_type: 'EXACT' | 'PHRASE' | 'BROAD';
      dry_run: boolean;
    }
  | {
      action: 'update_campaign_settings';
      brand_id: number;
      customer_id: string;
      campaign_id: string;
      name?: string;
      start_date?: string;
      end_date?: string;
      target_roas?: number;
      target_cpa_inr?: number;
      dry_run: boolean;
    }
  | {
      action: 'create_search_campaign';
      brand_id: number;
      customer_id: string;
      name: string;
      daily_budget_inr: number;
      bid_strategy: 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE' | 'TARGET_CPA' | 'TARGET_ROAS';
      target_cpa_inr?: number;
      target_roas?: number;
      start_date?: string;
      end_date?: string;
      geo_target_ids?: string[];
      language_ids?: string[];
      search_partners?: boolean;
      content_network?: boolean;
      dry_run: boolean;
    }
  | {
      action: 'pause_asset' | 'enable_asset' | 'remove_asset';
      brand_id: number;
      customer_id: string;
      asset_group_id: string;
      asset_id: string;
      field_type: AssetFieldType;
      dry_run: boolean;
    }
  | {
      action: 'add_text_asset';
      brand_id: number;
      customer_id: string;
      asset_group_id: string;
      field_type: AssetTextFieldType;
      text: string;
      dry_run: boolean;
    };

export interface AuditEntry {
  id: number;
  username: string | null;
  action: string;
  brand_name: string | null;
  customer_id: string | null;
  target_resource: string | null;
  before: unknown;
  after: unknown;
  dry_run: boolean;
  response: unknown;
  created_at: number;
}

export interface NetworkSplitEntry {
  network: string;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
}

export interface DailyInsight {
  kind: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
  campaign_name?: string;
  detail: Record<string, unknown>;
}

export interface DiagnoseResult {
  campaign_id: string;
  campaign_name?: string;
  channel_type?: string;
  metric: string;
  metric_label: string;
  unit: 'INR' | '%' | 'x' | 'count';
  current_value: number;
  brand_avg?: number;
  channel_avg?: number;
  prev_period_value?: number;
  trend: Array<{ date: string; value: number }>;
  signals: Array<{ label: string; value: string | number; note?: string; severity?: 'info' | 'warn' | 'high' }>;
  contributors?: Array<{ label: string; columns: string[]; rows: Array<{ name: string; metric: number; secondary?: Record<string, number | string> }> }>;
  observations: string[];
}

export interface CampaignBreakdown {
  channel_type: string;
  by_device: Array<{ device: string; cost: number; impressions: number; clicks: number }>;
  by_network: Array<{ network: string; cost: number; impressions: number; clicks: number }>;
  placements: Array<{
    placement_type: string;
    target_url?: string;
    display_name?: string;
    cost: number;
    impressions: number;
    clicks: number;
  }>;
  // PMax-only: YouTube placement detail (impressions only — cost not exposed)
  pmax_placements_by_type?: Record<string, number>;
  pmax_top_placements?: Array<{
    placement_type: string;
    target_url?: string;
    display_name?: string;
    placement?: string;
    impressions: number;
  }>;
  pmax_total_impr?: number;
  // PMax channel split (Search/Display/YouTube/Shared/Other) derived from
  // asset-level cost attribution via channel_aggregate_asset_view
  pmax_channel_split?: Array<{
    channel: string;
    cost: number;
    impressions: number;
    clicks: number;
    conversions: number;
  }>;
  network_breakdown_available: boolean;
  placement_breakdown_available: boolean;
  notes: string[];
}

export interface BrandPayload {
  name: string;
  rto_factor: number;
  revenue_rto_factor?: number;
  rto_mode: 'flat' | 'csv' | 'redshift';
  account_ids: string[];
}

export interface PerfParams {
  brand_id: number;
  from: string;
  to: string;
  compare_from?: string;
  compare_to?: string;
  campaign_id?: string;
  ad_group_id?: string;
  asset_group_id?: string;
}

export interface DerivedMetrics {
  cost: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversions_value: number;
  ctr: number;
  cpc: number;
  cpm: number;
  cpa: number;
  roas_pre_rto: number;
  conversions_value_post_rto: number;
  roas_post_rto: number;
  // Redshift-sourced (post-RTO from internal funnel)
  ncs: number | null;
  ncs_amount: number | null;
  aov: number | null;
  calc_cpa: number | null;
  calc_roas: number | null;
}

export interface PerfRow {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  ad_group_id?: string;
  ad_group_name?: string;
  asset_group_id?: string;
  asset_group_name?: string;
  ad_strength?: string;
  path1?: string;
  path2?: string;
  ad_id?: string;
  ad_name?: string;
  ad_type?: string;
  status?: string;
  channel_type?: string;
  daily_budget_inr?: number;
  cpc_bid_inr?: number;
  headlines?: string[];
  descriptions?: string[];
  final_urls?: string[];
  // keyword
  criterion_id?: string;
  keyword_text?: string;
  match_type?: string;
  quality_score?: number;
  // search term
  search_term?: string;
  // synthetic "Other PMax"/"Other Search" rows for residual unattributed NCs
  synthetic?: boolean;
  synthetic_samples?: string[];
  metrics: DerivedMetrics;
  comparison?: DerivedMetrics;
}
