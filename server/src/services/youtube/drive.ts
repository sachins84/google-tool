import { getAccessToken } from './auth.js';

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number; // bytes; throws if Drive doesn't report a size (e.g. Google Docs)
}

/**
 * Parse a Drive file ID from any reasonable URL form:
 *   https://drive.google.com/file/d/<ID>/view
 *   https://drive.google.com/open?id=<ID>
 *   https://drive.google.com/uc?id=<ID>&export=download
 *   https://docs.google.com/file/d/<ID>/edit
 *   <ID> alone
 */
export function parseDriveFileId(input: string): string {
  const s = input.trim();
  const fileD = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileD && fileD[1]) return fileD[1];
  const open = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (open && open[1]) return open[1];
  const dDoc = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (dDoc && dDoc[1]) return dDoc[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  throw new Error(`Could not parse Drive file ID from: ${input}`);
}

export async function getDriveFileInfo(
  refreshToken: string,
  fileId: string
): Promise<DriveFileInfo> {
  const { accessToken } = await getAccessToken(refreshToken);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive files.get ${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
  };
  if (!json.size) {
    throw new Error(
      `Drive file "${json.name}" reports no byte size — only binary files (videos) are supported, not Google Docs/Sheets/Slides.`
    );
  }
  return {
    id: json.id,
    name: json.name,
    mimeType: json.mimeType,
    size: Number(json.size),
  };
}

/**
 * Stream a byte range of a Drive file as an ArrayBuffer. We deliberately
 * pull a single Range request per call so the upload service can drive
 * progress and retries explicitly.
 */
export async function readDriveRange(
  refreshToken: string,
  fileId: string,
  start: number,
  endInclusive: number
): Promise<ArrayBuffer> {
  const { accessToken } = await getAccessToken(refreshToken);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Range: `bytes=${start}-${endInclusive}`,
      },
    }
  );
  if (res.status !== 206 && res.status !== 200) {
    const text = await res.text();
    throw new Error(`Drive range read ${res.status}: ${text}`);
  }
  return res.arrayBuffer();
}
