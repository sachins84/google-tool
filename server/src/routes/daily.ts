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
    const { brand_id, from, to } = parsed.data;
    const brand = getBrand(brand_id);
    if (!brand) return reply.code(404).send({ error: 'Brand not found' });
    if (!brand.accounts.length) return { rows: [], rto_factor: brand.rto_factor ?? 0 };

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
