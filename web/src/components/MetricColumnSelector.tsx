import { useEffect, useRef, useState } from 'react';
import { METRIC_COLUMNS, GROUP_LABELS, defaultVisibleSet, type MetricColumn } from '../lib/metricColumns';

interface Props {
  visible: Set<string>;
  onChange: (next: Set<string>) => void;
  showCalcMetrics?: boolean;
}

export function MetricColumnSelector({ visible, onChange, showCalcMetrics = false }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const visibleCount = visible.size;

  function toggle(key: string) {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  function resetDefaults() {
    onChange(defaultVisibleSet());
  }

  const groups: Record<string, MetricColumn[]> = {};
  for (const col of METRIC_COLUMNS) {
    if (col.calcOnly && !showCalcMetrics) continue;
    (groups[col.group] ??= []).push(col);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="text-sm border rounded px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2"
        title="Choose which metric columns to display"
      >
        <span>⚙️ Metrics</span>
        <span className="text-xs text-gray-500">{visibleCount}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-30 bg-white border rounded shadow-lg w-[420px] max-h-[500px] overflow-y-auto">
          <div className="sticky top-0 bg-white border-b px-3 py-2 flex justify-between items-center">
            <span className="text-sm font-semibold">Visible metrics</span>
            <button onClick={resetDefaults} className="text-xs text-blue-700 hover:underline">
              Reset defaults
            </button>
          </div>
          {Object.entries(groups).map(([groupKey, cols]) => (
            <div key={groupKey} className="border-b last:border-b-0">
              <div className="px-3 py-1.5 bg-gray-50 text-[11px] uppercase font-medium text-gray-500">
                {GROUP_LABELS[groupKey as MetricColumn['group']]}
              </div>
              <div className="py-1">
                {cols.map((col) => (
                  <label
                    key={col.key as string}
                    className="flex items-center gap-2 px-3 py-1 hover:bg-gray-50 text-sm cursor-pointer"
                    title={col.longLabel}
                  >
                    <input
                      type="checkbox"
                      checked={visible.has(col.key as string)}
                      onChange={() => toggle(col.key as string)}
                    />
                    <span className="flex-1">
                      {col.label}
                      {col.searchOnly && <span className="text-[10px] text-gray-400 ml-1">(Search/Shop)</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
