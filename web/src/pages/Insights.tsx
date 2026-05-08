import { useEffect, useState } from 'react';
import { api, type DailyInsight, type PerfRow } from '../lib/api';
import { Diagnose } from '../components/Diagnose';

interface Props {
  brandId: number;
  brandName: string;
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
}

export function Insights({ brandId, brandName, from, to, compareFrom, compareTo }: Props) {
  const [rows, setRows] = useState<PerfRow[]>([]);
  const [insights, setInsights] = useState<DailyInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.perf('campaigns', { brand_id: brandId, from, to, compare_from: compareFrom, compare_to: compareTo })
      .then(async (res) => {
        if (cancelled) return;
        setRows(res.rows);
        const d = await api.insightsDaily(
          { brand_id: brandId, from, to, compare_from: compareFrom, compare_to: compareTo },
          res.rows
        );
        if (!cancelled) setInsights(d.insights);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, from, to, compareFrom, compareTo]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Insights — {brandName}</h2>
        <p className="text-sm text-gray-500">{from} → {to} (vs prev period)</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>}

      <section className="space-y-2">
        <h3 className="font-medium">Today's top observations</h3>
        {loading ? (
          <div className="text-sm text-gray-500">Computing…</div>
        ) : insights.length === 0 ? (
          <div className="bg-white rounded shadow border p-4 text-sm text-gray-500">
            No notable movements in this period — performance looks stable.
          </div>
        ) : (
          <ul className="space-y-2">
            {insights.map((i, idx) => (
              <li key={idx} className={`bg-white rounded shadow border-l-4 ${
                i.severity === 'high' ? 'border-l-red-500'
                : i.severity === 'medium' ? 'border-l-amber-500'
                : 'border-l-emerald-500'
              } px-4 py-2 text-sm`}>
                <div className="flex items-start gap-2">
                  <span className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${
                    i.severity === 'high' ? 'bg-red-100 text-red-800'
                    : i.severity === 'medium' ? 'bg-amber-100 text-amber-800'
                    : 'bg-emerald-100 text-emerald-800'
                  }`}>{i.severity}</span>
                  <span className="text-gray-800">{i.message}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Diagnose brandId={brandId} from={from} to={to} compareFrom={compareFrom} compareTo={compareTo} rows={rows} />

      <section className="bg-blue-50 border border-blue-200 rounded p-3 text-xs space-y-1">
        <div className="font-medium text-blue-900">Free-form Q&A — connect Claude.ai via MCP</div>
        <p className="text-blue-900">
          For free-form Q&A, connect this tool's MCP server to Claude.ai instead of running queries here. Claude.ai can pull live data from the same source and reason across multiple tools (e.g. cross-checking with your meta-tool MCP). Uses your existing Claude.ai subscription, no extra API key.
        </p>
        <div className="font-mono text-xs bg-white border rounded px-3 py-2 text-gray-800">
          MCP endpoint: <code>http://localhost:5011/mcp</code> &nbsp;·&nbsp; Available tools:
          <code> list_brands</code>, <code>list_accessible_accounts</code>, <code>get_campaigns</code>, <code>get_network_split</code>, <code>get_daily_insights</code>, <code>get_audit_log</code>
        </div>
        <p className="text-xs text-blue-800">
          To add: in Claude.ai → Settings → MCP servers → Add → paste the URL above. Optional: set <code>MCP_SECRET</code> in <code>.env</code> for token auth before exposing publicly.
        </p>
      </section>
    </div>
  );
}
