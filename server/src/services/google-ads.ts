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
