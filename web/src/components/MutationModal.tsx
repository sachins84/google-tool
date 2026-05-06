import { useState } from 'react';
import { api, type MutatePayload, type PerfRow } from '../lib/api';
import type { RowAction } from './MetricsTable';
import { fmtINR } from '../lib/format';

interface Props {
  brandId: number;
  action: RowAction;
  onClose: () => void;
  onSuccess: () => void;
}

export function MutationModal({ brandId, action, onClose, onSuccess }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRunPassed, setDryRunPassed] = useState(false);
  const [budgetInr, setBudgetInr] = useState<number>(action.kind === 'update_budget' ? Math.round(action.row.daily_budget_inr ?? 0) : 0);
  const [negText, setNegText] = useState<string>(action.kind === 'add_negative' ? action.row.search_term ?? '' : '');
  const [negMatch, setNegMatch] = useState<'EXACT' | 'PHRASE' | 'BROAD'>('PHRASE');

  function buildPayload(dryRun: boolean): MutatePayload | null {
    const r = action.row;
    if (!r.customer_id) return null;
    if (action.kind === 'pause' || action.kind === 'enable') {
      return {
        action: action.kind,
        level: action.level,
        brand_id: brandId,
        customer_id: r.customer_id,
        campaign_id: r.campaign_id,
        ad_group_id: r.ad_group_id,
        ad_id: r.ad_id,
        criterion_id: r.criterion_id,
        dry_run: dryRun,
      };
    }
    if (action.kind === 'update_budget') {
      if (!r.campaign_id) return null;
      return {
        action: 'update_budget',
        brand_id: brandId,
        customer_id: r.customer_id,
        campaign_id: r.campaign_id,
        daily_budget_inr: budgetInr,
        dry_run: dryRun,
      };
    }
    // add_negative
    if (!r.campaign_id) return null;
    return {
      action: 'add_negative_keyword',
      scope: 'campaign',
      brand_id: brandId,
      customer_id: r.customer_id,
      campaign_id: r.campaign_id,
      text: negText,
      match_type: negMatch,
      dry_run: dryRun,
    };
  }

  async function handleDryRun() {
    setError(null);
    setBusy(true);
    try {
      const payload = buildPayload(true);
      if (!payload) throw new Error('Missing required IDs on row');
      await api.mutate(payload);
      setDryRunPassed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleExecute() {
    setError(null);
    setBusy(true);
    try {
      const payload = buildPayload(false);
      if (!payload) throw new Error('Missing required IDs on row');
      await api.mutate(payload);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function title(): string {
    const r = action.row;
    if (action.kind === 'pause') return `Pause ${action.level}`;
    if (action.kind === 'enable') return `Enable ${action.level}`;
    if (action.kind === 'update_budget') return `Update budget — ${r.campaign_name ?? r.campaign_id}`;
    return `Add as negative keyword`;
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full">
        <div className="px-5 py-4 border-b">
          <h3 className="font-semibold">{title()}</h3>
        </div>

        <div className="px-5 py-4 space-y-3 text-sm">
          <Detail label="Brand ID" value={String(brandId)} />
          <Detail label="Customer" value={action.row.customer_id} />
          {action.row.campaign_name && <Detail label="Campaign" value={action.row.campaign_name} />}
          {action.row.ad_group_name && <Detail label="Ad group" value={action.row.ad_group_name} />}

          {action.kind === 'update_budget' && (
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-700">New daily budget (INR)</label>
              <input
                type="number"
                value={budgetInr}
                onChange={(e) => setBudgetInr(Number(e.target.value))}
                className="w-full border rounded px-3 py-1.5"
                min={0}
              />
              <p className="text-xs text-gray-500 mt-1">
                Current: {fmtINR(action.row.daily_budget_inr ?? 0)} → New: {fmtINR(budgetInr)}
              </p>
            </div>
          )}

          {action.kind === 'add_negative' && (
            <>
              <div>
                <label className="block text-xs font-medium mb-1 text-gray-700">Negative keyword text</label>
                <input
                  type="text"
                  value={negText}
                  onChange={(e) => setNegText(e.target.value)}
                  className="w-full border rounded px-3 py-1.5"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1 text-gray-700">Match type</label>
                <select
                  value={negMatch}
                  onChange={(e) => setNegMatch(e.target.value as 'EXACT' | 'PHRASE' | 'BROAD')}
                  className="w-full border rounded px-3 py-1.5"
                >
                  <option value="PHRASE">PHRASE (recommended)</option>
                  <option value="EXACT">EXACT</option>
                  <option value="BROAD">BROAD</option>
                </select>
              </div>
              <p className="text-xs text-gray-500">
                Will be added at the campaign level (inherits to all ad groups).
              </p>
            </>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-xs whitespace-pre-wrap">
              {error}
            </div>
          )}

          {dryRunPassed && !error && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-3 text-xs">
              ✓ Dry-run passed — Google validated this operation. Click Execute to apply for real.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 rounded border bg-white hover:bg-gray-100 text-sm">
            Cancel
          </button>
          {!dryRunPassed ? (
            <button
              onClick={handleDryRun}
              disabled={busy}
              className="px-4 py-1.5 rounded bg-black text-white hover:opacity-90 text-sm disabled:opacity-40"
            >
              {busy ? 'Validating…' : 'Validate (dry run)'}
            </button>
          ) : (
            <button
              onClick={handleExecute}
              disabled={busy}
              className="px-4 py-1.5 rounded bg-red-600 text-white hover:opacity-90 text-sm disabled:opacity-40"
            >
              {busy ? 'Executing…' : 'Execute for real'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs text-gray-500 w-24 shrink-0">{label}</span>
      <span className="text-sm font-mono">{value}</span>
    </div>
  );
}
