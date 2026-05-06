import { config } from '../config.js';
import { getAccessToken } from './token.js';

const BASE = 'https://googleads.googleapis.com';

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    'developer-token': config.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };
}

export async function listAccessibleCustomers(): Promise<string[]> {
  const url = `${BASE}/${config.GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`;
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`listAccessibleCustomers ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { resourceNames?: string[] };
  return (body.resourceNames ?? []).map((n) => n.replace(/^customers\//, ''));
}

export interface GaqlSearchOptions {
  customerId: string;
  query: string;
}

export async function search<T = unknown>(opts: GaqlSearchOptions): Promise<T[]> {
  const url = `${BASE}/${config.GOOGLE_ADS_API_VERSION}/customers/${opts.customerId}/googleAds:search`;
  const results: T[] = [];
  let pageToken: string | undefined;

  do {
    const body: Record<string, unknown> = { query: opts.query };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(url, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`search ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { results?: T[]; nextPageToken?: string };
    if (json.results) results.push(...json.results);
    pageToken = json.nextPageToken;
  } while (pageToken);

  return results;
}

export async function getCustomerInfo(customerId: string): Promise<{
  id: string;
  descriptiveName?: string;
  currencyCode?: string;
  timeZone?: string;
  manager?: boolean;
} | null> {
  const rows = await search<{ customer: { id: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean } }>({
    customerId,
    query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1',
  });
  return rows[0]?.customer ?? null;
}

/**
 * Calls the googleAds:mutate endpoint with the given operations.
 * If validateOnly is true, Google returns errors without committing.
 */
export async function mutate(
  customerId: string,
  operations: Array<Record<string, unknown>>,
  validateOnly: boolean
): Promise<unknown> {
  const url = `${BASE}/${config.GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:mutate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      mutateOperations: operations,
      validateOnly,
      partialFailure: false,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const message = JSON.stringify(json).slice(0, 1000);
    throw new Error(`mutate ${res.status}: ${message}`);
  }
  return json;
}

/**
 * Look up the campaign_budget resource_name for a given campaign — needed to update budget.
 */
export async function getCampaignBudgetResource(
  customerId: string,
  campaignId: string
): Promise<{ resourceName: string; amountMicros: number } | null> {
  const rows = await search<{
    campaignBudget?: { resourceName?: string; amountMicros?: string };
  }>({
    customerId,
    query: `SELECT campaign_budget.resource_name, campaign_budget.amount_micros
            FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`,
  });
  const b = rows[0]?.campaignBudget;
  if (!b?.resourceName) return null;
  return { resourceName: b.resourceName, amountMicros: Number(b.amountMicros ?? 0) };
}
