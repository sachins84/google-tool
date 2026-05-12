import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ASSET_TEXT_LIMITS,
  type AssetRow,
  type AssetTextFieldType,
  type MutatePayload,
} from '../lib/api';
import { fmtINR, fmtMul, fmtNum, truncate } from '../lib/format';

interface Props {
  brandId: number;
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
  campaignId?: string;
  assetGroupId?: string;
}

type AssetActionKind = 'pause_asset' | 'enable_asset' | 'remove_asset';

interface PendingAction {
  kind: AssetActionKind;
  row: AssetRow;
  customerId: string;
}

interface AddingAction {
  customerId: string;
  assetGroupId: string;
  assetGroupName: string;
}

const FIELD_TYPE_ORDER = [
  'HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME',
  'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'LOGO',
  'YOUTUBE_VIDEO', 'CALL_TO_ACTION_SELECTION', 'SITELINK',
];

export function Assets({ brandId, from, to, compareFrom, compareTo, campaignId, assetGroupId }: Props) {
  const [rows, setRows] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [labelFilter, setLabelFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'enabled' | 'paused' | 'all'>('enabled');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [adding, setAdding] = useState<AddingAction | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.assets({
      brand_id: brandId, from, to,
      compare_from: compareFrom, compare_to: compareTo,
      campaign_id: campaignId, asset_group_id: assetGroupId,
    })
      .then((res) => { if (!cancelled) setRows(res.rows); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, from, to, compareFrom, compareTo, campaignId, assetGroupId, refreshTick]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (labelFilter && r.performance_label !== labelFilter) return false;
      if (statusFilter !== 'all') {
        const want = statusFilter === 'enabled' ? 'ENABLED' : 'PAUSED';
        if ((r.status ?? '').toUpperCase() !== want) return false;
      }
      return true;
    });
  }, [rows, labelFilter, statusFilter]);

  const grouped = useMemo(() => {
    const m = new Map<string, AssetRow[]>();
    for (const r of filtered) {
      const key = r.asset_group_id ?? '(unknown)';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r);
    }
    return Array.from(m.entries()).map(([id, items]) => ({
      id,
      name: items[0]?.asset_group_name ?? '—',
      campaign: items[0]?.campaign_name ?? '—',
      customerId: items[0]?.customer_id ?? '',
      items,
    }));
  }, [filtered]);

  const labelCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) {
      const k = r.performance_label ?? 'UNKNOWN';
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Loading assets…</div>;
  if (error) return <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-gray-700">Performance:</span>
        {(['', 'BEST', 'GOOD', 'LOW', 'PENDING', 'UNKNOWN'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLabelFilter(l)}
            className={`px-2.5 py-1 rounded text-xs ${
              labelFilter === l ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200'
            }`}
          >
            {l || 'All'}{l && <span className="ml-1 opacity-60">{labelCounts[l] ?? 0}</span>}
          </button>
        ))}
        <span className="text-sm text-gray-700 ml-3">Status:</span>
        {(['enabled', 'paused', 'all'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-2.5 py-1 rounded text-xs ${
              statusFilter === s ? 'bg-black text-white' : 'bg-gray-100 hover:bg-gray-200'
            }`}
          >
            {s === 'enabled' ? 'Active' : s === 'paused' ? 'Paused' : 'All'}
          </button>
        ))}
        <span className="text-xs text-gray-500 ml-auto">
          {filtered.length} of {rows.length} assets in {grouped.length} groups
        </span>
      </div>

      <div className="space-y-4">
        {grouped.map((g) => (
          <div key={g.id} className="bg-white rounded shadow border overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 border-b flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm truncate">{g.name}</div>
                <div className="text-xs text-gray-500">{g.campaign}</div>
              </div>
              <button
                onClick={() => setAdding({ customerId: g.customerId, assetGroupId: g.id, assetGroupName: g.name })}
                className="text-xs bg-black text-white px-3 py-1 rounded hover:opacity-90 whitespace-nowrap"
              >
                + Add asset
              </button>
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-gray-600 border-b">
                <tr>
                  <th className="px-4 py-1.5 font-medium">Type</th>
                  <th className="px-4 py-1.5 font-medium">Asset</th>
                  <th className="px-4 py-1.5 font-medium text-center">Status</th>
                  <th className="px-4 py-1.5 font-medium text-center">Performance</th>
                  <th className="px-4 py-1.5 font-medium text-right">Spend</th>
                  <th className="px-4 py-1.5 font-medium text-right">Impr</th>
                  <th className="px-4 py-1.5 font-medium text-right">Clicks</th>
                  <th className="px-4 py-1.5 font-medium text-right">Conv</th>
                  <th className="px-4 py-1.5 font-medium text-right">Conv. value</th>
                  <th className="px-4 py-1.5 font-medium text-right">ROAS (RTO)</th>
                  <th className="px-4 py-1.5 font-medium text-right w-12"></th>
                </tr>
              </thead>
              <tbody>
                {g.items
                  .slice()
                  .sort((a, b) => {
                    // sort first by spend desc within group, then fall back to canonical type order
                    const aCost = a.metrics?.cost ?? 0;
                    const bCost = b.metrics?.cost ?? 0;
                    if (aCost !== bCost) return bCost - aCost;
                    const ai = FIELD_TYPE_ORDER.indexOf(a.field_type ?? '');
                    const bi = FIELD_TYPE_ORDER.indexOf(b.field_type ?? '');
                    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                  })
                  .map((a) => {
                    const rowKey = `${g.id}|${a.asset_id}|${a.field_type}`;
                    const m = a.metrics;
                    return (
                      <tr key={rowKey} className="border-t">
                        <td className="px-4 py-1.5 text-xs text-gray-600">{a.field_type ?? '—'}</td>
                        <td className="px-4 py-1.5">
                          {a.image_url ? (
                            <img src={a.image_url} alt="" className="h-10 w-10 object-cover rounded" />
                          ) : a.youtube_video_id ? (
                            <a
                              href={`https://youtu.be/${a.youtube_video_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-700 hover:underline"
                            >
                              ▶ youtu.be/{a.youtube_video_id}
                            </a>
                          ) : (
                            <span className="text-sm">{truncate(a.text ?? '—', 80)}</span>
                          )}
                        </td>
                        <td className="px-4 py-1.5 text-center">
                          <StatusPill status={a.status} />
                        </td>
                        <td className="px-4 py-1.5 text-center">
                          <PerfPill label={a.performance_label} />
                        </td>
                        <Cell value={m?.cost} prev={a.comparison?.cost} fmt={fmtINR} betterIs="lower" deltaKind="pct" />
                        <Cell value={m?.impressions} prev={a.comparison?.impressions} fmt={fmtNum} betterIs="neutral" deltaKind="pct" />
                        <Cell value={m?.clicks} prev={a.comparison?.clicks} fmt={fmtNum} betterIs="higher" deltaKind="pct" />
                        <Cell value={m?.conversions} prev={a.comparison?.conversions} fmt={(n) => fmtNum(n, 0)} betterIs="higher" deltaKind="pct" />
                        <Cell value={m?.conversions_value_post_rto} prev={a.comparison?.conversions_value_post_rto} fmt={fmtINR} betterIs="higher" deltaKind="pct" />
                        <Cell value={m?.roas_post_rto} prev={a.comparison?.roas_post_rto} fmt={fmtMul} betterIs="higher" deltaKind="absolute" bold />
                        <td className="px-4 py-1.5 text-right relative">
                          <button
                            onClick={() => setOpenMenuFor(openMenuFor === rowKey ? null : rowKey)}
                            className="text-gray-500 hover:text-black px-2 py-1 rounded hover:bg-gray-100 text-xs"
                          >
                            ⋯
                          </button>
                          {openMenuFor === rowKey && (
                            <div className="absolute right-2 top-9 bg-white border rounded shadow-lg z-20 min-w-[160px] py-1 text-left">
                              {a.status !== 'PAUSED' && (
                                <ActionButton onClick={() => {
                                  setOpenMenuFor(null);
                                  setPending({ kind: 'pause_asset', row: a, customerId: g.customerId });
                                }}>Pause</ActionButton>
                              )}
                              {a.status !== 'ENABLED' && (
                                <ActionButton onClick={() => {
                                  setOpenMenuFor(null);
                                  setPending({ kind: 'enable_asset', row: a, customerId: g.customerId });
                                }}>Enable</ActionButton>
                              )}
                              <ActionButton onClick={() => {
                                setOpenMenuFor(null);
                                setPending({ kind: 'remove_asset', row: a, customerId: g.customerId });
                              }}>
                                <span className="text-red-700">Remove</span>
                              </ActionButton>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ))}
        {!grouped.length && (
          <div className="text-sm text-gray-500 py-8 text-center bg-white rounded border">
            No PMax assets for this scope{labelFilter ? ` with label ${labelFilter}` : ''}.
          </div>
        )}
      </div>

      {pending && (
        <AssetActionModal
          brandId={brandId}
          action={pending}
          onClose={() => setPending(null)}
          onSuccess={() => {
            setPending(null);
            setRefreshTick((n) => n + 1);
          }}
        />
      )}
      {adding && (
        <AssetAddModal
          brandId={brandId}
          adding={adding}
          onClose={() => setAdding(null)}
          onSuccess={() => {
            setAdding(null);
            setRefreshTick((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50">
      {children}
    </button>
  );
}

function StatusPill({ status }: { status?: string }) {
  if (!status) return <span className="text-gray-400">—</span>;
  const s = status.toUpperCase();
  const color =
    s === 'ENABLED' ? 'bg-emerald-100 text-emerald-800'
    : s === 'PAUSED' ? 'bg-amber-100 text-amber-800'
    : s === 'REMOVED' ? 'bg-gray-200 text-gray-600'
    : 'bg-gray-100 text-gray-700';
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${color}`}>{s}</span>;
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

function PerfPill({ label }: { label?: string }) {
  if (!label) return <span className="text-gray-400">—</span>;
  const tone =
    label === 'BEST' ? 'bg-emerald-100 text-emerald-800'
    : label === 'GOOD' ? 'bg-blue-100 text-blue-800'
    : label === 'LOW' ? 'bg-red-100 text-red-800'
    : label === 'PENDING' ? 'bg-amber-100 text-amber-800'
    : 'bg-gray-100 text-gray-700';
  const tip =
    label === 'PENDING' ? 'Pending Google review — auto-transitions to LOW/GOOD/BEST after enough impressions (~1–2 weeks)'
    : label === 'LOW' ? 'Underperforming relative to other assets in the group'
    : label === 'GOOD' ? 'Performing well'
    : label === 'BEST' ? 'Top performer in the group'
    : '';
  return <span title={tip} className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${tone}`}>{label}</span>;
}

// ────────────────────────────────────────────────────────────────────────────
// Modals

interface ActionModalProps {
  brandId: number;
  action: PendingAction;
  onClose: () => void;
  onSuccess: () => void;
}

function AssetActionModal({ brandId, action, onClose, onSuccess }: ActionModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRunPassed, setDryRunPassed] = useState(false);

  function payload(dryRun: boolean): MutatePayload | null {
    const r = action.row;
    if (!r.asset_group_id || !r.asset_id || !r.field_type) return null;
    return {
      action: action.kind,
      brand_id: brandId,
      customer_id: action.customerId,
      asset_group_id: r.asset_group_id,
      asset_id: r.asset_id,
      field_type: r.field_type as MutatePayload extends { field_type: infer F } ? F & string : never,
      dry_run: dryRun,
    } as MutatePayload;
  }

  async function go(dryRun: boolean) {
    setError(null);
    setBusy(true);
    try {
      const p = payload(dryRun);
      if (!p) throw new Error('Asset row missing required IDs');
      await api.mutate(p);
      if (dryRun) setDryRunPassed(true);
      else onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const verb =
    action.kind === 'pause_asset' ? 'Pause asset'
    : action.kind === 'enable_asset' ? 'Enable asset'
    : 'Remove asset';

  return (
    <Shell title={verb} onClose={onClose}>
      <Detail label="Field type" value={action.row.field_type ?? '—'} />
      <Detail label="Asset" value={
        action.row.text ? `"${truncate(action.row.text, 80)}"` :
        action.row.image_url ? '(image)' :
        action.row.youtube_video_id ? `youtu.be/${action.row.youtube_video_id}` : '—'
      } />
      <Detail label="Asset group" value={action.row.asset_group_name ?? action.row.asset_group_id ?? '—'} />
      {action.kind === 'remove_asset' && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded p-3 text-xs">
          This removes the asset from the asset group. The underlying asset may still exist
          and be reusable in other groups.
        </div>
      )}
      <Footer
        busy={busy}
        error={error}
        dryRunPassed={dryRunPassed}
        onClose={onClose}
        onValidate={() => go(true)}
        onExecute={() => go(false)}
      />
    </Shell>
  );
}

interface AddModalProps {
  brandId: number;
  adding: AddingAction;
  onClose: () => void;
  onSuccess: () => void;
}

function AssetAddModal({ brandId, adding, onClose, onSuccess }: AddModalProps) {
  const [fieldType, setFieldType] = useState<AssetTextFieldType>('HEADLINE');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRunPassed, setDryRunPassed] = useState(false);

  const limit = ASSET_TEXT_LIMITS[fieldType];
  const overLimit = text.length > limit;

  function payload(dryRun: boolean): MutatePayload {
    return {
      action: 'add_text_asset',
      brand_id: brandId,
      customer_id: adding.customerId,
      asset_group_id: adding.assetGroupId,
      field_type: fieldType,
      text,
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
      // if the user edits text/field after a failed/success dry-run, we should re-validate
      setDryRunPassed(false);
    } finally {
      setBusy(false);
    }
  }

  function onChangeField(v: AssetTextFieldType) {
    setFieldType(v);
    setDryRunPassed(false);
    setError(null);
  }
  function onChangeText(v: string) {
    setText(v);
    setDryRunPassed(false);
  }

  return (
    <Shell title={`Add asset to ${truncate(adding.assetGroupName, 50)}`} onClose={onClose}>
      <div>
        <label className="block text-xs font-medium mb-1 text-gray-700">Field type</label>
        <select
          value={fieldType}
          onChange={(e) => onChangeField(e.target.value as AssetTextFieldType)}
          className="w-full border rounded px-3 py-1.5 text-sm"
        >
          <option value="HEADLINE">Headline (max {ASSET_TEXT_LIMITS.HEADLINE} chars)</option>
          <option value="LONG_HEADLINE">Long headline (max {ASSET_TEXT_LIMITS.LONG_HEADLINE} chars)</option>
          <option value="DESCRIPTION">Description (max {ASSET_TEXT_LIMITS.DESCRIPTION} chars)</option>
          <option value="BUSINESS_NAME">Business name (max {ASSET_TEXT_LIMITS.BUSINESS_NAME} chars)</option>
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium mb-1 text-gray-700">Text</label>
        <textarea
          value={text}
          onChange={(e) => onChangeText(e.target.value)}
          rows={3}
          autoFocus
          className={`w-full border rounded px-3 py-1.5 text-sm ${overLimit ? 'border-red-400' : ''}`}
        />
        <div className={`text-xs mt-1 ${overLimit ? 'text-red-600' : 'text-gray-500'}`}>
          {text.length} / {limit} characters
        </div>
      </div>
      <p className="text-xs text-gray-500">
        New text assets start as <strong>PENDING</strong> while Google reviews them. The performance
        label updates to LOW / GOOD / BEST once the asset has enough impressions.
      </p>
      <Footer
        busy={busy}
        error={error}
        dryRunPassed={dryRunPassed}
        canValidate={!overLimit && text.trim().length > 0}
        onClose={onClose}
        onValidate={() => go(true)}
        onExecute={() => go(false)}
      />
    </Shell>
  );
}

// Modal scaffolding

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full">
        <div className="px-5 py-4 border-b">
          <h3 className="font-semibold">{title}</h3>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">{children}</div>
      </div>
    </div>
  );
}

function Footer({
  busy, error, dryRunPassed, canValidate = true, onClose, onValidate, onExecute,
}: {
  busy: boolean;
  error: string | null;
  dryRunPassed: boolean;
  canValidate?: boolean;
  onClose: () => void;
  onValidate: () => void;
  onExecute: () => void;
}) {
  return (
    <>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-xs whitespace-pre-wrap">
          {error}
        </div>
      )}
      {dryRunPassed && !error && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-3 text-xs">
          ✓ Dry-run passed — Google validated this. Click Execute to apply for real.
        </div>
      )}
      <div className="-mx-5 -mb-4 mt-3 px-5 py-3 border-t bg-gray-50 flex justify-end gap-2 rounded-b-lg">
        <button onClick={onClose} className="px-4 py-1.5 rounded border bg-white hover:bg-gray-100 text-sm">Cancel</button>
        {!dryRunPassed ? (
          <button
            onClick={onValidate}
            disabled={busy || !canValidate}
            className="px-4 py-1.5 rounded bg-black text-white hover:opacity-90 text-sm disabled:opacity-40"
          >
            {busy ? 'Validating…' : 'Validate (dry run)'}
          </button>
        ) : (
          <button
            onClick={onExecute}
            disabled={busy}
            className="px-4 py-1.5 rounded bg-red-600 text-white hover:opacity-90 text-sm disabled:opacity-40"
          >
            {busy ? 'Executing…' : 'Execute for real'}
          </button>
        )}
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs text-gray-500 w-24 shrink-0">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}
