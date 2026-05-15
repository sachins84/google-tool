import { useState } from 'react';
import { api, type PerfRow, type MutatePayload } from '../lib/api';

interface Props {
  brandId: number;
  row: PerfRow;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Adjust manual CPC / target CPA / target ROAS at the ad-group level.
 * Which of these Google accepts depends on the parent campaign's bidding
 * strategy:
 *   - Manual CPC (Shopping default) → cpc_bid
 *   - Maximize Conversions / Target CPA → optional ad-group target_cpa
 *   - Maximize Conv. Value / Target ROAS (Demand Gen, Shopping) → optional ad-group target_roas
 * Incompatible combos return a Google API error in the dry-run.
 */
export function EditAdGroupBidsModal({ brandId, row, onClose, onSuccess }: Props) {
  const [cpcInr, setCpcInr] = useState<number | ''>(
    row.cpc_bid_inr != null ? Number(row.cpc_bid_inr.toFixed(2)) : ''
  );
  const [targetCpaInr, setTargetCpaInr] = useState<number | ''>(
    row.ad_group_target_cpa_inr != null ? Number(row.ad_group_target_cpa_inr.toFixed(2)) : ''
  );
  const [targetRoas, setTargetRoas] = useState<number | ''>(
    row.ad_group_target_roas != null ? Number(row.ad_group_target_roas.toFixed(2)) : ''
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRunPassed, setDryRunPassed] = useState(false);

  const beforeCpc = row.cpc_bid_inr ?? null;
  const beforeCpa = row.ad_group_target_cpa_inr ?? null;
  const beforeRoas = row.ad_group_target_roas ?? null;

  const cpcChanged = cpcInr !== '' && cpcInr !== beforeCpc;
  const cpaChanged = targetCpaInr !== '' && targetCpaInr !== beforeCpa;
  const roasChanged = targetRoas !== '' && targetRoas !== beforeRoas;
  const anyChange = cpcChanged || cpaChanged || roasChanged;

  function payload(dryRun: boolean): MutatePayload {
    return {
      action: 'update_ad_group_bids',
      brand_id: brandId,
      customer_id: row.customer_id,
      ad_group_id: row.ad_group_id ?? '',
      ...(cpcChanged ? { cpc_bid_inr: Number(cpcInr) } : {}),
      ...(cpaChanged ? { target_cpa_inr: Number(targetCpaInr) } : {}),
      ...(roasChanged ? { target_roas: Number(targetRoas) } : {}),
      dry_run: dryRun,
    };
  }

  async function go(dryRun: boolean) {
    setError(null);
    setBusy(true);
    try {
      await api.mutate(payload(dryRun));
      if (dryRun) setDryRunPassed(true);
      else onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDryRunPassed(false);
    } finally {
      setBusy(false);
    }
  }

  function reset() { setDryRunPassed(false); setError(null); }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full">
        <div className="px-5 py-4 border-b">
          <h3 className="font-semibold">Edit ad-group bids</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {row.ad_group_name} <span className="text-gray-400">·</span> {row.campaign_name}
            {row.channel_type && <span className="text-gray-400"> · {row.channel_type.replace('_', ' ')}</span>}
          </p>
        </div>

        <div className="px-5 py-4 space-y-3 text-sm">
          <div>
            <label className="block text-xs font-medium mb-1 text-gray-700">Manual CPC bid (₹)</label>
            <input
              type="number"
              step="0.1"
              min={0}
              value={cpcInr}
              onChange={(e) => { setCpcInr(e.target.value === '' ? '' : Number(e.target.value)); reset(); }}
              className="w-full border rounded px-3 py-1.5 text-sm"
              placeholder={beforeCpc != null ? `current ₹${beforeCpc.toFixed(2)}` : 'leave blank if N/A'}
            />
            <p className="text-[10px] text-gray-500 mt-0.5">Used by Manual CPC bid strategies (Shopping, Search w/ manual CPC)</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-700">Target CPA (₹)</label>
              <input
                type="number"
                step="1"
                min={0}
                value={targetCpaInr}
                onChange={(e) => { setTargetCpaInr(e.target.value === '' ? '' : Number(e.target.value)); reset(); }}
                className="w-full border rounded px-3 py-1.5 text-sm"
                placeholder={beforeCpa != null ? `current ₹${beforeCpa.toFixed(0)}` : 'leave blank if N/A'}
              />
              <p className="text-[10px] text-gray-500 mt-0.5">Maximize Conversions / Target CPA</p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-700">Target ROAS (e.g. 4.0)</label>
              <input
                type="number"
                step="0.1"
                min={0.5}
                max={20}
                value={targetRoas}
                onChange={(e) => { setTargetRoas(e.target.value === '' ? '' : Number(e.target.value)); reset(); }}
                className="w-full border rounded px-3 py-1.5 text-sm"
                placeholder={beforeRoas != null ? `current ${beforeRoas.toFixed(2)}` : 'leave blank if N/A'}
              />
              <p className="text-[10px] text-gray-500 mt-0.5">Maximize Conv. Value / Target ROAS (Demand Gen, Shopping)</p>
            </div>
          </div>

          <p className="text-xs text-gray-500">
            Only edited fields are sent. Which fields work depends on the parent campaign's bidding strategy —
            Google rejects incompatible combos with a clear error in the dry-run.
          </p>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-xs whitespace-pre-wrap">
              {error}
            </div>
          )}
          {dryRunPassed && !error && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-3 text-xs">
              ✓ Dry-run passed — Google validated this. Click Execute to apply.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 rounded border bg-white hover:bg-gray-100 text-sm">Cancel</button>
          {!dryRunPassed ? (
            <button
              onClick={() => go(true)}
              disabled={busy || !anyChange}
              title={!anyChange ? 'Edit at least one field' : ''}
              className="px-4 py-1.5 rounded bg-black text-white hover:opacity-90 text-sm disabled:opacity-40"
            >
              {busy ? 'Validating…' : 'Validate (dry run)'}
            </button>
          ) : (
            <button
              onClick={() => go(false)}
              disabled={busy}
              className="px-4 py-1.5 rounded bg-red-600 text-white hover:opacity-90 text-sm disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Execute'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
