import { useEffect, useMemo, useState } from 'react';
import { api, type ProductRow } from '../lib/api';
import { fmtINR, fmtMul, fmtNum } from '../lib/format';

interface Props {
  brandId: number;
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
  campaignId?: string;
}

type SortKey = 'cost' | 'impressions' | 'clicks' | 'conversions' | 'conv_value' | 'roas';

export function Products({ brandId, from, to, compareFrom, compareTo, campaignId }: Props) {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('cost');
  const [search, setSearch] = useState('');
  const [zeroSpendHidden, setZeroSpendHidden] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.products({
      brand_id: brandId, from, to,
      compare_from: compareFrom, compare_to: compareTo,
      campaign_id: campaignId,
    })
      .then((res) => { if (!cancelled) setRows(res.rows); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, from, to, compareFrom, compareTo, campaignId]);

  // Aggregate at product_id level across campaigns (one row per offer ID)
  const aggregated = useMemo(() => {
    const m = new Map<string, ProductRow & { campaignCount: number }>();
    for (const r of rows) {
      const key = r.product_id ?? '(unknown)';
      const existing = m.get(key);
      if (!existing) {
        m.set(key, { ...r, campaignCount: 1, campaign_name: r.campaign_name });
      } else {
        existing.campaignCount += 1;
        // sum metrics
        const a = existing.metrics;
        const b = r.metrics;
        const sumNullable = (x: number | null, y: number | null) =>
          x == null && y == null ? null : (x ?? 0) + (y ?? 0);
        existing.metrics = {
          ...a,
          cost: (a.cost ?? 0) + (b.cost ?? 0),
          impressions: (a.impressions ?? 0) + (b.impressions ?? 0),
          clicks: (a.clicks ?? 0) + (b.clicks ?? 0),
          conversions: (a.conversions ?? 0) + (b.conversions ?? 0),
          conversions_value: (a.conversions_value ?? 0) + (b.conversions_value ?? 0),
          conversions_value_post_rto:
            (a.conversions_value_post_rto ?? 0) + (b.conversions_value_post_rto ?? 0),
          ncs: sumNullable(a.ncs, b.ncs),
          ncs_amount: sumNullable(a.ncs_amount, b.ncs_amount),
        };
        // recompute derived
        existing.metrics.ctr = existing.metrics.impressions ? existing.metrics.clicks / existing.metrics.impressions : 0;
        existing.metrics.cpc = existing.metrics.clicks ? existing.metrics.cost / existing.metrics.clicks : 0;
        existing.metrics.cpm = existing.metrics.impressions ? (existing.metrics.cost / existing.metrics.impressions) * 1000 : 0;
        existing.metrics.cpa = existing.metrics.conversions ? existing.metrics.cost / existing.metrics.conversions : 0;
        existing.metrics.roas_pre_rto = existing.metrics.cost ? existing.metrics.conversions_value / existing.metrics.cost : 0;
        existing.metrics.roas_post_rto = existing.metrics.cost ? existing.metrics.conversions_value_post_rto / existing.metrics.cost : 0;
        if (existing.metrics.ncs != null && existing.metrics.ncs_amount != null) {
          existing.metrics.aov = existing.metrics.ncs ? existing.metrics.ncs_amount / existing.metrics.ncs : 0;
          existing.metrics.calc_cpa = existing.metrics.ncs ? existing.metrics.cost / existing.metrics.ncs : 0;
          existing.metrics.calc_roas = existing.metrics.cost ? existing.metrics.ncs_amount / existing.metrics.cost : 0;
        }
        if (r.comparison) {
          if (!existing.comparison) {
            existing.comparison = { ...r.comparison };
          } else {
            const ac = existing.comparison;
            const bc = r.comparison;
            ac.cost = (ac.cost ?? 0) + (bc.cost ?? 0);
            ac.impressions = (ac.impressions ?? 0) + (bc.impressions ?? 0);
            ac.clicks = (ac.clicks ?? 0) + (bc.clicks ?? 0);
            ac.conversions = (ac.conversions ?? 0) + (bc.conversions ?? 0);
            ac.conversions_value_post_rto =
              (ac.conversions_value_post_rto ?? 0) + (bc.conversions_value_post_rto ?? 0);
            ac.roas_post_rto = ac.cost ? ac.conversions_value_post_rto / ac.cost : 0;
          }
        }
      }
    }
    return Array.from(m.values());
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return aggregated
      .filter((r) => {
        if (zeroSpendHidden && !(r.metrics?.cost ?? 0)) return false;
        if (!q) return true;
        return (
          (r.product_title?.toLowerCase().includes(q) ?? false)
          || (r.product_id?.toLowerCase().includes(q) ?? false)
          || (r.product_brand?.toLowerCase().includes(q) ?? false)
          || (r.product_category?.toLowerCase().includes(q) ?? false)
        );
      })
      .slice()
      .sort((a, b) => sortValue(b, sort) - sortValue(a, sort));
  }, [aggregated, search, sort, zeroSpendHidden]);

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Loading products…</div>;
  if (error) return <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>;
  if (!rows.length) {
    return (
      <div className="text-sm text-gray-500 py-8 text-center bg-white rounded border">
        No Shopping / PMax product performance in this window.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, ID, brand, category…"
          className="border rounded px-3 py-1.5 text-sm w-72"
        />
        <label className="flex items-center gap-1.5 text-xs text-gray-700">
          <input
            type="checkbox"
            checked={zeroSpendHidden}
            onChange={(e) => setZeroSpendHidden(e.target.checked)}
          />
          Hide zero spend
        </label>
        <span className="text-xs text-gray-500 ml-auto">
          {filtered.length} of {aggregated.length} products
        </span>
      </div>

      <div className="bg-white rounded shadow border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-gray-600 border-b bg-gray-50">
            <tr>
              <th className="px-4 py-2 font-medium">Product</th>
              <th className="px-4 py-2 font-medium">Brand / Category</th>
              <SortableHead label="Spend" sortKey="cost" active={sort} setSort={setSort} />
              <SortableHead label="Impr" sortKey="impressions" active={sort} setSort={setSort} />
              <SortableHead label="Clicks" sortKey="clicks" active={sort} setSort={setSort} />
              <SortableHead label="Conv" sortKey="conversions" active={sort} setSort={setSort} />
              <SortableHead label="Conv. value" sortKey="conv_value" active={sort} setSort={setSort} />
              <SortableHead label="ROAS (RTO)" sortKey="roas" active={sort} setSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const m = r.metrics;
              const c = r.comparison;
              return (
                <tr key={r.product_id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-1.5">
                    <div className="text-sm leading-snug max-w-[400px]" title={r.product_title}>
                      {r.product_title ?? '—'}
                    </div>
                    <div className="text-[10px] text-gray-500 font-mono">{r.product_id}</div>
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="text-xs">{r.product_brand ?? '—'}</div>
                    {r.product_category && (
                      <div className="text-[10px] text-gray-500">{r.product_category}</div>
                    )}
                    {r.campaignCount > 1 && (
                      <div className="text-[10px] text-blue-700">{r.campaignCount} campaigns</div>
                    )}
                  </td>
                  <Cell value={m?.cost} prev={c?.cost} fmt={fmtINR} betterIs="lower" deltaKind="pct" />
                  <Cell value={m?.impressions} prev={c?.impressions} fmt={fmtNum} betterIs="neutral" deltaKind="pct" />
                  <Cell value={m?.clicks} prev={c?.clicks} fmt={fmtNum} betterIs="higher" deltaKind="pct" />
                  <Cell value={m?.conversions} prev={c?.conversions} fmt={(n) => fmtNum(n, 0)} betterIs="higher" deltaKind="pct" />
                  <Cell value={m?.conversions_value_post_rto} prev={c?.conversions_value_post_rto} fmt={fmtINR} betterIs="higher" deltaKind="pct" />
                  <Cell value={m?.roas_post_rto} prev={c?.roas_post_rto} fmt={fmtMul} betterIs="higher" deltaKind="absolute" bold />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sortValue(r: ProductRow, key: SortKey): number {
  const m = r.metrics;
  if (!m) return 0;
  switch (key) {
    case 'cost': return m.cost ?? 0;
    case 'impressions': return m.impressions ?? 0;
    case 'clicks': return m.clicks ?? 0;
    case 'conversions': return m.conversions ?? 0;
    case 'conv_value': return m.conversions_value_post_rto ?? 0;
    case 'roas': return m.roas_post_rto ?? 0;
  }
}

function SortableHead({
  label, sortKey, active, setSort,
}: { label: string; sortKey: SortKey; active: SortKey; setSort: (k: SortKey) => void }) {
  return (
    <th className="px-4 py-2 font-medium text-right">
      <button
        onClick={() => setSort(sortKey)}
        className={`hover:text-black ${active === sortKey ? 'text-black' : 'text-gray-600'}`}
      >
        {label}{active === sortKey && ' ↓'}
      </button>
    </th>
  );
}

function Cell({ value, prev, fmt, betterIs, deltaKind, bold }: {
  value: number | null | undefined;
  prev: number | null | undefined;
  fmt: (n: number) => string;
  betterIs: 'higher' | 'lower' | 'neutral';
  deltaKind: 'pct' | 'absolute';
  bold?: boolean;
}) {
  if (value == null || !Number.isFinite(value)) {
    return <td className="px-4 py-1.5 text-right text-gray-400">—</td>;
  }
  const v = value;
  const hasCompare = prev != null && Number.isFinite(prev);
  let deltaStr = '';
  let toneClass = 'text-gray-400';
  if (hasCompare) {
    if (deltaKind === 'pct') {
      if (prev === 0) deltaStr = v === 0 ? '—' : '+∞%';
      else {
        const pct = (v - (prev as number)) / (prev as number);
        deltaStr = `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(0)}%`;
        if (betterIs !== 'neutral') {
          const better = betterIs === 'higher' ? pct > 0 : pct < 0;
          toneClass = better ? 'text-emerald-600' : pct === 0 ? 'text-gray-400' : 'text-red-600';
        }
      }
    } else {
      const d = v - (prev as number);
      deltaStr = `${d >= 0 ? '+' : ''}${d.toFixed(2)}`;
      if (betterIs !== 'neutral') {
        const better = betterIs === 'higher' ? d > 0 : d < 0;
        toneClass = better ? 'text-emerald-600' : d === 0 ? 'text-gray-400' : 'text-red-600';
      }
    }
  }
  return (
    <td className="px-4 py-1.5 text-right">
      <div className={bold ? 'font-medium' : ''}>{fmt(v)}</div>
      {hasCompare && <div className={`text-[10px] ${toneClass}`}>{deltaStr}</div>}
    </td>
  );
}
