import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type Recommendation, type RecommendationsResponse } from '../lib/api';
import { RulesPanel } from '../components/RulesPanel';

interface Props {
  brandId: number;
  brandName: string;
}

const x = (n: number | null | undefined): string => (n == null ? '—' : `${n.toFixed(2)}x`);
const inr = (n: number | null | undefined): string => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);

const ACTION_LABEL: Record<string, string> = {
  update_budget: 'Budget',
  update_campaign_settings: 'Target ROAS',
  pause: 'Pause',
  add_negative_keyword: 'Exclude KW',
  pause_asset: 'Pause asset',
  monitor: 'Monitor',
};

const REASON_LABEL: Record<string, string> = {
  SCALE_UP: 'Scale up',
  SCALE_DOWN: 'Scale down',
  PAUSE_LOW_ROAS: 'Pause (low ROAS)',
  TIGHTEN_TROAS: 'Tighten tROAS',
  EXCLUDE_KW: 'Exclude keyword',
  PAUSE_ASSET_GROUP: 'Pause asset group',
  PAUSE_POOR_AD: 'Pause poor ad',
  MONITOR_LEARNING: 'Monitor (learning)',
  MONITOR_LOW_CONF: 'Monitor (low data)',
};

export function Actions({ brandId, brandName }: Props) {
  const [data, setData] = useState<RecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'engine' | 'rules'>('engine');
  const [running, setRunning] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [overrideId, setOverrideId] = useState<number | null>(null);
  const [overrideVal, setOverrideVal] = useState<string>('');
  const [confirm, setConfirm] = useState<Recommendation | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setData(await api.recommendations(brandId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [brandId]);

  useEffect(() => { void load(); }, [load]);

  async function runNow() {
    setRunning(true); setError(null);
    try {
      await api.recommendationRun(brandId);
      // Run is async; poll for completion up to ~60s.
      const today = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await api.recommendations(brandId);
        if (res.run && res.run.run_date === today && res.run.status === 'completed') {
          setData(res); break;
        }
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  async function decide(rec: Recommendation, decision: 'accepted' | 'rejected' | 'overridden', overridePayload?: Record<string, unknown>, reason?: string) {
    setBusyId(rec.id);
    try {
      await api.recommendationDecide(rec.id, { decision, override_payload: overridePayload, reason });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
      setConfirm(null);
      setOverrideId(null);
    }
  }

  function overrideField(rec: Recommendation): 'daily_budget_inr' | 'target_roas' | null {
    if (rec.mutate_action === 'update_budget') return 'daily_budget_inr';
    if (rec.mutate_action === 'update_campaign_settings') return 'target_roas';
    return null;
  }

  function applyOverride(rec: Recommendation) {
    const field = overrideField(rec);
    if (!field) return;
    const v = Number(overrideVal);
    if (!isFinite(v) || v <= 0) { setError('Enter a valid number'); return; }
    void decide(rec, 'overridden', { ...rec.mutate_payload, [field]: v });
  }

  const list = source === 'engine' ? data?.engine ?? [] : data?.rules ?? [];
  const run = data?.run;
  const diffByKey = new Map((data?.diff ?? []).map((d) => [d.key, d]));

  return (
    <div className="space-y-4">
      {/* Portfolio header */}
      <div className="bg-white border rounded-lg p-4 flex flex-wrap items-center gap-6">
        <div>
          <div className="text-xs text-gray-500">Portfolio</div>
          <div className="font-semibold">{brandName}</div>
        </div>
        <Metric label="Blended ROAS (post-RTO)" value={x(run?.current_blended_roas)} />
        <Metric label="Target" value={x(run?.portfolio_target_roas)} />
        <Metric
          label="Projected if applied"
          value={x(run?.projected_blended_roas)}
          tone={run && run.projected_blended_roas != null && run.portfolio_target_roas != null && run.projected_blended_roas >= run.portfolio_target_roas ? 'good' : 'warn'}
        />
        <div>
          <div className="text-xs text-gray-500">Target reachable</div>
          <div className={`font-semibold ${run?.target_reachable ? 'text-green-600' : 'text-amber-600'}`}>
            {run ? (run.target_reachable ? 'Yes' : 'Needs review') : '—'}
          </div>
        </div>
        <div className="flex-1" />
        <div className="text-right">
          <div className="text-xs text-gray-500">Run date</div>
          <div className="text-sm">{run?.run_date ?? 'No run yet'}</div>
        </div>
        <button
          onClick={runNow}
          disabled={running}
          className="px-3 py-1.5 rounded bg-black text-white text-sm disabled:opacity-50"
        >
          {running ? 'Running…' : 'Run now'}
        </button>
        <button
          onClick={() => setShowRules((s) => !s)}
          className="px-3 py-1.5 rounded border text-sm hover:bg-gray-50"
        >
          {showRules ? 'Hide guardrails' : 'Guardrails'}
        </button>
      </div>

      {run?.notes && <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">{run.notes}</div>}
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {showRules && <RulesPanel brandId={brandId} />}

      {/* Source toggle */}
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-lg border overflow-hidden text-sm">
          <button
            onClick={() => setSource('engine')}
            className={`px-3 py-1.5 ${source === 'engine' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'}`}
          >
            Engine (adaptive)
          </button>
          <button
            onClick={() => setSource('rules')}
            className={`px-3 py-1.5 ${source === 'rules' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'}`}
          >
            Manual (rules)
          </button>
        </div>
        <span className="text-xs text-gray-500">
          {source === 'engine'
            ? 'Ranked by the feedback-adaptive engine — learns from your decisions.'
            : 'Raw rules-engine ranking, before adaptive weighting.'}
        </span>
      </div>

      {loading && !data ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
      ) : !run ? (
        <div className="text-sm text-gray-500 py-8 text-center">No recommendation run yet — click “Run now”.</div>
      ) : list.length === 0 ? (
        <div className="text-sm text-gray-500 py-8 text-center">No recommendations in this run.</div>
      ) : (
        <div className="space-y-2">
          {list.map((rec) => {
            const reason = rec.reason_codes?.[0] ?? '';
            const isMonitor = rec.mutate_action === 'monitor';
            const pending = rec.status === 'pending';
            const diff = diffByKey.get(`${rec.level}|${rec.entity_id}|${rec.mutate_action}`);
            const field = overrideField(rec);
            return (
              <div key={rec.id} className="bg-white border rounded-lg p-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${chipTone(reason)}`}>{REASON_LABEL[reason] ?? reason}</span>
                      <span className="text-xs text-gray-400">{rec.level}</span>
                      <span className="font-medium text-sm truncate" title={rec.entity_name ?? rec.entity_id}>
                        {trunc(rec.entity_name ?? rec.entity_id, 60)}
                      </span>
                      {diff && diff.in === 'engine_only' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">engine-only</span>}
                      {diff && diff.rank_rules != null && diff.rank_engine != null && diff.rank_rules !== diff.rank_engine && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                          rank {diff.rank_rules}→{diff.rank_engine}
                        </span>
                      )}
                      {!pending && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-700">{rec.status}</span>}
                    </div>
                    <div className="text-sm text-gray-700 mt-1">{rec.rationale}</div>
                    <div className="text-xs text-gray-500 mt-1 flex gap-3 flex-wrap">
                      <span>{ACTION_LABEL[rec.mutate_action] ?? rec.mutate_action}</span>
                      {changeSummary(rec)}
                      <span>conf {Math.round(rec.confidence * 100)}%</span>
                      {rec.expected_impact && (rec.expected_impact.delta_cost !== 0 || rec.expected_impact.delta_value !== 0) && (
                        <span>Δ value {inr(rec.expected_impact.delta_value)}/day · Δ spend {inr(rec.expected_impact.delta_cost)}/day</span>
                      )}
                    </div>
                  </div>
                  {!isMonitor && pending && (
                    <div className="flex items-center gap-2 shrink-0">
                      {field && overrideId === rec.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            value={overrideVal}
                            onChange={(e) => setOverrideVal(e.target.value)}
                            className="border rounded px-2 py-1 text-xs w-24"
                            placeholder={field === 'target_roas' ? 'e.g. 4.5' : 'e.g. 1200'}
                          />
                          <button onClick={() => applyOverride(rec)} disabled={busyId === rec.id} className="text-xs px-2 py-1 rounded bg-amber-500 text-white">Apply</button>
                          <button onClick={() => setOverrideId(null)} className="text-xs px-2 py-1 rounded border">Cancel</button>
                        </div>
                      ) : (
                        <>
                          <button onClick={() => setConfirm(rec)} disabled={busyId === rec.id} className="text-xs px-3 py-1.5 rounded bg-green-600 text-white disabled:opacity-50">Approve</button>
                          {field && (
                            <button
                              onClick={() => { setOverrideId(rec.id); setOverrideVal(String((rec.proposed?.[field] ?? '') || '')); }}
                              className="text-xs px-3 py-1.5 rounded border hover:bg-gray-50"
                            >
                              Override
                            </button>
                          )}
                          <button
                            onClick={() => { const r = window.prompt('Reason for rejecting (optional):') ?? undefined; void decide(rec, 'rejected', undefined, r); }}
                            disabled={busyId === rec.id}
                            className="text-xs px-3 py-1.5 rounded border text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* One-confirmation approval modal */}
      {confirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-20" onClick={() => setConfirm(null)}>
          <div className="bg-white rounded-lg p-5 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold mb-1">Apply this change?</h3>
            <p className="text-sm text-gray-600 mb-3">
              {ACTION_LABEL[confirm.mutate_action]} · {trunc(confirm.entity_name ?? confirm.entity_id, 50)}
            </p>
            <div className="text-sm bg-gray-50 border rounded p-3 mb-3">{confirm.rationale}</div>
            <div className="text-xs text-gray-500 mb-4">A dry-run validates with Google first; only then is the live change applied and recorded to the audit log.</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} className="px-3 py-1.5 rounded border text-sm">Cancel</button>
              <button onClick={() => void decide(confirm, 'accepted')} disabled={busyId === confirm.id} className="px-3 py-1.5 rounded bg-green-600 text-white text-sm disabled:opacity-50">
                {busyId === confirm.id ? 'Applying…' : 'Confirm & apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`font-semibold ${tone === 'good' ? 'text-green-600' : tone === 'warn' ? 'text-amber-600' : ''}`}>{value}</div>
    </div>
  );
}

function changeSummary(rec: Recommendation): ReactNode {
  const c = rec.current ?? {};
  const p = rec.proposed ?? {};
  if (rec.mutate_action === 'update_budget') return <span>{inr(c.daily_budget_inr)} → {inr(p.daily_budget_inr)}/day</span>;
  if (rec.mutate_action === 'update_campaign_settings') return <span>tROAS {x(c.target_roas)} → {x(p.target_roas)}</span>;
  if (rec.mutate_action === 'pause') return <span>ROAS {x(c.roas_post_rto ?? c.roas_pre_rto)}</span>;
  return null;
}

function chipTone(reason: string): string {
  if (reason.startsWith('SCALE_UP')) return 'bg-green-100 text-green-700';
  if (reason.startsWith('SCALE_DOWN') || reason.startsWith('TIGHTEN')) return 'bg-amber-100 text-amber-700';
  if (reason.startsWith('PAUSE') || reason.startsWith('EXCLUDE')) return 'bg-red-100 text-red-700';
  return 'bg-gray-100 text-gray-600';
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
