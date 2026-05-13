/**
 * Enriches audience criterion rows with human-readable names.
 *
 * Google's campaign_audience_view returns `display_name` populated with internal
 * codes for USER_INTEREST (e.g. "uservertical::80412") instead of the catalog
 * name. To get readable labels we look up the underlying resources:
 *   - USER_INTEREST → user_interest.name + taxonomy_type (AFFINITY / IN_MARKET / DETAILED_DEMOGRAPHIC / etc.)
 *
 * USER_LIST and CUSTOM_AUDIENCE typically already have populated display_name,
 * so they don't need enrichment.
 *
 * Lookups are cached per customer for the life of the process — the catalog is
 * effectively static and shared across queries.
 */

import { search } from './google-ads.js';

interface UserInterestInfo {
  name: string;
  taxonomyType: string;
}

const userInterestCache = new Map<string, Map<string, UserInterestInfo>>(); // customer_id → id → info

function getCustomerCache(customerId: string): Map<string, UserInterestInfo> {
  let m = userInterestCache.get(customerId);
  if (!m) { m = new Map(); userInterestCache.set(customerId, m); }
  return m;
}

function idFromResource(resource: string | undefined): string | null {
  if (!resource) return null;
  const m = resource.match(/userInterests\/(\d+)/);
  return m?.[1] ?? null;
}

interface UserInterestRow {
  userInterest?: { userInterestId?: string; name?: string; taxonomyType?: string };
}

export async function loadUserInterestNames(
  customerId: string,
  resourceNames: Iterable<string>,
  loginCustomerId?: string,
): Promise<Map<string, UserInterestInfo>> {
  const cache = getCustomerCache(customerId);
  const wantedIds = new Set<string>();
  for (const r of resourceNames) {
    const id = idFromResource(r);
    if (id && !cache.has(id)) wantedIds.add(id);
  }
  if (!wantedIds.size) return cache;

  // Batch in groups of 1000 — GAQL IN clauses tolerate large lists but we keep it sane.
  const ids = Array.from(wantedIds);
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const inList = chunk.join(', ');
    const query = `SELECT user_interest.user_interest_id, user_interest.name, user_interest.taxonomy_type
                   FROM user_interest
                   WHERE user_interest.user_interest_id IN (${inList})`;
    try {
      const rows = await search<UserInterestRow>({ customerId, loginCustomerId, query });
      for (const r of rows) {
        const ui = r.userInterest;
        if (ui?.userInterestId && ui.name) {
          cache.set(ui.userInterestId, {
            name: ui.name,
            taxonomyType: ui.taxonomyType ?? 'UNKNOWN',
          });
        }
      }
    } catch (err) {
      // Best-effort enrichment — fall back to coded labels on failure.
      console.warn('[audience-enrich] user_interest lookup failed:',
        err instanceof Error ? err.message : String(err));
    }
  }
  return cache;
}

/**
 * Given a USER_INTEREST resource name, return a human-readable label like
 * "Shoppers (Affinity)" or "Beauty Products (In Market)", falling back to the
 * original coded label if we couldn't resolve it.
 */
export function userInterestLabel(
  resourceName: string | undefined,
  cache: Map<string, UserInterestInfo>,
  fallback: string,
): string {
  const id = idFromResource(resourceName);
  if (!id) return fallback;
  const info = cache.get(id);
  if (!info) return fallback;
  const tax = formatTaxonomy(info.taxonomyType);
  return tax ? `${info.name} (${tax})` : info.name;
}

function formatTaxonomy(t: string): string {
  switch (t) {
    case 'AFFINITY': return 'Affinity';
    case 'IN_MARKET': return 'In Market';
    case 'DETAILED_DEMOGRAPHIC': return 'Detailed Demographic';
    case 'LIFE_EVENT': return 'Life Event';
    case 'NEW_SMART_PHONE_USER': return 'New Smartphone User';
    default: return '';
  }
}
