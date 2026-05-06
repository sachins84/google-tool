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
    level: 'campaigns' | 'ad-groups' | 'ads',
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
    return request<{ rows: PerfRow[] }>(`/api/${level}?${qs.toString()}`);
  },
};

export interface BrandPayload {
  name: string;
  rto_factor: number;
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
}

export interface PerfRow {
  customer_id: string;
  campaign_id?: string;
  campaign_name?: string;
  ad_group_id?: string;
  ad_group_name?: string;
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
  metrics: DerivedMetrics;
  comparison?: DerivedMetrics;
}
