import { listAccessibleCustomers, listClientsUnderMcc, type ChildCustomer } from './google-ads.js';

/**
 * Lazy in-memory cache that maps every accessible customer_id to:
 *   - the MCC to use as login-customer-id (for queries), and
 *   - basic metadata (name, currency, manager flag).
 *
 * Built by:
 *   1. listAccessibleCustomers — gets directly-granted accounts
 *   2. For each accessible MCC, query customer_client to enumerate children
 *
 * Cached for 1 hour. Refresh button on the UI can force a reload (TODO).
 */

interface AccountEntry {
  customer_id: string;
  descriptive_name?: string;
  currency_code?: string;
  time_zone?: string;
  is_manager: boolean;
  status: string;
  /** MCC to set as login-customer-id when querying this account. Self for top-level MCCs. */
  login_customer_id: string | null;
  /** Where this entry was discovered. */
  source: 'direct' | 'mcc-child';
}

interface CacheState {
  accounts: AccountEntry[];
  byId: Map<string, AccountEntry>;
  builtAt: number;
}

const TTL_MS = 60 * 60 * 1000;
let cache: CacheState | null = null;
let inflight: Promise<CacheState> | null = null;

export async function getAllAccounts(force = false): Promise<AccountEntry[]> {
  const state = await ensureCache(force);
  return state.accounts;
}

export async function getLoginCustomerId(customerId: string): Promise<string | null> {
  const state = await ensureCache(false);
  return state.byId.get(customerId)?.login_customer_id ?? null;
}

export async function getAccountEntry(customerId: string): Promise<AccountEntry | null> {
  const state = await ensureCache(false);
  return state.byId.get(customerId) ?? null;
}

async function ensureCache(force: boolean): Promise<CacheState> {
  if (!force && cache && Date.now() - cache.builtAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = buildCache().finally(() => { inflight = null; });
  cache = await inflight;
  return cache;
}

async function buildCache(): Promise<CacheState> {
  const directIds = await listAccessibleCustomers();
  const byId = new Map<string, AccountEntry>();

  // First pass: stub each directly-granted ID. Manager accounts get expanded next.
  for (const id of directIds) {
    byId.set(id, {
      customer_id: id,
      is_manager: false,
      status: 'UNKNOWN',
      login_customer_id: null, // assume direct grant works without login-customer-id (will be updated below)
      source: 'direct',
    });
  }

  // Identify managers among direct grants by hitting getCustomerInfo (cheap).
  // Then for each manager, enumerate children via customer_client.
  const managers: string[] = [];
  await Promise.all(directIds.map(async (id) => {
    try {
      const { getCustomerInfo } = await import('./google-ads.js');
      const info = await getCustomerInfo(id);
      const entry = byId.get(id);
      if (!entry) return;
      if (info) {
        entry.descriptive_name = info.descriptiveName;
        entry.currency_code = info.currencyCode;
        entry.time_zone = info.timeZone;
        entry.is_manager = info.manager ?? false;
        entry.status = 'ENABLED';
        if (entry.is_manager) managers.push(id);
      }
    } catch {
      // direct-grant probe failed — leave stub
    }
  }));

  // For each accessible manager, enumerate all children via customer_client
  for (const mccId of managers) {
    let children: ChildCustomer[] = [];
    try {
      children = await listClientsUnderMcc(mccId);
    } catch (err) {
      console.error(`[mcc-map] listClientsUnderMcc(${mccId}) failed:`, err instanceof Error ? err.message : String(err));
      continue;
    }
    for (const child of children) {
      const existing = byId.get(child.id);
      // For any account under an MCC, route queries via the MCC. This works even
      // for direct-grant accounts (verified — login-customer-id is permissive).
      const entry: AccountEntry = {
        customer_id: child.id,
        descriptive_name: child.descriptiveName,
        currency_code: child.currencyCode,
        time_zone: child.timeZone,
        is_manager: child.manager,
        status: child.status,
        login_customer_id: mccId,
        source: existing?.source === 'direct' ? 'direct' : 'mcc-child',
      };
      byId.set(child.id, entry);
    }
  }

  // Sort: direct first, then by name
  const accounts = Array.from(byId.values()).sort((a, b) => {
    if (a.source !== b.source) return a.source === 'direct' ? -1 : 1;
    return (a.descriptive_name ?? a.customer_id).localeCompare(b.descriptive_name ?? b.customer_id);
  });
  console.log(`[mcc-map] built: ${accounts.length} accounts (${directIds.length} direct, ${accounts.length - directIds.length} via MCC)`);

  return { accounts, byId, builtAt: Date.now() };
}

export function clearMccMapCache(): void {
  cache = null;
}
