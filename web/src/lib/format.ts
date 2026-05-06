export function fmtINR(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

export function fmtNum(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtPct(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return (n * 100).toFixed(digits) + '%';
}

export function fmtMul(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export function fmtDelta(current: number, prev: number | undefined, kind: 'pct' | 'absolute' = 'pct'): string {
  if (prev == null || !Number.isFinite(prev) || prev === 0) return '—';
  if (kind === 'pct') {
    const d = (current - prev) / prev;
    const sign = d >= 0 ? '+' : '';
    return `${sign}${(d * 100).toFixed(0)}%`;
  }
  const d = current - prev;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(2)}`;
}

export function deltaTone(current: number, prev: number | undefined, betterIsHigher = true): string {
  if (prev == null || !Number.isFinite(prev) || prev === 0) return 'text-gray-400';
  const better = betterIsHigher ? current > prev : current < prev;
  return better ? 'text-emerald-600' : 'text-red-600';
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}
