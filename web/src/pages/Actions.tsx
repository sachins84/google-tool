import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, type Recommendation, type RecommendationsResponse } from '../lib/api';
import { RulesPanel } from '../components/RulesPanel';

interface Props {
  brandId: number;
  brandName: string;
}

const x = (n: number | null | undefined): string => (n == null ? '—' : `${n.toFixed(2)}x`);
const inr = (n: number | null | undefined): string => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);

const ACTION_LABEL: Record<string, string> = {
  update_budget: 'Budget', update_campaign_settings: 'Target ROAS', pause: 'Pause',
  add_negative_keyword: 'Exclude KW', pause_asset: 'Pause asset', monitor: 'Monitor',
};
const REASON_LABEL: Record<string, string> = {
  SCALE_UP: 'Scale up', SCALE_DOWN: 'Scale down', PAUSE_LOW_ROAS: 'Pause (low ROAS)',
  TIGHTEN_TROAS: 'Tighten tROAS', EXCLUDE_KW: 'Exclude keyword', PAUSE_ASSET_GROUP: 'Pause asset group',
  PAUSE_POOR_AD: 'Pause poor ad', MONITOR_LEARNING: 'Hold (learning)', MONITOR_LOW_CONF: 'Hold (low data)',
  REVIEW_CREATIVE: 'Review (creative)', REVIEW_LANDING: 'Review (landing)',
};
const BUCKET_LABEL: Record<string, string> = {
  scale_up: 'Scale up', scale_down: 'Scale down', pause: 'Pause', exclude: 'Exclude', tighten: 'Tighten', review: 'Review', hold: 'Hold',
};
const BUCKET_ORDER = ['scale_up', 'scale_down', 'pause', 'exclude', 'tighten', 'review', 'hold'];
const pf = (n: number | null | undefined): string => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const LEVELS = ['campaign', 'ad_group', 'asset_group', 'ad', 'keyword'];
const WINDOW_PRESETS = [7, 14, 30];

export function Actions({ brandId, brandName }: Props) {
  const [data, setData] = useState<RecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'engine' | 'rules'>('engine');
  const [running, setRunning] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [overrideId, setOverrideId] = useState<number | null>(null);
  const [overrideVal, setOverrideVal] = useState<string>('');
  const [confirm, setConfirm] = useState<Recommendation | null>(null);
  const [windowDays, setWindowDays] = useState(7);
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [bucketFilter, setBucketFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.recommendations(brandId);
      setData(res);
      if (res.run?.eval_window_days) setWindowDays(res.run.eval_window_days);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, [brandId]);

  useEffect(() => { void load(); }, [load]);

  async function runNow() {
    setRunning(true); setError(null);
    try {
      await api.recommendationRun(brandId, windowDays);
      const today = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await api.recommendations(brandId);
        if (res.run && res.run.run_date === today && res.run.status === 'completed') { setData(res); break; }
      }
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Run failed'); }
    finally { setRunning(false); }
  }

  async function decide(rec: Recommendation, decision: 'accepted' | 'rejected' | 'overridden', overridePayload?: Record<string, unknown>, reason?: string) {
    setBusyId(rec.id);
    try { await api.recommendationDecide(rec.id, { decision, override_payload: overridePayload, reason }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); }
    finally { setBusyId(null); setConfirm(null); setOverrideId(null); }
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

  const run = data?.run;
  const allList = source === 'engine' ? data?.engine ?? [] : data?.rules ?? [];
  const bucketCounts = countBy(allList, (r) => r.bucket ?? 'hold');
  const levelCounts = countBy(allList, (r) => r.level);
  // Only show filters for buckets / levels that actually have recommendations.
  const availableBuckets = BUCKET_ORDER.filter((b) => (bucketCounts.get(b) ?? 0) > 0);
  const availableLevels = LEVELS.filter((l) => (levelCounts.get(l) ?? 0) > 0);
  const list = allList.filter(
    (r) => (levelFilter === 'all' || r.level === levelFilter) && (bucketFilter === 'all' || r.bucket === bucketFilter)
  );
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
        <Metric label="Projected if applied" value={x(run?.projected_blended_roas)}
          tone={run && run.projected_blended_roas != null && run.portfolio_target_roas != null && run.projected_blended_roas >= run.portfolio_target_roas ? 'good' : 'warn'} />
        <div>
          <div className="text-xs text-gray-500">Target reachable</div>
          <div className={`font-semibold ${run?.target_reachable ? 'text-green-600' : 'text-amber-600'}`}>
            {run ? (run.target_reachable ? 'Yes' : 'Needs review') : '—'}
          </div>
        </div>
        <div className="flex-1" />
        <div className="text-right">
          <div className="text-xs text-gray-500">Run date · window</div>
          <div className="text-sm">{run ? `${run.run_date} · last ${run.eval_window_days ?? '?'}d` : 'No run yet'}</div>
        </div>
      </div>

      {/* Evaluation window + run controls */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-gray-500">Evaluate metrics over:</span>
        {WINDOW_PRESETS.map((w) => (
          <button key={w} onClick={() => setWindowDays(w)} className={`px-2.5 py-1 rounded text-xs ${windowDays === w ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>{w}d</button>
        ))}
        <input type="number" min={1} max={90} value={windowDays} onChange={(e) => setWindowDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))} className="border rounded px-2 py-1 text-xs w-16" title="Custom window (days)" />
        <span className="text-xs text-gray-400">days</span>
        <button onClick={runNow} disabled={running} className="px-3 py-1.5 rounded bg-black text-white text-xs disabled:opacity-50">{running ? 'Running…' : 'Run now'}</button>
        <span className="text-xs text-gray-400">re-running replaces today's run</span>
        <div className="flex-1" />
        <button onClick={() => setShowSummary((s) => !s)} className="px-3 py-1.5 rounded border text-xs hover:bg-gray-50">{showSummary ? 'Hide daily check' : 'Daily check'}</button>
        <button onClick={() => setShowRules((s) => !s)} className="px-3 py-1.5 rounded border text-xs hover:bg-gray-50">{showRules ? 'Hide guardrails' : 'Guardrails'}</button>
      </div>

      {run?.notes && <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">{run.notes}</div>}
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {showSummary && <DailyCheck brandId={brandId} />}
      {showRules && (
        <RulesPanel
          brandId={brandId}
          campaigns={dedupeCampaigns(data?.engine ?? [])}
        />
      )}

      {/* Source toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border overflow-hidden text-sm">
          <button onClick={() => setSource('engine')} className={`px-3 py-1.5 ${source === 'engine' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'}`}>Engine (adaptive)</button>
          <button onClick={() => setSource('rules')} className={`px-3 py-1.5 ${source === 'rules' ? 'bg-black text-white' : 'bg-white hover:bg-gray-50'}`}>Manual (rules)</button>
        </div>
        <span className="text-xs text-gray-500">{source === 'engine' ? 'Feedback-adaptive ranking — learns from your decisions.' : 'Raw rules-engine ranking.'}</span>
      </div>

      {/* Filters: only buckets/levels that exist in this run */}
      <div className="flex flex-wrap items-center gap-2">
        {availableLevels.length > 0 && (
          <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} className="border rounded px-2 py-1 text-xs">
            <option value="all">All levels ({allList.length})</option>
            {availableLevels.map((l) => <option key={l} value={l}>{l} ({levelCounts.get(l)})</option>)}
          </select>
        )}
        <span className="text-gray-300">|</span>
        <button onClick={() => setBucketFilter('all')} className={`px-2.5 py-1 rounded-full text-xs ${bucketFilter === 'all' ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>All ({allList.length})</button>
        {availableBuckets.map((b) => (
          <button key={b} onClick={() => setBucketFilter(b)} className={`px-2.5 py-1 rounded-full text-xs ${bucketFilter === b ? bucketActive(b) : 'bg-gray-100 hover:bg-gray-200'}`}>
            {BUCKET_LABEL[b]} ({bucketCounts.get(b)})
          </button>
        ))}
      </div>

      {loading && !data ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
      ) : !run ? (
        <div className="text-sm text-gray-500 py-8 text-center">No recommendation run yet — pick a window and click “Run now”.</div>
      ) : list.length === 0 ? (
        <div className="text-sm text-gray-500 py-8 text-center">No recommendations match these filters.</div>
      ) : (
        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-xs text-gray-500 border-b bg-gray-50">
                <th className="text-left font-medium py-2 px-3 w-8"></th>
                <th className="text-left font-medium py-2 px-2">Bucket</th>
                <th className="text-left font-medium py-2 px-2">Level</th>
                <th className="text-left font-medium py-2 px-2">Entity</th>
                <th className="text-left font-medium py-2 px-2">Action</th>
                <th className="text-right font-medium py-2 px-2">Change</th>
                <th className="text-right font-medium py-2 px-2">ROAS</th>
                <th className="text-right font-medium py-2 px-2">CTR</th>
                <th className="text-right font-medium py-2 px-2">Srch IS</th>
                <th className="text-right font-medium py-2 px-2">Conf</th>
                <th className="text-right font-medium py-2 px-2">Δ value/day</th>
                <th className="text-left font-medium py-2 px-2">Your action</th>
                <th className="text-right font-medium py-2 px-3">Decision</th>
              </tr>
            </thead>
            <tbody>
              {list.map((rec) => {
                const reason = rec.reason_codes?.[0] ?? '';
                const isMonitor = rec.mutate_action === 'monitor';
                const pending = rec.status === 'pending';
                const diff = diffByKey.get(`${rec.level}|${rec.entity_id}|${rec.mutate_action}`);
                const field = overrideField(rec);
                const roas = rec.current?.roas_post_rto ?? rec.current?.roas_pre_rto;
                const open = expandedId === rec.id;
                return (
                  <Fragment key={rec.id}>
                    <tr className="border-b last:border-0 hover:bg-gray-50 align-middle">
                      <td className="px-3 py-2">
                        <button onClick={() => setExpandedId(open ? null : rec.id)} className="text-gray-400 hover:text-gray-700" title="Show rationale & comments">
                          {open ? '▾' : '▸'}
                        </button>
                      </td>
                      <td className="px-2 py-2"><span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${chipTone(reason)}`}>{REASON_LABEL[reason] ?? reason}</span></td>
                      <td className="px-2 py-2 text-gray-500 whitespace-nowrap">{rec.level}</td>
                      <td className="px-2 py-2 max-w-[220px]"><span className="block truncate font-medium" title={rec.entity_name ?? rec.entity_id}>{rec.entity_name ?? rec.entity_id}</span></td>
                      <td className="px-2 py-2 whitespace-nowrap">{ACTION_LABEL[rec.mutate_action] ?? rec.mutate_action}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">{changeText(rec)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{x(roas)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-600">{rec.current?.ctr ? pf(rec.current.ctr) : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-600">{rec.current?.search_is ? pf(rec.current.search_is) : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{Math.round(rec.confidence * 100)}%</td>
                      <td className="px-2 py-2 text-right tabular-nums">{rec.expected_impact && rec.expected_impact.delta_value !== 0 ? inr(rec.expected_impact.delta_value) : '—'}</td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {rec.user_action
                          ? <span className={`text-[11px] px-1.5 py-0.5 rounded ${actionTone(rec.user_action)}`}>{rec.user_action}</span>
                          : <span className="text-gray-300">—</span>}
                        {diff && diff.in === 'engine_only' && <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-700">eng-only</span>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {!isMonitor && pending ? (
                          field && overrideId === rec.id ? (
                            <span className="inline-flex items-center gap-1">
                              <input type="number" value={overrideVal} onChange={(e) => setOverrideVal(e.target.value)} className="border rounded px-1.5 py-1 text-xs w-20" placeholder={field === 'target_roas' ? '4.5' : '1200'} />
                              <button onClick={() => applyOverride(rec)} disabled={busyId === rec.id} className="text-xs px-2 py-1 rounded bg-amber-500 text-white">Apply</button>
                              <button onClick={() => setOverrideId(null)} className="text-xs px-1.5 py-1 rounded border">✕</button>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <button onClick={() => setConfirm(rec)} disabled={busyId === rec.id} className="text-xs px-2.5 py-1 rounded bg-green-600 text-white disabled:opacity-50">Approve</button>
                              {field && <button onClick={() => { setOverrideId(rec.id); setOverrideVal(String((rec.proposed?.[field] ?? '') || '')); }} className="text-xs px-2.5 py-1 rounded border hover:bg-gray-50">Override</button>}
                              <button onClick={() => { const r = window.prompt('Reason for rejecting (optional):') ?? undefined; void decide(rec, 'rejected', undefined, r); }} disabled={busyId === rec.id} className="text-xs px-2.5 py-1 rounded border text-red-600 hover:bg-red-50 disabled:opacity-50">Reject</button>
                            </span>
                          )
                        ) : isMonitor ? <span className="text-xs text-gray-400">monitor</span> : <span className="text-xs text-gray-400">{rec.status}</span>}
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b last:border-0 bg-gray-50/60">
                        <td></td>
                        <td colSpan={12} className="px-2 py-2">
                          <div className="text-sm text-gray-700 mb-1">{rec.rationale}</div>
                          {rec.diagnosis && <div className="text-xs text-indigo-700 mb-1">🔎 {rec.diagnosis}</div>}
                          {rec.current && (rec.current.cpc || rec.current.cpm || rec.current.cvr || rec.current.lost_is_budget || rec.current.lost_is_rank) ? (
                            <div className="text-xs text-gray-500 mb-1 flex gap-3 flex-wrap">
                              <span>CTR {pf(rec.current.ctr)}</span>
                              <span>CVR {pf(rec.current.cvr)}</span>
                              <span>CPC {inr(rec.current.cpc)}</span>
                              <span>CPM {inr(rec.current.cpm)}</span>
                              <span>Search IS {pf(rec.current.search_is)}</span>
                              <span>Lost IS (budget) {pf(rec.current.lost_is_budget)}</span>
                              <span>Lost IS (rank) {pf(rec.current.lost_is_rank)}</span>
                            </div>
                          ) : null}
                          <div className="text-xs text-gray-400 mb-2">
                            {rec.hard_constraints?.length ? `Constraints: ${rec.hard_constraints.join(', ')}` : ''}
                            {rec.comment_count ? ` · ${rec.comment_count} comment(s)` : ''}
                          </div>
                          <Comments recId={rec.id} onChanged={load} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-20" onClick={() => setConfirm(null)}>
          <div className="bg-white rounded-lg p-5 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold mb-1">Apply this change?</h3>
            <p className="text-sm text-gray-600 mb-3">{ACTION_LABEL[confirm.mutate_action]} · {trunc(confirm.entity_name ?? confirm.entity_id, 50)}</p>
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

function Comments({ recId, onChanged }: { recId: number; onChanged: () => void }) {
  const [comments, setComments] = useState<Array<{ id: number; username: string | null; comment: string; created_at: number }>>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setComments((await api.recommendationComments(recId)).comments); } catch { /* ignore */ } }, [recId]);
  useEffect(() => { void load(); }, [load]);
  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    try { await api.recommendationAddComment(recId, text.trim()); setText(''); await load(); onChanged(); }
    finally { setBusy(false); }
  }
  return (
    <div className="border-t pt-2">
      {comments.length === 0 && <div className="text-xs text-gray-400 mb-1">No comments yet.</div>}
      {comments.map((c) => (
        <div key={c.id} className="text-xs text-gray-700 mb-1">
          <span className="text-gray-400">{new Date(c.created_at * 1000).toLocaleString()} · {c.username ?? 'user'}:</span> {c.comment}
        </div>
      ))}
      <div className="flex items-center gap-2 mt-1 max-w-xl">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder="Add a comment (timestamped)…" className="border rounded px-2 py-1 text-xs flex-1" />
        <button onClick={add} disabled={busy} className="text-xs px-2.5 py-1 rounded bg-black text-white disabled:opacity-50">Post</button>
      </div>
    </div>
  );
}

function DailyCheck({ brandId }: { brandId: number }) {
  const [rows, setRows] = useState<Array<{ run_date: string; bucket: string; level: string; suggested: number; actioned: number; rejected: number; pending: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void (async () => { try { setRows((await api.recommendationSummary(brandId, 30)).summary); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); } })(); }, [brandId]);
  return (
    <div className="bg-white border rounded-lg p-4 overflow-x-auto">
      <h3 className="font-semibold text-sm mb-2">Daily check — suggestions vs actions (last 30d, by bucket & level)</h3>
      {error && <div className="text-xs text-red-600">{error}</div>}
      {rows.length === 0 ? <div className="text-xs text-gray-400">No runs yet.</div> : (
        <table className="w-full text-xs border-collapse">
          <thead><tr className="text-gray-500 text-left border-b"><th className="py-1.5 px-2">Date</th><th className="px-2">Bucket</th><th className="px-2">Level</th><th className="px-2 text-right">Suggested</th><th className="px-2 text-right">Actioned</th><th className="px-2 text-right">Rejected</th><th className="px-2 text-right">Pending</th><th className="px-2 text-right">Action rate</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1.5 px-2">{r.run_date}</td><td className="px-2">{r.bucket}</td><td className="px-2 text-gray-500">{r.level}</td>
                <td className="px-2 text-right tabular-nums">{r.suggested}</td><td className="px-2 text-right tabular-nums text-green-700">{r.actioned}</td>
                <td className="px-2 text-right tabular-nums text-red-600">{r.rejected}</td><td className="px-2 text-right tabular-nums text-gray-500">{r.pending}</td>
                <td className="px-2 text-right tabular-nums">{r.suggested ? Math.round((r.actioned / r.suggested) * 100) : 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
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

function changeText(rec: Recommendation): string {
  const c = rec.current ?? {}; const p = rec.proposed ?? {};
  if (rec.mutate_action === 'update_budget') return `${inr(c.daily_budget_inr)} → ${inr(p.daily_budget_inr)}`;
  if (rec.mutate_action === 'update_campaign_settings') return `${x(c.target_roas)} → ${x(p.target_roas)}`;
  if (rec.mutate_action === 'pause') return 'pause';
  return '—';
}

function countBy<T>(arr: T[], keyFn: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of arr) { const k = keyFn(a); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}
function chipTone(reason: string): string {
  if (reason.startsWith('SCALE_UP')) return 'bg-green-100 text-green-700';
  if (reason.startsWith('SCALE_DOWN') || reason.startsWith('TIGHTEN')) return 'bg-amber-100 text-amber-700';
  if (reason.startsWith('REVIEW')) return 'bg-indigo-100 text-indigo-700';
  if (reason.startsWith('PAUSE') || reason.startsWith('EXCLUDE')) return 'bg-red-100 text-red-700';
  return 'bg-gray-100 text-gray-600';
}
function bucketActive(key: string): string {
  if (key === 'scale_up') return 'bg-green-600 text-white';
  if (key === 'scale_down' || key === 'tighten') return 'bg-amber-600 text-white';
  if (key === 'review') return 'bg-indigo-600 text-white';
  if (key === 'pause' || key === 'exclude') return 'bg-red-600 text-white';
  return 'bg-gray-700 text-white';
}
function actionTone(a: string): string {
  if (a === 'accepted') return 'bg-green-100 text-green-700';
  if (a === 'overridden') return 'bg-amber-100 text-amber-700';
  if (a === 'rejected') return 'bg-red-100 text-red-700';
  return 'bg-gray-100 text-gray-600';
}
function trunc(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function dedupeCampaigns(recs: Recommendation[]): Array<{ id: string; name: string }> {
  const m = new Map<string, string>();
  for (const r of recs) if (r.level === 'campaign' && r.entity_id) m.set(r.entity_id, r.entity_name ?? r.entity_id);
  return [...m].map(([id, name]) => ({ id, name }));
}
