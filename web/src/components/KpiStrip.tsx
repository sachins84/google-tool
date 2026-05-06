import type { PerfRow } from '../lib/api';
import { deltaTone, fmtDelta, fmtINR, fmtMul, fmtNum } from '../lib/format';

interface Props {
  rows: PerfRow[];
  hasCompare: boolean;
  /**
   * Optional brand-wide Redshift totals, fetched independently of per-row matching.
   * Used to populate KPIs accurately even when some campaigns can't be linked
   * via utm_campaign (e.g. Search/Shopping with custom UTM strings).
   */
  brandTotals?: {
    primary?: { ncs: number; amount: number };
    compare?: { ncs: number; amount: number };
  };
}

interface Totals {
  cost: number;
  conversions: number;
  conversions_value: number;
  ncs: number;
  ncs_amount: number;
}

function totals(rows: PerfRow[]): Totals {
  return rows.reduce<Totals>(
    (acc, r) => {
      acc.cost += r.metrics.cost;
      acc.conversions += r.metrics.conversions;
      acc.conversions_value += r.metrics.conversions_value;
      if (r.metrics.ncs != null) acc.ncs += r.metrics.ncs;
      if (r.metrics.ncs_amount != null) acc.ncs_amount += r.metrics.ncs_amount;
      return acc;
    },
    { cost: 0, conversions: 0, conversions_value: 0, ncs: 0, ncs_amount: 0 }
  );
}

function compTotals(rows: PerfRow[]) {
  const compRows = rows.filter((r) => r.comparison);
  if (!compRows.length) return null;
  return compRows.reduce(
    (acc, r) => {
      const c = r.comparison!;
      acc.cost += c.cost;
      acc.conversions += c.conversions;
      acc.conversions_value += c.conversions_value;
      if (c.ncs != null) acc.ncs += c.ncs;
      if (c.ncs_amount != null) acc.ncs_amount += c.ncs_amount;
      return acc;
    },
    { cost: 0, conversions: 0, conversions_value: 0, ncs: 0, ncs_amount: 0 }
  );
}

export function KpiStrip({ rows, hasCompare, brandTotals }: Props) {
  const cur = totals(rows);
  const cmp = compTotals(rows);
  const hasCalc = !!brandTotals?.primary || rows.some((r) => r.metrics.ncs != null);

  // Prefer brand-wide Redshift totals (independent of per-row matching) when available.
  // Falls back to row-summed NCs when not (e.g. on non-LJ brands or other tabs).
  const ncsTotal = brandTotals?.primary?.ncs ?? cur.ncs;
  const ncsAmountTotal = brandTotals?.primary?.amount ?? cur.ncs_amount;
  const cmpNcsTotal = brandTotals?.compare?.ncs ?? cmp?.ncs;
  const cmpNcsAmountTotal = brandTotals?.compare?.amount ?? cmp?.ncs_amount;

  const googleRoas = cur.cost ? cur.conversions_value / cur.cost : 0;
  const calcRoas = cur.cost ? ncsAmountTotal / cur.cost : 0;
  const cpa = cur.conversions ? cur.cost / cur.conversions : 0;
  const calcCpa = ncsTotal ? cur.cost / ncsTotal : 0;
  const aov = ncsTotal ? ncsAmountTotal / ncsTotal : 0;

  const cmpGoogleRoas = cmp && cmp.cost ? cmp.conversions_value / cmp.cost : undefined;
  const cmpCalcRoas = cmp && cmp.cost && cmpNcsAmountTotal != null ? cmpNcsAmountTotal / cmp.cost : undefined;
  const cmpCpa = cmp && cmp.conversions ? cmp.cost / cmp.conversions : undefined;
  const cmpCalcCpa = cmp && cmp.cost && cmpNcsTotal ? cmp.cost / cmpNcsTotal : undefined;
  const cmpAov = cmpNcsTotal && cmpNcsAmountTotal != null ? cmpNcsAmountTotal / cmpNcsTotal : undefined;

  return (
    <div className={`grid grid-cols-2 ${hasCalc ? 'md:grid-cols-6' : 'md:grid-cols-4'} gap-3`}>
      <Card label="Spend" value={fmtINR(cur.cost)}
        delta={hasCompare ? fmtDelta(cur.cost, cmp?.cost, 'pct') : ''}
        tone={deltaTone(cur.cost, cmp?.cost, false)} />
      <Card label="Conversions (G)" value={fmtNum(cur.conversions, 0)}
        delta={hasCompare ? fmtDelta(cur.conversions, cmp?.conversions, 'pct') : ''}
        tone={deltaTone(cur.conversions, cmp?.conversions, true)} />
      <Card label="ROAS (Google)" value={fmtMul(googleRoas)}
        delta={hasCompare ? fmtDelta(googleRoas, cmpGoogleRoas, 'absolute') : ''}
        tone={deltaTone(googleRoas, cmpGoogleRoas, true)} />
      <Card label="CPA (Google)" value={fmtINR(cpa)}
        delta={hasCompare ? fmtDelta(cpa, cmpCpa, 'pct') : ''}
        tone={deltaTone(cpa, cmpCpa, false)} />
      {hasCalc && (
        <Card label="NCs (post-RTO)" value={fmtNum(ncsTotal, 0)}
          delta={hasCompare ? fmtDelta(ncsTotal, cmpNcsTotal, 'pct') : ''}
          tone={deltaTone(ncsTotal, cmpNcsTotal, true)} />
      )}
      {hasCalc && (
        <Card label="Calc ROAS" value={fmtMul(calcRoas)}
          delta={hasCompare ? fmtDelta(calcRoas, cmpCalcRoas, 'absolute') : ''}
          tone={deltaTone(calcRoas, cmpCalcRoas, true)}
          highlight />
      )}
      {hasCalc && ncsTotal > 0 && (
        <Card label="AOV" value={fmtINR(aov)}
          delta={hasCompare ? fmtDelta(aov, cmpAov, 'pct') : ''}
          tone={deltaTone(aov, cmpAov, true)} />
      )}
      {hasCalc && ncsTotal > 0 && (
        <Card label="Calc CPA" value={fmtINR(calcCpa)}
          delta={hasCompare ? fmtDelta(calcCpa, cmpCalcCpa, 'pct') : ''}
          tone={deltaTone(calcCpa, cmpCalcCpa, false)} />
      )}
    </div>
  );
}

function Card({
  label, value, delta, tone, highlight = false,
}: { label: string; value: string; delta: string; tone: string; highlight?: boolean }) {
  return (
    <div className={`bg-white rounded shadow border px-4 py-3 ${highlight ? 'ring-1 ring-emerald-200' : ''}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>{value}</div>
      {delta && <div className={`text-xs mt-1 ${tone}`}>{delta} vs prev</div>}
    </div>
  );
}
