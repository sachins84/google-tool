import { useEffect, useState } from 'react';
import { api, type MutatePayload } from '../lib/api';

interface Props {
  brandId: number;
  onClose: () => void;
  onSuccess: () => void;
}

type BidStrategy = 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE' | 'TARGET_CPA' | 'TARGET_ROAS';

interface Account { customer_id: string; descriptive_name: string | null; }

export function CreateCampaignModal({ brandId, onClose, onSuccess }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customerId, setCustomerId] = useState<string>('');
  const [name, setName] = useState('');
  const [budget, setBudget] = useState<number>(500);
  const [bidStrategy, setBidStrategy] = useState<BidStrategy>('MAXIMIZE_CONVERSIONS');
  const [targetCpa, setTargetCpa] = useState<number | ''>('');
  const [targetRoas, setTargetRoas] = useState<number | ''>('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [searchPartners, setSearchPartners] = useState(false);
  const [contentNetwork, setContentNetwork] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRunPassed, setDryRunPassed] = useState(false);

  useEffect(() => {
    void api.brandsList().then((b) => {
      const brand = b.brands.find((br) => br.id === brandId);
      if (!brand) return;
      const list = brand.accounts.map((a) => ({ customer_id: a.customer_id, descriptive_name: a.customer_name }));
      setAccounts(list);
      if (list[0]) setCustomerId(list[0].customer_id);
    });
  }, [brandId]);

  function reset() { setDryRunPassed(false); setError(null); }

  function payload(dryRun: boolean): MutatePayload {
    const base: MutatePayload = {
      action: 'create_search_campaign',
      brand_id: brandId,
      customer_id: customerId,
      name,
      daily_budget_inr: budget,
      bid_strategy: bidStrategy,
      search_partners: searchPartners,
      content_network: contentNetwork,
      dry_run: dryRun,
    };
    if (targetCpa !== '') (base as { target_cpa_inr?: number }).target_cpa_inr = Number(targetCpa);
    if (targetRoas !== '') (base as { target_roas?: number }).target_roas = Number(targetRoas);
    if (startDate) (base as { start_date?: string }).start_date = startDate;
    if (endDate) (base as { end_date?: string }).end_date = endDate;
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

  const requiresTargetCpa = bidStrategy === 'TARGET_CPA';
  const requiresTargetRoas = bidStrategy === 'TARGET_ROAS';
  const canValidate = name.trim().length > 0 && budget > 0 && customerId
    && (!requiresTargetCpa || targetCpa !== '')
    && (!requiresTargetRoas || targetRoas !== '');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-xl w-full max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b">
          <h3 className="font-semibold">Create Search campaign</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Creates the campaign in <strong>PAUSED</strong> state — review in Google Ads UI before enabling.
            For now this only supports Search campaigns; PMax/Shopping/Video can come later.
          </p>
        </div>

        <div className="px-5 py-4 space-y-4 text-sm">
          <div>
            <label className="block text-xs font-medium mb-1 text-gray-700">Account</label>
            <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); reset(); }}
              className="w-full border rounded px-3 py-1.5 text-sm">
              {accounts.length === 0 && <option value="">No accounts in brand</option>}
              {accounts.map((a) => (
                <option key={a.customer_id} value={a.customer_id}>
                  {a.descriptive_name ?? a.customer_id} ({a.customer_id})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1 text-gray-700">Campaign name</label>
            <input type="text" value={name} onChange={(e) => { setName(e.target.value); reset(); }}
              className="w-full border rounded px-3 py-1.5 text-sm" placeholder="e.g. Search_Brand_NewLaunch" autoFocus />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1 text-gray-700">Daily budget (₹)</label>
            <input type="number" min={50} step={1} value={budget}
              onChange={(e) => { setBudget(Number(e.target.value)); reset(); }}
              className="w-full border rounded px-3 py-1.5 text-sm" />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1 text-gray-700">Bid strategy</label>
            <select value={bidStrategy} onChange={(e) => { setBidStrategy(e.target.value as BidStrategy); reset(); }}
              className="w-full border rounded px-3 py-1.5 text-sm">
              <option value="MAXIMIZE_CONVERSIONS">Maximize Conversions</option>
              <option value="MAXIMIZE_CONVERSION_VALUE">Maximize Conversion Value</option>
              <option value="TARGET_CPA">Target CPA (requires target ₹)</option>
              <option value="TARGET_ROAS">Target ROAS (requires target ratio)</option>
            </select>
          </div>

          {(bidStrategy === 'MAXIMIZE_CONVERSIONS' || bidStrategy === 'TARGET_CPA') && (
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-700">
                Target CPA (₹) {bidStrategy === 'TARGET_CPA' && <span className="text-red-600">*required</span>}
              </label>
              <input type="number" step={1} min={0} value={targetCpa}
                onChange={(e) => { setTargetCpa(e.target.value === '' ? '' : Number(e.target.value)); reset(); }}
                className="w-full border rounded px-3 py-1.5 text-sm" placeholder="leave blank for unconstrained" />
            </div>
          )}

          {(bidStrategy === 'MAXIMIZE_CONVERSION_VALUE' || bidStrategy === 'TARGET_ROAS') && (
            <div>
              <label className="block text-xs font-medium mb-1 text-gray-700">
                Target ROAS (e.g. 4.0 = 400%) {bidStrategy === 'TARGET_ROAS' && <span className="text-red-600">*required</span>}
              </label>
              <input type="number" step={0.1} min={0.5} max={10} value={targetRoas}
                onChange={(e) => { setTargetRoas(e.target.value === '' ? '' : Number(e.target.value)); reset(); }}
                className="w-full border rounded px-3 py-1.5 text-sm" placeholder="leave blank for unconstrained" />
            </div>
          )}

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

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={searchPartners} onChange={(e) => { setSearchPartners(e.target.checked); reset(); }} />
              Include Search Partners network
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={contentNetwork} onChange={(e) => { setContentNetwork(e.target.checked); reset(); }} />
              Include Display Network expansion
            </label>
          </div>

          <p className="text-xs text-gray-500">
            Defaults: targets India + English/Hindi audiences. Campaign created in PAUSED state — go to Google Ads UI to add ad groups, keywords and ads, then enable.
          </p>

          {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-xs whitespace-pre-wrap">{error}</div>}
          {dryRunPassed && !error && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-3 text-xs">
              ✓ Google validated the operations. Click Execute to create.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 rounded border bg-white hover:bg-gray-100 text-sm">Cancel</button>
          {!dryRunPassed ? (
            <button onClick={() => go(true)} disabled={busy || !canValidate}
              className="px-4 py-1.5 rounded bg-black text-white hover:opacity-90 text-sm disabled:opacity-40">
              {busy ? 'Validating…' : 'Validate (dry run)'}
            </button>
          ) : (
            <button onClick={() => go(false)} disabled={busy}
              className="px-4 py-1.5 rounded bg-red-600 text-white hover:opacity-90 text-sm disabled:opacity-40">
              {busy ? 'Creating…' : 'Execute'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
