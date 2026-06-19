import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getBrand } from '../services/brands.js';
import { search } from '../services/google-ads.js';
import { getLoginCustomerId } from '../services/mcc-map.js';
import { fetchDaily } from '../services/redshift.js';
import { getDb } from '../db/init.js';

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
 * Pivot mode: rows = campaigns, columns = dates, cells = per-(campaign, date)
 * Spend / NCs / amount. Spend from Google Ads is exact; NCs are distributed
 * inside each day proportionally to that campaign's share of the day's brand
 * spend so per-day column totals match the brand-daily Redshift truth. This
 * approximation reuses the brand-level RTO factor and avoids re-running the
 * full per-day attribution pipeline (asset-group equal-split, alias map, etc.)
 * — accurate to within a few % in the common case and reconciles to the
 * brand-daily view by construction.
 */
async function buildCampaignPivot(
  brand: NonNullable<ReturnType<typeof getBrand>>, from: string, to: string, app: { log: { warn: (...a: unknown[]) => void } }
): Promise<{ rows: PivotRow[]; dates: string[]; rto_factor: number; brand_daily: BrandDailyTotal[] }> {
  // 1) Per-(campaign, date) spend + Google-conversions from Google Ads.
  interface CampMeta { name: string; channel_type: string; status: string }
  const campMeta = new Map<string, CampMeta>();
  // key: customer_id|campaign_id|date → cell
  const cellByKey = new Map<string, { cost: number; conv: number; convVal: number; impr: number; clicks: number }>();
  const cidOf = (customer: string, campaign: string): string => `${customer}|${campaign}`;
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
          name: r.campaign?.name ?? '', channel_type: r.campaign?.advertisingChannelType ?? '', status: r.campaign?.status ?? '',
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

  // 2) Brand daily NCs / amount from Redshift (pre-RTO; we'll apply factor below).
  const brandDailyMap = new Map<string, { ncs: number; amount: number }>();
  if (brand.rto_mode === 'redshift') {
    const cfg = getDb()
      .prepare('SELECT funnel_table, utm_source_list, enabled FROM brand_redshift_config WHERE brand_id = ?')
      .get(brand.id) as { funnel_table: string | null; utm_source_list: string | null; enabled: number } | undefined;
    if (cfg?.enabled && cfg.funnel_table) {
      let utmSourceList: string[] = [];
      try { utmSourceList = JSON.parse(cfg.utm_source_list ?? '[]'); } catch { /* ignore */ }
      if (utmSourceList.length) {
        try {
          const rs = await fetchDaily({ funnelTable: cfg.funnel_table, utmSourceList, dateFrom: from, dateTo: to });
          for (const r of rs) brandDailyMap.set(r.date, { ncs: r.ncs, amount: r.amount });
        } catch (err) {
          app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'daily Redshift fetch failed');
        }
      }
    }
  }

  // 3) Compute total brand spend per date (denominator for share-of-day).
  const brandDaySpend = new Map<string, number>();
  for (const [key, cell] of cellByKey) {
    const date = key.split('|').slice(2).join('|'); // safe even if names contained '|'
    brandDaySpend.set(date, (brandDaySpend.get(date) ?? 0) + cell.cost);
  }

  // 4) Build sorted date list (every date that has either spend or NCs).
  const dates = [...new Set<string>([...brandDaySpend.keys(), ...brandDailyMap.keys()])].sort();

  // 5) For each campaign × date, compute cell with RTO-adjusted distributed NCs.
  const rtoMul = Math.max(0, Math.min(1, 1 - (brand.rto_factor ?? 0)));
  const rows: PivotRow[] = [];
  for (const [cid, meta] of campMeta) {
    const byDate: Record<string, PivotCell> = {};
    let tCost = 0, tConv = 0, tConvVal = 0, tImpr = 0, tClicks = 0, tNcs = 0, tAmt = 0;
    for (const date of dates) {
      const cell = cellByKey.get(`${cid}|${date}`);
      const cost = cell?.cost ?? 0;
      const dayBrandCost = brandDaySpend.get(date) ?? 0;
      const dayBrand = brandDailyMap.get(date) ?? { ncs: 0, amount: 0 };
      // Share-of-day-spend allocation. Zero-spend days for this campaign → no NCs.
      const share = dayBrandCost > 0 ? cost / dayBrandCost : 0;
      const ncs = dayBrand.ncs * share * rtoMul;
      const amount = dayBrand.amount * share * rtoMul;
      const convPR = (cell?.conv ?? 0) * rtoMul;
      const convValPR = (cell?.convVal ?? 0) * rtoMul;
      byDate[date] = {
        cost, ncs, amount,
        google_roas: cost > 0 ? convValPR / cost : 0,
        calc_roas: cost > 0 ? amount / cost : 0,
        calc_cpa: ncs > 0 ? cost / ncs : 0,
        conversions_post_rto: convPR,
      };
      tCost += cost; tConv += cell?.conv ?? 0; tConvVal += cell?.convVal ?? 0;
      tImpr += cell?.impr ?? 0; tClicks += cell?.clicks ?? 0;
      tNcs += ncs; tAmt += amount;
    }
    const [customer_id, campaign_id] = cid.split('|');
    rows.push({
      customer_id: customer_id ?? '', campaign_id: campaign_id ?? '',
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
  // Sort campaigns by total spend desc (most-impactful first).
  rows.sort((a, b) => b.totals.cost - a.totals.cost);

  // 6) Brand-daily summary array (column footer; reconciles to the brand-mode view).
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
