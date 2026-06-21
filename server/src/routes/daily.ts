import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getBrand } from '../services/brands.js';
import { search } from '../services/google-ads.js';
import { getLoginCustomerId } from '../services/mcc-map.js';
import { fetchDaily, fetchByCampaignDaily } from '../services/redshift.js';
import { getDb } from '../db/init.js';
import { buildAdIdToCampaignIdMap, buildSkuToCampaignIdMap, buildAssetGroupNameToCampaignIdMap, buildUtmCampaignFromFinalUrlsMap } from './performance.js';

/**
 * Per-day brand-wide summary. Spend / conversions come from Google Ads
 * (segments.date), NCs / NC amount from Redshift (GROUP BY dt). Both joined on
 * date and RTO-adjusted client-side for display consistency with the rest of
 * the dashboard.
 *
 * Designed to extend to per-campaign and per-product drill-downs by adding a
 * `group_by` param — for now this v1 returns brand totals only.
 */

const querySchema = z.object({
  brand_id: z.coerce.number(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  group_by: z.enum(['brand', 'campaign']).default('brand'),
});

interface DailyRow {
  date: string;
  cost: number;
  impressions: number;
  clicks: number;
  conversions: number;          // Google-reported (gross)
  conversions_value: number;    // Google-reported (gross)
  conversions_post_rto: number; // × (1 − rto_factor)
  conversions_value_post_rto: number;
  ncs: number;                  // Redshift, post-RTO
  ncs_amount: number;           // Redshift, post-RTO
  aov: number;
  calc_roas: number;            // ncs_amount / cost
  calc_cpa: number;             // cost / ncs
  google_roas: number;          // conversions_value × (1 − rto) / cost
  google_cpa: number;           // cost / (conversions × (1 − rto))
  ctr: number;                  // clicks / impressions
  cpc: number;                  // cost / clicks
}

export async function dailyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { brand_id, from, to, group_by } = parsed.data;
    const brand = getBrand(brand_id);
    if (!brand) return reply.code(404).send({ error: 'Brand not found' });
    if (!brand.accounts.length) return { rows: [], rto_factor: brand.rto_factor ?? 0 };

    if (group_by === 'campaign') {
      return buildCampaignPivot(brand, from, to, app);
    }

    // Daily spend / conversions from Google Ads — one query per linked customer.
    interface DayBucket { cost: number; conv: number; convVal: number; impr: number; clicks: number }
    const byDay = new Map<string, DayBucket>();
    await Promise.all(brand.accounts.map(async (acc) => {
      const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
      try {
        const rows = await search<{
          segments?: { date?: string };
          metrics?: { costMicros?: string; conversions?: number; conversionsValue?: number; impressions?: string; clicks?: string };
        }>({
          customerId: acc.customer_id, loginCustomerId,
          query: `SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.impressions, metrics.clicks
                  FROM campaign
                  WHERE segments.date BETWEEN '${from}' AND '${to}' AND campaign.status != 'REMOVED'`,
        });
        for (const r of rows) {
          const d = r.segments?.date; if (!d) continue;
          const prev = byDay.get(d) ?? { cost: 0, conv: 0, convVal: 0, impr: 0, clicks: 0 };
          prev.cost += Number(r.metrics?.costMicros ?? 0) / 1_000_000;
          prev.conv += Number(r.metrics?.conversions ?? 0);
          prev.convVal += Number(r.metrics?.conversionsValue ?? 0);
          prev.impr += Number(r.metrics?.impressions ?? 0);
          prev.clicks += Number(r.metrics?.clicks ?? 0);
          byDay.set(d, prev);
        }
      } catch (err) {
        app.log.warn({ customer_id: acc.customer_id, err: err instanceof Error ? err.message : String(err) }, 'daily Google Ads fetch failed for customer');
      }
    }));

    // Daily NCs from Redshift if brand is on redshift mode.
    const ncsByDay = new Map<string, { ncs: number; amount: number }>();
    if (brand.rto_mode === 'redshift') {
      const cfg = getDb()
        .prepare('SELECT funnel_table, utm_source_list, enabled FROM brand_redshift_config WHERE brand_id = ?')
        .get(brand_id) as { funnel_table: string | null; utm_source_list: string | null; enabled: number } | undefined;
      if (cfg?.enabled && cfg.funnel_table) {
        let utmSourceList: string[] = [];
        try { utmSourceList = JSON.parse(cfg.utm_source_list ?? '[]'); } catch { /* ignore */ }
        if (utmSourceList.length) {
          try {
            const rs = await fetchDaily({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: from, dateTo: to });
            for (const r of rs) ncsByDay.set(r.date, { ncs: r.ncs, amount: r.amount });
          } catch (err) {
            app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'daily Redshift fetch failed');
          }
        }
      }
    }

    const rtoFactor = brand.rto_factor ?? 0;
    const rtoMul = Math.max(0, Math.min(1, 1 - rtoFactor));

    const allDates = new Set<string>([...byDay.keys(), ...ncsByDay.keys()]);
    const rows: DailyRow[] = [...allDates].sort().map((date) => {
      const g = byDay.get(date) ?? { cost: 0, conv: 0, convVal: 0, impr: 0, clicks: 0 };
      const n = ncsByDay.get(date) ?? { ncs: 0, amount: 0 };
      const ncsAdj = n.ncs * rtoMul;
      const amtAdj = n.amount * rtoMul;
      const convAdj = g.conv * rtoMul;
      const convValAdj = g.convVal * rtoMul;
      return {
        date,
        cost: g.cost, impressions: g.impr, clicks: g.clicks,
        conversions: g.conv, conversions_value: g.convVal,
        conversions_post_rto: convAdj, conversions_value_post_rto: convValAdj,
        ncs: ncsAdj, ncs_amount: amtAdj,
        aov: ncsAdj > 0 ? amtAdj / ncsAdj : 0,
        calc_roas: g.cost > 0 ? amtAdj / g.cost : 0,
        calc_cpa: ncsAdj > 0 ? g.cost / ncsAdj : 0,
        google_roas: g.cost > 0 ? convValAdj / g.cost : 0,
        google_cpa: convAdj > 0 ? g.cost / convAdj : 0,
        ctr: g.impr > 0 ? g.clicks / g.impr : 0,
        cpc: g.clicks > 0 ? g.cost / g.clicks : 0,
      };
    });

    return { rows, rto_factor: rtoFactor };
  });
}

/**
 * Pivot mode: rows = campaigns, dates = columns. Per-(date, campaign) NCs are
 * produced by applying the SAME utm_campaign attribution the Campaigns tab uses
 * (numeric → campaign_id, SKU → Shopping, asset-group name → equal-split among
 * active siblings, byName fallback) — but at daily granularity. So each cell's
 * Calc-ROAS reflects that campaign's actual ROAS on that day, not a spend-share
 * approximation.
 *
 * Unattributable per-(date) NCs (null utm_campaign, paused-only siblings, etc.)
 * flow into a per-date "Other" pseudo-campaign row so totals still reconcile.
 */
async function buildCampaignPivot(
  brand: NonNullable<ReturnType<typeof getBrand>>, from: string, to: string, app: { log: { warn: (...a: unknown[]) => void } }
): Promise<{ rows: PivotRow[]; dates: string[]; rto_factor: number; brand_daily: BrandDailyTotal[] }> {
  // 1) Per-(customer|campaign, date) Google-Ads cost / conversions.
  interface CampMeta { name: string; channel_type: string; status: string; customer_id: string; campaign_id: string }
  const campMeta = new Map<string, CampMeta>();
  const cellByKey = new Map<string, { cost: number; conv: number; convVal: number; impr: number; clicks: number }>();
  const cidOf = (customer: string, campaign: string): string => `${customer}|${campaign}`;
  const accountIds = brand.accounts.map((a) => a.customer_id);
  await Promise.all(brand.accounts.map(async (acc) => {
    const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
    try {
      const rows = await search<{
        campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string };
        segments?: { date?: string };
        metrics?: { costMicros?: string; conversions?: number; conversionsValue?: number; impressions?: string; clicks?: string };
      }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                       segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value,
                       metrics.impressions, metrics.clicks
                FROM campaign
                WHERE segments.date BETWEEN '${from}' AND '${to}' AND campaign.status != 'REMOVED'`,
      });
      for (const r of rows) {
        const id = r.campaign?.id; const d = r.segments?.date;
        if (!id || !d) continue;
        const cid = cidOf(acc.customer_id, id);
        if (!campMeta.has(cid)) campMeta.set(cid, {
          name: r.campaign?.name ?? '', channel_type: r.campaign?.advertisingChannelType ?? '',
          status: r.campaign?.status ?? '', customer_id: acc.customer_id, campaign_id: id,
        });
        const k = `${cid}|${d}`;
        const cur = cellByKey.get(k) ?? { cost: 0, conv: 0, convVal: 0, impr: 0, clicks: 0 };
        cur.cost += Number(r.metrics?.costMicros ?? 0) / 1_000_000;
        cur.conv += Number(r.metrics?.conversions ?? 0);
        cur.convVal += Number(r.metrics?.conversionsValue ?? 0);
        cur.impr += Number(r.metrics?.impressions ?? 0);
        cur.clicks += Number(r.metrics?.clicks ?? 0);
        cellByKey.set(k, cur);
      }
    } catch (err) {
      app.log.warn({ customer_id: acc.customer_id, err: err instanceof Error ? err.message : String(err) }, 'daily campaign-pivot Google Ads fetch failed for customer');
    }
  }));

  // Pull the un-segmented list of every non-removed campaign too — so a
  // paused / zero-activity campaign that received late-attribution NCs via
  // its numeric utm_campaign still resolves into knownCampaignIds and lands
  // on its own row (same set the Campaigns tab works with). Without this the
  // daily totals drift from the Campaigns tab on those edge-case campaigns.
  await Promise.all(brand.accounts.map(async (acc) => {
    const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
    try {
      const rows = await search<{ campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
                FROM campaign WHERE campaign.status != 'REMOVED'`,
      });
      for (const r of rows) {
        const id = r.campaign?.id; if (!id) continue;
        const cid = cidOf(acc.customer_id, id);
        if (campMeta.has(cid)) continue;
        campMeta.set(cid, {
          name: r.campaign?.name ?? '', channel_type: r.campaign?.advertisingChannelType ?? '',
          status: r.campaign?.status ?? '', customer_id: acc.customer_id, campaign_id: id,
        });
      }
    } catch (err) {
      app.log.warn({ customer_id: acc.customer_id, err: err instanceof Error ? err.message : String(err) }, 'daily un-segmented campaign-list fetch failed');
    }
  }));

  // PER-DATE active set for the asset-group equal-split. A PMax campaign
  // that was paused on the conversion date can't have driven that day's
  // asset-group click → it must not be a denominator on that date. (Window-
  // level active was over-attributing to campaigns paused mid-window.)
  // activeByDate[date] = Set<campaign_id> with cost > 0 on that date.
  const activeByDate = new Map<string, Set<string>>();
  const knownCampaignIds = new Set<string>();
  const nameToCampaignId = new Map<string, string>();
  const normNameToCampaignId = new Map<string, string>();
  const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const [cid, meta] of campMeta) {
    knownCampaignIds.add(meta.campaign_id);
    if (meta.name) {
      nameToCampaignId.set(meta.name.toLowerCase(), meta.campaign_id);
      normNameToCampaignId.set(normalize(meta.name), meta.campaign_id);
    }
  }
  for (const [key, cell] of cellByKey) {
    if ((cell.cost ?? 0) <= 0) continue;
    // Key shape is `${customer}|${campaign}|${date}`. Date may contain '-'
    // but not '|', so split on '|' and take the trailing piece.
    const parts = key.split('|');
    const date = parts[parts.length - 1];
    const campaignId = parts[1];
    if (!date || !campaignId) continue;
    let set = activeByDate.get(date);
    if (!set) { set = new Set(); activeByDate.set(date, set); }
    set.add(campaignId);
  }

  // 2) Brand-daily totals + per-(date, utm_campaign) Redshift rows + the three
  //    attribution maps from Google Ads, all in parallel.
  const cfg = getDb()
    .prepare('SELECT funnel_table, utm_source_list, utm_campaign_aliases, enabled FROM brand_redshift_config WHERE brand_id = ?')
    .get(brand.id) as { funnel_table: string | null; utm_source_list: string | null; utm_campaign_aliases: string | null; enabled: number } | undefined;
  let utmSourceList: string[] = [];
  try { utmSourceList = JSON.parse(cfg?.utm_source_list ?? '[]'); } catch { /* ignore */ }
  let aliases: Record<string, string> = {};
  try {
    const raw = JSON.parse(cfg?.utm_campaign_aliases ?? '{}');
    if (raw && typeof raw === 'object') {
      aliases = Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
    }
  } catch { /* ignore */ }

  const brandDailyMap = new Map<string, { ncs: number; amount: number }>();
  // (date, utm_source, utm_campaign) Redshift rows
  let dailyRs: Array<{ date: string; utm_source: string; utm_campaign: string; ncs: number; amount: number }> = [];
  // attribution maps
  let adIdToCampaignId = new Map<string, string>();
  let skuToCampaignId = new Map<string, string>();
  let agNameToCampaignId = new Map<string, string[]>();
  let utmFinalUrlsMap = new Map<string, string[]>();
  if (brand.rto_mode === 'redshift' && cfg?.enabled && cfg.funnel_table && utmSourceList.length) {
    try {
      const [brandDaily, perDayRs, adMap, skuMap, agMap, finalMap] = await Promise.all([
        fetchDaily({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: from, dateTo: to }),
        fetchByCampaignDaily({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: from, dateTo: to }),
        buildAdIdToCampaignIdMap(accountIds),
        buildSkuToCampaignIdMap(accountIds, from, to),
        buildAssetGroupNameToCampaignIdMap(accountIds, from, to),
        buildUtmCampaignFromFinalUrlsMap(accountIds),
      ]);
      for (const r of brandDaily) brandDailyMap.set(r.date, { ncs: r.ncs, amount: r.amount });
      dailyRs = perDayRs;
      adIdToCampaignId = adMap; skuToCampaignId = skuMap; agNameToCampaignId = agMap; utmFinalUrlsMap = finalMap;
    } catch (err) {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'daily Redshift / attribution fetch failed');
    }
  }

  // 3) Apply real attribution per-(date, utm_campaign) row. Bucket NCs by
  //    (campaign_id, date). Mirror mergeRedshiftMetrics rules exactly.
  // ncsByCampaignDate[campaign_id][date] = { ncs, amount }
  const ncsByCampaignDate = new Map<string, Map<string, { ncs: number; amount: number }>>();
  // unattributed → ncsByOtherDate[utm_source][date] (for "Other Channel" rows)
  const otherByDate = new Map<string, Map<string, { ncs: number; amount: number; samples: string[] }>>();
  const addToCampaignDate = (campaignId: string, date: string, ncs: number, amount: number): void => {
    let byDate = ncsByCampaignDate.get(campaignId);
    if (!byDate) { byDate = new Map(); ncsByCampaignDate.set(campaignId, byDate); }
    const prev = byDate.get(date) ?? { ncs: 0, amount: 0 };
    byDate.set(date, { ncs: prev.ncs + ncs, amount: prev.amount + amount });
  };
  const addToOther = (source: string, date: string, ncs: number, amount: number, sample: string): void => {
    let byDate = otherByDate.get(source);
    if (!byDate) { byDate = new Map(); otherByDate.set(source, byDate); }
    const prev = byDate.get(date) ?? { ncs: 0, amount: 0, samples: [] };
    if (prev.samples.length < 5 && sample && !prev.samples.includes(sample)) prev.samples.push(sample);
    byDate.set(date, { ncs: prev.ncs + ncs, amount: prev.amount + amount, samples: prev.samples });
  };

  for (const r of dailyRs) {
    if (/^\d+$/.test(r.utm_campaign)) {
      const target = adIdToCampaignId.get(r.utm_campaign) ?? r.utm_campaign;
      if (knownCampaignIds.has(target)) { addToCampaignDate(target, r.date, r.ncs, r.amount); continue; }
      addToOther(r.utm_source, r.date, r.ncs, r.amount, r.utm_campaign); continue;
    }
    const aliased = aliases[r.utm_campaign.toLowerCase()] ?? r.utm_campaign;
    const lcKey = aliased.toLowerCase();
    const normKey = normalize(aliased);
    // 1) SKU → Shopping
    const skuTarget = skuToCampaignId.get(lcKey);
    if (skuTarget && knownCampaignIds.has(skuTarget)) { addToCampaignDate(skuTarget, r.date, r.ncs, r.amount); continue; }
    // 1.5) utm_campaign value present in some campaign's asset_group.final_urls
    //      → equal-split across campaigns active that date (the authoritative
    //      map; preferred over fuzzy asset-group-NAME matching below).
    const finalUrlTargets = utmFinalUrlsMap.get(lcKey) ?? utmFinalUrlsMap.get(normKey);
    if (finalUrlTargets && finalUrlTargets.length) {
      const activeToday = activeByDate.get(r.date) ?? new Set<string>();
      const active = finalUrlTargets.filter((cid) => activeToday.has(cid) && knownCampaignIds.has(cid));
      if (active.length) {
        const share = { ncs: r.ncs / active.length, amount: r.amount / active.length };
        for (const cid of active) addToCampaignDate(cid, r.date, share.ncs, share.amount);
        continue;
      }
      // None of the canonical owners active that day — fall through to
      // asset_group-name match (then to Other if that also fails).
    }
    // 2) asset_group name → equal split across siblings ACTIVE ON THIS DATE.
    //    Asset-group attribution is the only path that can't tell us which
    //    specific campaign drove the NC, so the 1/N split must exclude
    //    campaigns that weren't running on the conversion date — otherwise
    //    a campaign paused mid-window keeps absorbing credit it couldn't have
    //    earned. If no sibling was active that day → unattributed → Other.
    const agTargets = agNameToCampaignId.get(lcKey) ?? agNameToCampaignId.get(normKey);
    if (agTargets && agTargets.length) {
      const activeToday = activeByDate.get(r.date) ?? new Set<string>();
      const active = agTargets.filter((cid) => activeToday.has(cid));
      if (active.length) {
        const share = { ncs: r.ncs / active.length, amount: r.amount / active.length };
        for (const cid of active) addToCampaignDate(cid, r.date, share.ncs, share.amount);
        continue;
      }
      addToOther(r.utm_source, r.date, r.ncs, r.amount, r.utm_campaign); continue;
    }
    // 3) byName fuzzy → matching campaign
    const nameTarget = nameToCampaignId.get(lcKey) ?? normNameToCampaignId.get(normKey);
    if (nameTarget) { addToCampaignDate(nameTarget, r.date, r.ncs, r.amount); continue; }
    // 4) nothing matched
    addToOther(r.utm_source, r.date, r.ncs, r.amount, r.utm_campaign);
  }

  // 4) Build the date list + per-day brand spend (for footer reconciliation).
  const brandDaySpend = new Map<string, number>();
  for (const [key, cell] of cellByKey) {
    const date = key.split('|').slice(2).join('|');
    brandDaySpend.set(date, (brandDaySpend.get(date) ?? 0) + cell.cost);
  }
  const dates = [...new Set<string>([...brandDaySpend.keys(), ...brandDailyMap.keys()])].sort();

  // 5) Compose per-campaign rows with cells built from REAL attribution.
  const rtoMul = Math.max(0, Math.min(1, 1 - (brand.rto_factor ?? 0)));
  const rows: PivotRow[] = [];
  for (const [cid, meta] of campMeta) {
    const ncsForCamp = ncsByCampaignDate.get(meta.campaign_id);
    const byDate: Record<string, PivotCell> = {};
    let tCost = 0, tConv = 0, tConvVal = 0, tImpr = 0, tClicks = 0, tNcs = 0, tAmt = 0;
    for (const date of dates) {
      const cell = cellByKey.get(`${cid}|${date}`);
      const cost = cell?.cost ?? 0;
      const dayNcs = (ncsForCamp?.get(date)?.ncs ?? 0) * rtoMul;
      const dayAmt = (ncsForCamp?.get(date)?.amount ?? 0) * rtoMul;
      const convPR = (cell?.conv ?? 0) * rtoMul;
      const convValPR = (cell?.convVal ?? 0) * rtoMul;
      byDate[date] = {
        cost, ncs: dayNcs, amount: dayAmt,
        google_roas: cost > 0 ? convValPR / cost : 0,
        calc_roas: cost > 0 ? dayAmt / cost : 0,
        calc_cpa: dayNcs > 0 ? cost / dayNcs : 0,
        conversions_post_rto: convPR,
      };
      tCost += cost; tConv += cell?.conv ?? 0; tConvVal += cell?.convVal ?? 0;
      tImpr += cell?.impr ?? 0; tClicks += cell?.clicks ?? 0;
      tNcs += dayNcs; tAmt += dayAmt;
    }
    rows.push({
      customer_id: meta.customer_id, campaign_id: meta.campaign_id,
      campaign_name: meta.name, channel_type: meta.channel_type, status: meta.status,
      by_date: byDate,
      totals: {
        cost: tCost, ncs: tNcs, amount: tAmt,
        aov: tNcs > 0 ? tAmt / tNcs : 0,
        calc_roas: tCost > 0 ? tAmt / tCost : 0,
        calc_cpa: tNcs > 0 ? tCost / tNcs : 0,
        google_roas: tCost > 0 ? (tConvVal * rtoMul) / tCost : 0,
        conversions_post_rto: tConv * rtoMul,
        impressions: tImpr, clicks: tClicks,
      },
    });
  }

  // 5b) Synthetic "Other [channel]" pseudo-rows per utm_source → channel.
  for (const [source, byDate] of otherByDate) {
    const channelType = source.toLowerCase().includes('pmax') ? 'PERFORMANCE_MAX'
      : source.toLowerCase().includes('search') ? 'SEARCH'
      : source.toLowerCase().includes('pla') ? 'SHOPPING'
      : source.toLowerCase().includes('dg') || source.toLowerCase().includes('demand') ? 'DEMAND_GEN'
      : 'OTHER';
    const label = channelType === 'PERFORMANCE_MAX' ? 'Other PMax'
      : channelType === 'SEARCH' ? 'Other Search'
      : channelType === 'SHOPPING' ? 'Other Shopping'
      : channelType === 'DEMAND_GEN' ? 'Other Demand Gen'
      : `Other (${source})`;
    const cellsByDate: Record<string, PivotCell> = {};
    let tNcs = 0, tAmt = 0;
    let samplesUnion: string[] = [];
    for (const date of dates) {
      const entry = byDate.get(date);
      const ncs = (entry?.ncs ?? 0) * rtoMul;
      const amount = (entry?.amount ?? 0) * rtoMul;
      cellsByDate[date] = {
        cost: 0, ncs, amount,
        google_roas: 0, calc_roas: 0, calc_cpa: 0, conversions_post_rto: 0,
      };
      tNcs += ncs; tAmt += amount;
      if (entry?.samples) for (const s of entry.samples) if (!samplesUnion.includes(s) && samplesUnion.length < 5) samplesUnion.push(s);
    }
    if (tNcs > 0 || tAmt > 0) {
      rows.push({
        customer_id: '', campaign_id: `__synthetic_${source}`,
        campaign_name: label + (samplesUnion.length ? ` · samples: ${samplesUnion.join(', ')}` : ''),
        channel_type: channelType, status: 'SYNTHETIC',
        by_date: cellsByDate,
        totals: {
          cost: 0, ncs: tNcs, amount: tAmt,
          aov: tNcs > 0 ? tAmt / tNcs : 0,
          calc_roas: 0, calc_cpa: 0, google_roas: 0,
          conversions_post_rto: 0, impressions: 0, clicks: 0,
        },
      });
    }
  }

  // Sort campaigns by total spend desc; "Other" synthetics fall to the bottom
  // (zero cost) where they belong.
  rows.sort((a, b) => b.totals.cost - a.totals.cost);

  const brand_daily: BrandDailyTotal[] = dates.map((date) => {
    const dayBrand = brandDailyMap.get(date) ?? { ncs: 0, amount: 0 };
    const cost = brandDaySpend.get(date) ?? 0;
    return { date, cost, ncs: dayBrand.ncs * rtoMul, amount: dayBrand.amount * rtoMul };
  });

  return { rows, dates, rto_factor: brand.rto_factor ?? 0, brand_daily };
}

interface PivotCell {
  cost: number;
  ncs: number;
  amount: number;
  google_roas: number;
  calc_roas: number;
  calc_cpa: number;
  conversions_post_rto: number;
}

interface PivotRow {
  customer_id: string;
  campaign_id: string;
  campaign_name: string;
  channel_type: string;
  status: string;
  by_date: Record<string, PivotCell>;
  totals: {
    cost: number; ncs: number; amount: number; aov: number;
    calc_roas: number; calc_cpa: number; google_roas: number;
    conversions_post_rto: number; impressions: number; clicks: number;
  };
}

interface BrandDailyTotal {
  date: string;
  cost: number;
  ncs: number;
  amount: number;
}
