import { getAccessToken } from './auth.js';

const DRIVE_LINK_RE = /https?:\/\/(?:drive|docs)\.google\.com\/[^\s,]+/i;

export interface SheetRow {
  sheetRow: number;        // 1-indexed row number in the sheet (header is row 1)
  driveLink: string;
  title: string | null;
  description: string | null;
  tags: string[];
}

export interface SheetSchema {
  spreadsheetId: string;
  sheetTitle: string;       // the actual tab name we ended up reading
  headerRow: string[];      // raw headers from row 1
  columnLetters: string[];  // A, B, C, ... aligned with headerRow
  driveCol: number;         // 0-based index of the drive link column
  titleCol: number | null;
  descCol: number | null;
  tagsCol: number | null;
  rows: SheetRow[];
}

export function parseSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m && m[1]) return m[1];
  // assume the input is already an ID
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  throw new Error(`Could not parse a Google Sheet ID from: ${input}`);
}

function colLetter(i: number): string {
  let n = i;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

async function sheetsFetch<T>(
  accessToken: string,
  pathAndQuery: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Read a sheet, auto-detect the Drive-link column + Title/Description/Tags
 * headers (case-insensitive). The sheet is read-only — per-row status and
 * the YouTube URL live in the youtube_job_rows table and surface in the UI,
 * not written back to the source sheet (so a spreadsheets.readonly scope
 * is sufficient).
 */
export async function readAndPrepareSheet(
  refreshToken: string,
  sheetInput: string,
  preferredTab?: string
): Promise<SheetSchema> {
  const { accessToken } = await getAccessToken(refreshToken);
  const spreadsheetId = parseSpreadsheetId(sheetInput);

  // Resolve which tab to read
  const meta = await sheetsFetch<{
    sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
  }>(accessToken, `${spreadsheetId}?fields=sheets.properties.title,sheets.properties.sheetId`);
  const tabs = (meta.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => !!t);
  if (!tabs.length) throw new Error('Spreadsheet has no sheets');
  const tabTitle = preferredTab && tabs.includes(preferredTab) ? preferredTab : tabs[0]!;

  const escTab = `'${tabTitle.replace(/'/g, "''")}'`;
  const values = await sheetsFetch<{ values?: string[][] }>(
    accessToken,
    `${spreadsheetId}/values/${encodeURIComponent(escTab)}?majorDimension=ROWS`
  );
  const grid = values.values ?? [];
  if (!grid.length) throw new Error(`Sheet "${tabTitle}" is empty`);

  const header = (grid[0] ?? []).map((h) => (h ?? '').toString());
  const dataRows = grid.slice(1);

  // Auto-detect Drive link column: pick the column with the most cells matching
  // a Drive URL across the data rows. Falls back to header containing "drive" / "link".
  const colCount = Math.max(header.length, ...dataRows.map((r) => r.length));
  const linkHits = new Array<number>(colCount).fill(0);
  for (const row of dataRows) {
    for (let c = 0; c < colCount; c++) {
      const v = row[c] ?? '';
      if (DRIVE_LINK_RE.test(v)) linkHits[c] = (linkHits[c] ?? 0) + 1;
    }
  }
  let driveCol = -1;
  let bestHits = 0;
  for (let c = 0; c < colCount; c++) {
    const h = linkHits[c] ?? 0;
    if (h > bestHits) {
      bestHits = h;
      driveCol = c;
    }
  }
  if (driveCol < 0) {
    // No row-level matches — fall back to header keyword
    driveCol = header.findIndex((h) => /drive|video|link|url/i.test(h));
  }
  if (driveCol < 0) {
    throw new Error('Could not auto-detect a Drive link column. Add a column of Drive URLs.');
  }

  const headerLower = header.map((h) => h.toLowerCase().trim());
  const findCol = (...names: string[]): number => {
    for (const n of names) {
      const i = headerLower.indexOf(n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };

  const titleCol = findCol('title', 'video title', 'name');
  const descCol = findCol('description', 'desc');
  const tagsCol = findCol('tags', 'keywords');

  const columnLetters = Array.from({ length: colCount }, (_, i) => colLetter(i));

  const rows: SheetRow[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i] ?? [];
    const link = (r[driveCol] ?? '').toString().trim();
    if (!DRIVE_LINK_RE.test(link)) continue;
    rows.push({
      sheetRow: i + 2, // header is row 1
      driveLink: link,
      title: titleCol >= 0 ? ((r[titleCol] ?? '').toString().trim() || null) : null,
      description: descCol >= 0 ? ((r[descCol] ?? '').toString().trim() || null) : null,
      tags: tagsCol >= 0
        ? (r[tagsCol] ?? '')
            .toString()
            .split(/[,;]/)
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    });
  }

  return {
    spreadsheetId,
    sheetTitle: tabTitle,
    headerRow: header,
    columnLetters,
    driveCol,
    titleCol: titleCol >= 0 ? titleCol : null,
    descCol: descCol >= 0 ? descCol : null,
    tagsCol: tagsCol >= 0 ? tagsCol : null,
    rows,
  };
}
