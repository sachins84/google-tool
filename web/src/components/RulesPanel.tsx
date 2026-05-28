import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type Rule, type RulePayload } from '../lib/api';

interface Props {
  brandId: number;
  /** Campaigns from the latest run, for the specific-campaign scope picker. */
  campaigns?: Array<{ id: string; name: string }>;
}

/**
 * A metric definition drives the form: which optimizer kind/scope_level it maps
 * to, how the value renders (pct vs absolute), and which scopes it allows.
 */
interface MetricDef {
  key: string;
  label: string;
  kind: 'floor' | 'cap' | 'preference';
  scope_level: 'portfolio' | 'campaign';
  metric: string;
  pct?: boolean;          // user enters % → stored as fraction
  portfolioOnly?: boolean; // forces scope=all
}

const METRIC_DEFS: MetricDef[] = [
  { key: 'roas_target',     label: 'Portfolio ROAS target', kind: 'preference', scope_level: 'portfolio', metric: 'roas_post_rto', portfolioOnly: true },
  { key: 'roas_floor',      label: 'Min ROAS (post-RTO)',   kind: 'floor', scope_level: 'campaign', metric: 'roas_post_rto' },
  { key: 'ctr_floor',       label: 'Min CTR',               kind: 'floor', scope_level: 'campaign', metric: 'ctr', pct: true },
  { key: 'cvr_floor',       label: 'Min CVR',               kind: 'floor', scope_level: 'campaign', metric: 'cvr', pct: true },
  { key: 'cpc_cap',         label: 'Max CPC (₹)',           kind: 'cap',   scope_level: 'campaign', metric: 'cpc' },
  { key: 'cpm_cap',         label: 'Max CPM (₹)',           kind: 'cap',   scope_level: 'campaign', metric: 'cpm' },
  { key: 'budget_step',     label: 'Max budget step/run',   kind: 'cap',   scope_level: 'campaign', metric: 'budget_step_pct', pct: true },
  { key: 'search_is_floor', label: 'Min Search IS',         kind: 'floor', scope_level: 'campaign', metric: 'search_is', pct: true },
];

const CHANNELS = ['SEARCH', 'PERFORMANCE_MAX', 'SHOPPING', 'DISPLAY', 'VIDEO'] as const;
type Scope = 'all' | 'channel' | 'campaign' | 'product';

interface FormState { metricKey: string; scope: Scope; channel: string; campaignId: string; value: string; isHard: boolean }
const emptyForm: FormState = { metricKey: 'roas_floor', scope: 'all', channel: 'SEARCH', campaignId: '', value: '', isHard: true };

const defByKindMetric = (kind: string, metric: string): MetricDef | undefined =>
  METRIC_DEFS.find((d) => d.kind === kind && d.metric === metric);

function scopeOf(r: Rule, campaigns: Array<{ id: string; name: string }>): string {
  if (r.scope_level === 'portfolio') return 'Portfolio';
  const p = r.predicate;
  if (p?.campaign_id) return `Campaign · ${campaigns.find((c) => c.id === p.campaign_id)?.name ?? p.campaign_id}`;
  if (p?.channel && p.channel !== 'ALL') return `Type · ${p.channel}`;
  return 'All campaigns';
}

function displayValue(r: Rule): string {
  const v = r.predicate?.value;
  if (v == null) return '—';
  const def = defByKindMetric(r.kind, r.predicate?.metric ?? '');
  if (def?.pct) return `${(v * 100).toFixed(1)}%`;
  return r.predicate?.metric === 'roas_post_rto' ? `${v.toFixed(2)}x` : `${v}`;
}

export function RulesPanel({ brandId, campaigns = [] }: Props) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  const load = useCallback(async () => {
    try { setRules((await api.rulesList(brandId)).rules); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  }, [brandId]);
  useEffect(() => { void load(); }, [load]);

  const currentDef = METRIC_DEFS.find((d) => d.key === form.metricKey) ?? METRIC_DEFS[1]!;
  const lockedScope = currentDef.portfolioOnly;
  const effectiveScope: Scope = lockedScope ? 'all' : form.scope;

  async function add() {
    const raw = Number(form.value);
    if (!isFinite(raw)) { setError('Enter a valid number'); return; }
    const value = currentDef.pct ? raw / 100 : raw;
    const predicate: RulePayload['predicate'] = { metric: currentDef.metric, value };
    if (effectiveScope === 'channel') predicate.channel = form.channel;
    if (effectiveScope === 'campaign') {
      if (!form.campaignId) { setError('Pick a campaign'); return; }
      predicate.campaign_id = form.campaignId;
    }
    try {
      await api.ruleCreate({ brand_id: brandId, kind: currentDef.kind, scope_level: currentDef.scope_level, predicate, is_hard: form.isHard, enabled: true });
      setAdding(false); setForm(emptyForm); setError(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  async function toggle(r: Rule) {
    try { await api.ruleUpdate(r.id, { enabled: !r.enabled }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  async function editValue(r: Rule) {
    const def = defByKindMetric(r.kind, r.predicate?.metric ?? '');
    const human = def?.pct ? (r.predicate?.value ?? 0) * 100 : (r.predicate?.value ?? 0);
    const v = window.prompt(`New value for ${def?.label ?? r.predicate?.metric} (${scopeOf(r, campaigns)})${def?.pct ? ' — enter as %' : ''}`, String(human));
    if (v == null) return;
    const rawN = Number(v);
    if (!isFinite(rawN)) { setError('Invalid number'); return; }
    const value = def?.pct ? rawN / 100 : rawN;
    try {
      await api.ruleUpdate(r.id, { predicate: { metric: r.predicate?.metric ?? 'roas_post_rto', channel: r.predicate?.channel, campaign_id: r.predicate?.campaign_id, value } });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  async function remove(r: Rule) {
    if (!window.confirm('Delete this rule?')) return;
    try { await api.ruleDelete(r.id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  return (
    <div className="bg-white border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Guardrails</h3>
        <button onClick={() => { setAdding((s) => !s); setError(null); }} className="text-xs px-2.5 py-1 rounded border hover:bg-gray-50">
          {adding ? 'Cancel' : '+ Add rule'}
        </button>
      </div>
      {error && <div className="text-xs text-red-600 mb-2">{error}</div>}

      {adding && (
        <div className="p-3 bg-gray-50 rounded border mb-3 space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Metric">
              <select value={form.metricKey} onChange={(e) => setForm({ ...form, metricKey: e.target.value })} className="border rounded px-2 py-1 text-xs">
                {METRIC_DEFS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </Field>
            <Field label="Applies to">
              <select
                value={effectiveScope}
                disabled={lockedScope}
                onChange={(e) => setForm({ ...form, scope: e.target.value as Scope })}
                className="border rounded px-2 py-1 text-xs disabled:bg-gray-100"
              >
                <option value="all">All campaigns</option>
                <option value="channel">Campaign type</option>
                <option value="campaign" disabled={campaigns.length === 0}>Specific campaign</option>
                <option value="product" disabled>Product (coming soon)</option>
              </select>
            </Field>
            {effectiveScope === 'channel' && (
              <Field label="Channel">
                <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} className="border rounded px-2 py-1 text-xs">
                  {CHANNELS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
            )}
            {effectiveScope === 'campaign' && (
              <Field label="Campaign">
                <select value={form.campaignId} onChange={(e) => setForm({ ...form, campaignId: e.target.value })} className="border rounded px-2 py-1 text-xs min-w-[200px]">
                  <option value="">— pick —</option>
                  {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
                </select>
              </Field>
            )}
            <Field label={currentDef.pct ? 'Value (%)' : currentDef.metric === 'roas_post_rto' ? 'Value (x)' : 'Value'}>
              <input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} type="number" step="any" className="border rounded px-2 py-1 text-xs w-24" />
            </Field>
            <label className="flex items-center gap-1 text-xs pb-1.5" title="Hard rules are enforced by the optimizer and never relaxed by the feedback loop.">
              <input type="checkbox" checked={form.isHard} onChange={(e) => setForm({ ...form, isHard: e.target.checked })} /> Hard
            </label>
            <button onClick={add} className="text-xs px-3 py-1.5 rounded bg-black text-white">Save</button>
          </div>
          <p className="text-[11px] text-gray-500">
            Precedence: a specific-campaign rule overrides a campaign-type rule, which overrides the all-campaigns default. Hard rules are inviolable floors/caps; soft rules only re-rank.
          </p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-gray-500 text-left border-b">
              <th className="py-1.5 px-2">Metric</th>
              <th className="px-2">Applies to</th>
              <th className="px-2 text-right">Value</th>
              <th className="px-2 text-right">Weight</th>
              <th className="px-2">Hard</th>
              <th className="px-2">Origin</th>
              <th className="px-2"></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const def = defByKindMetric(r.kind, r.predicate?.metric ?? '');
              return (
                <tr key={r.id} className={`border-b last:border-0 ${r.enabled ? '' : 'opacity-40'}`}>
                  <td className="py-1.5 px-2 whitespace-nowrap">{def?.label ?? `${r.kind} · ${r.predicate?.metric ?? '?'}`}</td>
                  <td className="px-2 whitespace-nowrap">{scopeOf(r, campaigns)}</td>
                  <td className="px-2 text-right font-medium tabular-nums">{displayValue(r)}</td>
                  <td className="px-2 text-right text-gray-500 tabular-nums" title="Adaptive ranking weight (learned from accept/reject — never changes the floor value).">{r.weight.toFixed(2)}</td>
                  <td className="px-2">{r.is_hard ? '✓' : ''}</td>
                  <td className="px-2 text-gray-400">{r.origin}</td>
                  <td className="px-2 text-right whitespace-nowrap">
                    <button onClick={() => editValue(r)} className="text-blue-600 hover:underline mr-2">edit</button>
                    <button onClick={() => toggle(r)} className="text-gray-600 hover:underline mr-2">{r.enabled ? 'disable' : 'enable'}</button>
                    {r.origin === 'manual' && <button onClick={() => remove(r)} className="text-red-600 hover:underline">delete</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-400 mt-2">Hard floors/caps are enforced by the optimizer and never relaxed by the feedback loop — only ranking weight adapts.</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-gray-500 uppercase">{label}</span>
      {children}
    </div>
  );
}
