import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type Rule } from '../lib/api';

interface Props {
  brandId: number;
  /** Campaigns from the latest run, for the upcoming specific-campaign scope picker (WIP). */
  campaigns?: Array<{ id: string; name: string }>;
}

const SCOPES = ['portfolio', 'campaign', 'asset_group', 'keyword', 'ad'] as const;
const KINDS = ['floor', 'cap', 'preference'] as const;

export function RulesPanel({ brandId }: Props) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: 'floor', scope_level: 'campaign', metric: 'roas_post_rto', value: '2.0', is_hard: true });

  const load = useCallback(async () => {
    try { setRules((await api.rulesList(brandId)).rules); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  }, [brandId]);
  useEffect(() => { void load(); }, [load]);

  async function toggle(r: Rule) {
    try { await api.ruleUpdate(r.id, { enabled: !r.enabled }); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  }
  async function editValue(r: Rule) {
    const cur = r.predicate?.value ?? 0;
    const v = window.prompt(`New value for ${r.kind} · ${r.scope_level} (${r.predicate?.metric})`, String(cur));
    if (v == null) return;
    const value = Number(v);
    if (!isFinite(value)) { setError('Invalid number'); return; }
    try {
      await api.ruleUpdate(r.id, { predicate: { metric: r.predicate?.metric ?? 'roas_post_rto', channel: r.predicate?.channel, value } });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  }
  async function remove(r: Rule) {
    if (!window.confirm('Delete this rule?')) return;
    try { await api.ruleDelete(r.id); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  }
  async function add() {
    const value = Number(form.value);
    if (!isFinite(value)) { setError('Invalid number'); return; }
    try {
      await api.ruleCreate({
        brand_id: brandId, kind: form.kind, scope_level: form.scope_level,
        predicate: { metric: form.metric, value }, is_hard: form.is_hard, enabled: true,
      });
      setAdding(false); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  return (
    <div className="bg-white border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Guardrails</h3>
        <button onClick={() => setAdding((s) => !s)} className="text-xs px-2.5 py-1 rounded border hover:bg-gray-50">
          {adding ? 'Cancel' : '+ Add rule'}
        </button>
      </div>
      {error && <div className="text-xs text-red-600 mb-2">{error}</div>}

      {adding && (
        <div className="flex flex-wrap items-end gap-2 mb-3 p-3 bg-gray-50 rounded border">
          <Field label="Kind">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="border rounded px-2 py-1 text-xs">
              {KINDS.map((k) => <option key={k}>{k}</option>)}
            </select>
          </Field>
          <Field label="Scope">
            <select value={form.scope_level} onChange={(e) => setForm({ ...form, scope_level: e.target.value })} className="border rounded px-2 py-1 text-xs">
              {SCOPES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Metric">
            <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })} className="border rounded px-2 py-1 text-xs">
              <option value="roas_post_rto">roas_post_rto</option>
              <option value="budget_step_pct">budget_step_pct</option>
            </select>
          </Field>
          <Field label="Value">
            <input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} className="border rounded px-2 py-1 text-xs w-20" />
          </Field>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={form.is_hard} onChange={(e) => setForm({ ...form, is_hard: e.target.checked })} /> Hard
          </label>
          <button onClick={add} className="text-xs px-3 py-1.5 rounded bg-black text-white">Save</button>
        </div>
      )}

      <table className="w-full text-xs">
        <thead className="text-gray-500 text-left">
          <tr><th className="py-1">Kind</th><th>Scope</th><th>Metric</th><th>Value</th><th>Weight</th><th>Hard</th><th>Origin</th><th /></tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className={`border-t ${r.enabled ? '' : 'opacity-40'}`}>
              <td className="py-1.5">{r.kind}</td>
              <td>{r.scope_level}</td>
              <td className="text-gray-500">{r.predicate?.metric}</td>
              <td className="font-medium">{r.predicate?.value}</td>
              <td className="text-gray-500" title="Adaptive ranking weight (learned from your decisions)">{r.weight.toFixed(2)}</td>
              <td>{r.is_hard ? '✓' : ''}</td>
              <td className="text-gray-400">{r.origin}</td>
              <td className="text-right whitespace-nowrap">
                <button onClick={() => editValue(r)} className="text-blue-600 hover:underline mr-2">edit</button>
                <button onClick={() => toggle(r)} className="text-gray-600 hover:underline mr-2">{r.enabled ? 'disable' : 'enable'}</button>
                {r.origin === 'manual' && <button onClick={() => remove(r)} className="text-red-600 hover:underline">delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
