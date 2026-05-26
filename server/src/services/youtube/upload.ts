import { getAccessToken } from './auth.js';
import { readDriveRange, type DriveFileInfo } from './drive.js';

// 8 MiB. Must be a multiple of 256 KiB per the resumable protocol.
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 6;

export interface UploadOptions {
  refreshToken: string;
  fileId: string;
  fileInfo: DriveFileInfo;
  title: string;
  description?: string;
  tags?: string[];
  privacyStatus?: 'unlisted' | 'private' | 'public';
  categoryId?: string;
  onProgress?: (bytesUploaded: number) => void;
}

export interface UploadResult {
  videoId: string;
  url: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function initResumableSession(opts: UploadOptions): Promise<string> {
  const { accessToken } = await getAccessToken(opts.refreshToken);
  const body = {
    snippet: {
      title: opts.title.slice(0, 100), // YT title max 100 chars
      description: (opts.description ?? '').slice(0, 5000),
      tags: opts.tags ?? [],
      categoryId: opts.categoryId ?? '22', // People & Blogs (safe default)
    },
    status: {
      privacyStatus: opts.privacyStatus ?? 'unlisted',
      selfDeclaredMadeForKids: false,
      embeddable: true,
    },
  };

  const res = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': opts.fileInfo.mimeType || 'video/*',
        'X-Upload-Content-Length': String(opts.fileInfo.size),
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube resumable init ${res.status}: ${text}`);
  }
  const location = res.headers.get('location');
  if (!location) throw new Error('YouTube resumable init returned no Location header');
  return location;
}

/**
 * Query the server for current upload progress. Returns the next byte
 * the server expects (or null if upload already finished — body returned
 * contains the resource).
 */
async function checkUploadProgress(
  sessionUri: string,
  totalSize: number
): Promise<{ nextByte: number; finishedResource: { id?: string } | null }> {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: {
      'Content-Length': '0',
      'Content-Range': `bytes */${totalSize}`,
    },
  });
  if (res.status === 200 || res.status === 201) {
    return { nextByte: totalSize, finishedResource: await res.json() };
  }
  if (res.status === 308) {
    const range = res.headers.get('range');
    if (!range) return { nextByte: 0, finishedResource: null };
    const m = range.match(/bytes=0-(\d+)/);
    return { nextByte: m && m[1] ? Number(m[1]) + 1 : 0, finishedResource: null };
  }
  const text = await res.text();
  throw new Error(`progress check ${res.status}: ${text}`);
}

async function uploadChunk(
  sessionUri: string,
  chunk: ArrayBuffer,
  start: number,
  end: number,
  total: number
): Promise<{ done: boolean; resource: { id?: string } | null; nextByte: number }> {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: {
      'Content-Length': String(chunk.byteLength),
      'Content-Range': `bytes ${start}-${end}/${total}`,
    },
    body: chunk,
  });
  if (res.status === 200 || res.status === 201) {
    return { done: true, resource: await res.json(), nextByte: total };
  }
  if (res.status === 308) {
    const range = res.headers.get('range');
    const m = range?.match(/bytes=0-(\d+)/);
    return {
      done: false,
      resource: null,
      nextByte: m && m[1] ? Number(m[1]) + 1 : end + 1,
    };
  }
  const text = await res.text().catch(() => '');
  // 5xx + 429 → retryable upstream
  const err = new Error(`chunk PUT ${res.status}: ${text}`) as Error & { retryable?: boolean };
  err.retryable = res.status >= 500 || res.status === 429;
  throw err;
}

export async function uploadDriveFileToYouTube(opts: UploadOptions): Promise<UploadResult> {
  const total = opts.fileInfo.size;
  const sessionUri = await initResumableSession(opts);

  let cursor = 0;
  let resource: { id?: string } | null = null;

  while (cursor < total) {
    const end = Math.min(cursor + CHUNK_SIZE, total) - 1;
    const data = await readDriveRange(opts.refreshToken, opts.fileId, cursor, end);

    let attempt = 0;
    while (true) {
      try {
        const r = await uploadChunk(sessionUri, data, cursor, end, total);
        if (r.done && r.resource) {
          resource = r.resource;
          cursor = total;
          opts.onProgress?.(cursor);
          break;
        }
        cursor = r.nextByte;
        opts.onProgress?.(cursor);
        break;
      } catch (err) {
        attempt++;
        const retryable = err instanceof Error && (err as Error & { retryable?: boolean }).retryable;
        const networkErr = err instanceof Error && /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(err.message);
        if (attempt >= MAX_CHUNK_RETRIES || (!retryable && !networkErr)) throw err;
        const backoff = Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        await sleep(backoff);
        // Re-sync with server in case it accepted partial bytes
        try {
          const p = await checkUploadProgress(sessionUri, total);
          if (p.finishedResource) {
            resource = p.finishedResource;
            cursor = total;
            opts.onProgress?.(cursor);
            break;
          }
          if (p.nextByte > cursor) {
            cursor = p.nextByte;
            opts.onProgress?.(cursor);
            break; // chunk already accepted; move on
          }
        } catch {
          // fall through to retry the same chunk
        }
      }
    }
  }

  if (!resource?.id) {
    // Final cross-check
    const p = await checkUploadProgress(sessionUri, total);
    if (!p.finishedResource?.id) {
      throw new Error('YouTube upload completed without returning a video ID');
    }
    resource = p.finishedResource;
  }

  return { videoId: resource.id!, url: `https://www.youtube.com/watch?v=${resource.id}` };
}
