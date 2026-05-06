function isoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export type Preset = 'last_7' | 'last_14' | 'last_30' | 'mtd' | 'today' | 'yesterday' | 'custom';

export interface DateRange {
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
}

export function rangeForPreset(preset: Preset, today = new Date()): DateRange {
  const yesterday = addDays(today, -1);
  switch (preset) {
    case 'today':
      return { from: isoDate(today), to: isoDate(today) };
    case 'yesterday':
      return { from: isoDate(yesterday), to: isoDate(yesterday) };
    case 'last_7':
      return rangeWithCompare(addDays(yesterday, -6), yesterday);
    case 'last_14':
      return rangeWithCompare(addDays(yesterday, -13), yesterday);
    case 'last_30':
      return rangeWithCompare(addDays(yesterday, -29), yesterday);
    case 'mtd': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      return rangeWithCompare(first, yesterday);
    }
    default:
      return rangeWithCompare(addDays(yesterday, -6), yesterday);
  }
}

function rangeWithCompare(from: Date, to: Date): DateRange {
  const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  const compareTo = addDays(from, -1);
  const compareFrom = addDays(compareTo, -(days - 1));
  return {
    from: isoDate(from),
    to: isoDate(to),
    compareFrom: isoDate(compareFrom),
    compareTo: isoDate(compareTo),
  };
}

export function buildCompareRange(from: string, to: string): { compareFrom: string; compareTo: string } {
  const f = new Date(from);
  const t = new Date(to);
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const compareTo = addDays(f, -1);
  const compareFrom = addDays(compareTo, -(days - 1));
  return { compareFrom: isoDate(compareFrom), compareTo: isoDate(compareTo) };
}
