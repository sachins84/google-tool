import type { PerfRow } from '../lib/api';
import { deltaTone, fmtDelta, fmtINR, fmtMul, fmtNum } from '../lib/format';

interface Props {
  rows: PerfRow[];
  hasCompare: boolean;
}

function totals(rows: PerfRow[]): {
  cost: number;
  conversions: number;
  conversions_value_post_rto: number;
  roas_post_rto: number;
  cpa: number;
} {
  const t = rows.reduce(
    (acc, r) => {
      acc.cost += r.metrics.cost;
      acc.conversions += r.metrics.conversions;
      acc.conversions_value_post_rto += r.metrics.conversions_value_post_rto;
      return acc;
    },
    { cost: 0, conversions: 0, conversions_value_post_rto: 0 }
  );
  return {
    ...t,
    roas_post_rto: t.cost ? t.conversions_value_post_rto / t.cost : 0,
    cpa: t.conversions ? t.cost / t.conversions : 0,
  };
}

export function KpiStrip({ rows, hasCompare }: Props) {
  const cur = totals(rows);

  // Comparison aggregation pulled from the same rows' .comparison metrics.
  const compRows = rows.filter((r) => r.comparison);
  const cmp = compRows.length
    ? {
        cost: compRows.reduce((a, r) => a + (r.comparison?.cost ?? 0), 0),
        conversions: compRows.reduce((a, r) => a + (r.comparison?.conversions ?? 0), 0),
        conversions_value_post_rto: compRows.reduce((a, r) => a + (r.comparison?.conversions_value_post_rto ?? 0), 0),
      }
    : null;

  const cmpRoas = cmp && cmp.cost ? cmp.conversions_value_post_rto / cmp.cost : undefined;
  const cmpCpa = cmp && cmp.conversions ? cmp.cost / cmp.conversions : undefined;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card label="Spend" value={fmtINR(cur.cost)}
        delta={hasCompare ? fmtDelta(cur.cost, cmp?.cost, 'pct') : ''}
        tone={deltaTone(cur.cost, cmp?.cost, false)} />
      <Card label="Conversions" value={fmtNum(cur.conversions, 0)}
        delta={hasCompare ? fmtDelta(cur.conversions, cmp?.conversions, 'pct') : ''}
        tone={deltaTone(cur.conversions, cmp?.conversions, true)} />
      <Card label="ROAS (post-RTO)" value={fmtMul(cur.roas_post_rto)}
        delta={hasCompare ? fmtDelta(cur.roas_post_rto, cmpRoas, 'absolute') : ''}
        tone={deltaTone(cur.roas_post_rto, cmpRoas, true)} />
      <Card label="CPA" value={fmtINR(cur.cpa)}
        delta={hasCompare ? fmtDelta(cur.cpa, cmpCpa, 'pct') : ''}
        tone={deltaTone(cur.cpa, cmpCpa, false)} />
    </div>
  );
}

function Card({ label, value, delta, tone }: { label: string; value: string; delta: string; tone: string }) {
  return (
    <div className="bg-white rounded shadow border px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {delta && <div className={`text-xs mt-1 ${tone}`}>{delta} vs prev</div>}
    </div>
  );
}
