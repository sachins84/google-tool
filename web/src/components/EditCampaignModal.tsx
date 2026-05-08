import { useState } from 'react';
import { api, type PerfRow, type MutatePayload } from '../lib/api';

interface Props {
  brandId: number;
  row: PerfRow;
  onClose: () => void;
  onSuccess: () => void;
}

export function EditCampaignModal({ brandId, row, onClose, onSuccess }: Props) {
  const [name, setName] = useState(row.campaign_name ?? '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [targetRoas, setTargetRoas] = useState<number | ''>('');
  const [targetCpa, setTargetCpa] = useState<number | ''>('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRunPassed, setDryRunPassed] = useState(false);

  function payload(dryRun: boolean): MutatePayload {
    const base: MutatePayload = {
      action: 'update_campaign_settings',
      brand_id: brandId,
      customer_id: row.customer_id,
      campaign_id: row.campaign_id ?? '',
      dry_run: dryRun,
    };
    // Only include fields the user has edited
    if (name && name !== row.campaign_name) (base as { name?: string }).name = name;
    if (startDate) (base as { start_date?: string }).start_date = startDate;
    if (endDate) (base as { end_date?: string }).end_date = endDate;
    if (targetRoas !== '') (base as { target_roas?: number }).target_roas = Number(targetRoas);
    if (targetCpa !== '') (base as { target_cpa_inr?: number }).target_cpa_inr = Number(targetCpa);
    return base;
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
          <h3 className="font-semibold">Edit campaign settings</h3>
          <p className="text-xs text-gray-500 mt-0.5">{row.campaign_name} ({row.channel_type})</p>
        </div>

        <div className="px-5 py-4 space-y-3 text-sm">
          <div>
            <label className="block text-xs font-medium mb-1 text-gray-700">Campaign name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); reset(); }}
              className="w-full border rounded px-3 py-1.5 text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-700">Start date (optional)</label>
              <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); reset(); }}
                className="w-full border rounded px-3 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-700">End date (optional)</label>
              <input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); reset(); }}
                className="w-full border rounded px-3 py-1.5 text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-700">Target ROAS (e.g. 4.0)</label>
              <input type="number" step="0.1" min={0.5} max={10} value={targetRoas}
                onChange={(e) => { setTargetRoas(e.target.value === '' ? '' : Number(e.target.value)); reset(); }}
                className="w-full border rounded px-3 py-1.5 text-sm" placeholder="leave blank to skip" />
              <p className="text-[10px] text-gray-500 mt-0.5">Only for Maximize Conversion Value bid strategy</p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-700">Target CPA (₹)</label>
              <input type="number" step="1" min={0} value={targetCpa}
                onChange={(e) => { setTargetCpa(e.target.value === '' ? '' : Number(e.target.value)); reset(); }}
                className="w-full border rounded px-3 py-1.5 text-sm" placeholder="leave blank to skip" />
              <p className="text-[10px] text-gray-500 mt-0.5">Only for Maximize Conversions bid strategy</p>
            </div>
          </div>

          <p className="text-xs text-gray-500">
            Leave a field blank to keep its current value. Only edited fields are sent. Bid strategy targets only apply if the campaign already uses that strategy.
          </p>

          {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-xs whitespace-pre-wrap">{error}</div>}
          {dryRunPassed && !error && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-3 text-xs">
              ✓ Dry-run passed — Google validated this. Click Execute to apply.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 rounded border bg-white hover:bg-gray-100 text-sm">Cancel</button>
          {!dryRunPassed ? (
            <button onClick={() => go(true)} disabled={busy}
              className="px-4 py-1.5 rounded bg-black text-white hover:opacity-90 text-sm disabled:opacity-40">
              {busy ? 'Validating…' : 'Validate (dry run)'}
            </button>
          ) : (
            <button onClick={() => go(false)} disabled={busy}
              className="px-4 py-1.5 rounded bg-red-600 text-white hover:opacity-90 text-sm disabled:opacity-40">
              {busy ? 'Saving…' : 'Execute'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
