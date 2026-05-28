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

  brandUtmAliases: (id: number) =>
    request<{ aliases: Record<string, string> }>(`/api/brands/${id}/utm-aliases`),
  brandUtmAliasesUpdate: (id: number, aliases: Record<string, string>) =>
    request<{ ok: true; aliases: Record<string, string> }>(`/api/brands/${id}/utm-aliases`, {
      method: 'PUT',
      body: JSON.stringify({ aliases }),
    }),

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
    compare_from?: string;
    compare_to?: string;
    campaign_id?: string;
    asset_group_id?: string;
  }) => {
    const qs = new URLSearchParams();
    qs.set('brand_id', String(params.brand_id));
    qs.set('from', params.from);
    qs.set('to', params.to);
    if (params.compare_from) qs.set('compare_from', params.compare_from);
    if (params.compare_to) qs.set('compare_to', params.compare_to);
    if (params.campaign_id) qs.set('campaign_id', params.campaign_id);
    if (params.asset_group_id) qs.set('asset_group_id', params.asset_group_id);
    return request<{ rows: AssetRow[] }>(`/api/assets?${qs.toString()}`);
  },

  audiences: (params: {
    brand_id: number;
    from: string;
    to: string;
    compare_from?: string;
    compare_to?: string;
    campaign_id?: string;
  }) => {
    const qs = new URLSearchParams();
    qs.set('brand_id', String(params.brand_id));
    qs.set('from', params.from);
    qs.set('to', params.to);
    if (params.compare_from) qs.set('compare_from', params.compare_from);
    if (params.compare_to) qs.set('compare_to', params.compare_to);
    if (params.campaign_id) qs.set('campaign_id', params.campaign_id);
    return request<{ rows: AudienceRow[] }>(`/api/audiences?${qs.toString()}`);
  },

  products: (params: {
    brand_id: number;
    from: string;
    to: string;
    compare_from?: string;
    compare_to?: string;
    campaign_id?: string;
  }) => {
    const qs = new URLSearchParams();
    qs.set('brand_id', String(params.brand_id));
    qs.set('from', params.from);
    qs.set('to', params.to);
    if (params.compare_from) qs.set('compare_from', params.compare_from);
    if (params.compare_to) qs.set('compare_to', params.compare_to);
    if (params.campaign_id) qs.set('campaign_id', params.campaign_id);
    return request<{ rows: ProductRow[] }>(`/api/products?${qs.toString()}`);
  },

  videoAssets: (params: {
    brand_id: number;
    from: string;
    to: string;
    compare_from?: string;
    compare_to?: string;
    campaign_id?: string;
  }) => {
    const qs = new URLSearchParams();
    qs.set('brand_id', String(params.brand_id));
    qs.set('from', params.from);
    qs.set('to', params.to);
    if (params.compare_from) qs.set('compare_from', params.compare_from);
    if (params.compare_to) qs.set('compare_to', params.compare_to);
    if (params.campaign_id) qs.set('campaign_id', params.campaign_id);
    return request<{ rows: VideoAssetRow[] }>(`/api/video-assets?${qs.toString()}`);
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

  ytChannels: () =>
    request<{ channels: YoutubeChannel[] }>('/api/youtube/channels'),

  ytUploadStart: (body: {
    channel_key: string;
    sheet: string;
    sheet_tab?: string;
    privacy_status?: 'unlisted' | 'private' | 'public';
  }) =>
    request<{ job: YoutubeJob }>('/api/youtube/upload', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  ytJobs: () => request<{ jobs: YoutubeJob[] }>('/api/youtube/jobs'),

  ytJob: (id: number) =>
    request<{ job: YoutubeJob; rows: YoutubeJobRow[] }>(`/api/youtube/jobs/${id}`),

  // ── Recommender ──────────────────────────────────────────────────────
  recommendations: (brandId: number, runDate?: string) => {
    const qs = new URLSearchParams({ brand_id: String(brandId) });
    if (runDate) qs.set('run_date', runDate);
    return request<RecommendationsResponse>(`/api/recommendations?${qs.toString()}`);
  },
  recommendationRun: (brandId: number, windowDays?: number) =>
    request<{ ok: true; run_id: number }>('/api/recommendations/run', {
      method: 'POST',
      body: JSON.stringify({ brand_id: brandId, window_days: windowDays }),
    }),
  recommendationComments: (id: number) =>
    request<{ comments: Array<{ id: number; username: string | null; comment: string; created_at: number }> }>(
      `/api/recommendations/${id}/comments`
    ),
  recommendationAddComment: (id: number, comment: string) =>
    request<{ ok: true }>(`/api/recommendations/${id}/comments`, { method: 'POST', body: JSON.stringify({ comment }) }),
  recommendationSummary: (brandId: number, days = 30) =>
    request<{ summary: Array<{ run_date: string; bucket: string; level: string; suggested: number; actioned: number; rejected: number; pending: number }> }>(
      `/api/recommendations/summary?brand_id=${brandId}&days=${days}`
    ),
  recommendationMix: (brandId: number, window = '7d') =>
    request<{
      date: string | null;
      window?: string;
      run_window_days: number | null;
      mix: {
        channels: Array<{
          channel: string;
          current_share: number; current_spend: number; current_value: number;
          direct_roas: number; halo_bonus: number;
          effective_roas: number; marginal_effective_roas: number;
          recommended_share: number; delta_share: number; delta_spend: number;
          rationale: string;
        }>;
        current_blended_direct_roas: number;
        projected_blended_direct_roas: number;
        total_daily_spend: number;
        total_daily_value: number;
        target_reachable: boolean;
        notes: string[];
      } | null;
      halo_rules: Array<{ channel: string; value: number }>;
    }>(`/api/recommendations/mix?brand_id=${brandId}&window=${window}`),
  recommendationDecide: (
    id: number,
    body: { decision: 'accepted' | 'rejected' | 'overridden'; override_payload?: Record<string, unknown>; reason?: string }
  ) =>
    request<{ ok: true; status: string; audit_log_id?: number | null }>(`/api/recommendations/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  recommendationTrend: (brandId: number, window = '7d') =>
    request<{ series: Array<{ date: string; cost: number; value: number; blended_roas: number }> }>(
      `/api/recommendations/trend?brand_id=${brandId}&window=${window}`
    ),

  rulesList: (brandId: number) => request<{ rules: Rule[] }>(`/api/rules?brand_id=${brandId}`),
  ruleCreate: (body: RulePayload) =>
    request<{ ok: true; id: number }>('/api/rules', { method: 'POST', body: JSON.stringify(body) }),
  ruleUpdate: (id: number, body: Partial<Pick<RulePayload, 'predicate' | 'enabled' | 'is_hard'>>) =>
    request<{ ok: true }>(`/api/rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  ruleDelete: (id: number) => request<{ ok: true }>(`/api/rules/${id}`, { method: 'DELETE' }),
};

export interface Recommendation {
  id: number;
  source: 'rules' | 'engine';
  level: string;
  customer_id: string;
  entity_id: string;
  entity_name: string | null;
  mutate_action: string;
  bucket: string | null;
  user_action: string | null;
  channel_type: string | null;
  comment_count: number;
  mutate_payload: Record<string, unknown>;
  current: Record<string, number> | null;
  proposed: Record<string, number> | null;
  score: number;
  confidence: number;
  expected_impact: { delta_value: number; delta_cost: number } | null;
  hard_constraints: string[] | null;
  reason_codes: string[] | null;
  rationale: string | null;
  diagnosis: string | null;
  status: string;
  audit_log_id: number | null;
}

export interface RecommendationRun {
  id: number;
  brand_id: number;
  run_date: string;
  status: string;
  portfolio_target_roas: number | null;
  current_blended_roas: number | null;
  projected_blended_roas: number | null;
  target_reachable: number | null;
  eval_window_days: number | null;
  notes: string | null;
}

export interface RecommendationsResponse {
  run: RecommendationRun | null;
  rules: Recommendation[];
  engine: Recommendation[];
  diff: Array<{ key: string; in: 'both' | 'rules_only' | 'engine_only'; rank_rules: number | null; rank_engine: number | null }>;
}

export interface Rule {
  id: number;
  brand_id: number | null;
  origin: 'default' | 'manual';
  kind: string;
  scope_level: string | null;
  predicate: { metric: string; channel?: string; campaign_id?: string; value: number; comparator?: string } | null;
  weight: number;
  enabled: boolean;
  is_hard: boolean;
}

export interface RulePayload {
  brand_id: number;
  kind: string;
  scope_level: string;
  predicate: { metric: string; channel?: string; campaign_id?: string; value: number; comparator?: 'gte' | 'lte' };
  is_hard?: boolean;
  enabled?: boolean;
}

export interface YoutubeChannel {
  key: string;
  label: string;
  channelId?: string;
  title?: string;
  thumbnail?: string;
}

export interface YoutubeJob {
  id: number;
  channel_key: string;
  channel_label: string | null;
  sheet_id: string;
  sheet_tab: string | null;
  privacy_status: string;
  status: string;
  total_rows: number;
  done_rows: number;
  error_rows: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface YoutubeJobRow {
  id: number;
  job_id: number;
  sheet_row: number;
  drive_link: string;
  drive_file_id: string | null;
  title: string | null;
  bytes_total: number | null;
  bytes_uploaded: number;
  youtube_video_id: string | null;
  youtube_url: string | null;
  status: string;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface AudienceRow {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  channel_type?: string;
  criterion_id?: string;
  audience_type?: string;
  audience_label?: string;
  metrics: DerivedMetrics;
  comparison?: DerivedMetrics;
}

export interface VideoAssetUsage {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  channel_type?: string;
  group_id?: string;
  group_name?: string;
  group_kind: 'asset_group' | 'ad_group';
  performance_label?: string;
  cost: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface VideoTrendPoint {
  label: string;       // YYYY-MM-DD for daily/weekly, YYYY-MM for monthly
  cost: number;
  impressions: number;
  clicks: number;
}

export interface VideoAssetRow {
  youtube_video_id: string;
  title?: string;
  asset_ids: string[];
  usage_count: number;
  has_conversions_data: boolean;
  best_label?: string;
  usages: VideoAssetUsage[];
  trend: VideoTrendPoint[];
  trend_bucket: 'daily' | 'weekly' | 'monthly';
  metrics: DerivedMetrics;
  comparison?: DerivedMetrics;
}

export interface ProductRow {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  channel_type?: string;
  product_id?: string;
  product_title?: string;
  product_brand?: string;
  product_category?: string;
  metrics: DerivedMetrics;
  comparison?: DerivedMetrics;
}

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
  comparison?: DerivedMetrics;
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
      action: 'update_ad_group_bids';
      brand_id: number;
      customer_id: string;
      ad_group_id: string;
      cpc_bid_inr?: number;
      target_cpa_inr?: number;
      target_roas?: number;
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
  // Extended Google metrics (0 when the view doesn't expose them)
  view_through_conversions?: number;
  all_conversions?: number;
  all_conversions_value?: number;
  cross_device_conversions?: number;
  engagements?: number;
  video_views?: number;
  engagement_rate?: number;
  absolute_top_impression_percentage?: number;
  top_impression_percentage?: number;
  search_impression_share?: number;
  search_top_impression_share?: number;
  search_absolute_top_impression_share?: number;
  search_budget_lost_impression_share?: number;
  search_rank_lost_impression_share?: number;
  average_cpv?: number;
  cpa_all?: number;
  roas_all?: number;
  conversion_rate?: number;
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
  ad_group_target_cpa_inr?: number;
  ad_group_target_roas?: number;
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
