import { getDb } from '../../db/init.js';
import { getChannelConfig, markChannelRefreshError } from './channels.js';
import { readAndPrepareSheet, type SheetSchema } from './sheets.js';
import { getDriveFileInfo, parseDriveFileId } from './drive.js';
import { uploadDriveFileToYouTube } from './upload.js';

export interface StartJobInput {
  userId: number | null;
  channelKey: string;
  sheetInput: string;        // URL or ID
  sheetTab?: string;
  privacyStatus?: 'unlisted' | 'private' | 'public';
}

export interface JobSummary {
  id: number;
  channel_key: string;
  channel_label: string | null;
  sheet_id: string;
  sheet_tab: string | null;
  privacy_status: string;
  status: string;
  total_rows: number;
  done_rows: number;
  error_rows: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface JobRow {
  id: number;
  job_id: number;
  sheet_row: number;
  drive_link: string;
  drive_file_id: string | null;
  title: string | null;
  bytes_total: number | null;
  bytes_uploaded: number;
  youtube_video_id: string | null;
  youtube_url: string | null;
  status: string;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

const now = (): number => Math.floor(Date.now() / 1000);

export async function startJob(input: StartJobInput): Promise<JobSummary> {
  const cfg = await getChannelConfig(input.channelKey);
  if (!cfg) throw new Error(`Unknown YouTube channel key: ${input.channelKey}`);

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO youtube_jobs
       (user_id, channel_key, channel_label, sheet_id, sheet_tab, privacy_status, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  );
  const result = insert.run(
    input.userId,
    cfg.key,
    cfg.label,
    input.sheetInput,
    input.sheetTab ?? null,
    input.privacyStatus ?? 'unlisted',
    now()
  );
  const jobId = result.lastInsertRowid as number;

  // Detach: actual upload runs after we return so the caller can immediately
  // start polling for status. Unhandled errors are captured into the job row.
  void runJob(jobId, cfg.refreshToken, input).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    getDb()
      .prepare(`UPDATE youtube_jobs SET status='failed', error=?, finished_at=? WHERE id = ?`)
      .run(msg, now(), jobId);
    // If Google rejected the refresh token, surface it on the YT Channels page
    // so an admin knows to reconnect that channel.
    if (msg.includes('invalid_grant')) markChannelRefreshError(cfg.key, msg);
  });

  return getJob(jobId)!;
}

async function runJob(jobId: number, refreshToken: string, input: StartJobInput): Promise<void> {
  const db = getDb();
  db.prepare(`UPDATE youtube_jobs SET status='running', started_at=? WHERE id = ?`).run(now(), jobId);

  // Phase 1 — read sheet, materialise per-row tasks
  let schema: SheetSchema;
  try {
    schema = await readAndPrepareSheet(refreshToken, input.sheetInput, input.sheetTab);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE youtube_jobs SET status='failed', error=?, finished_at=? WHERE id = ?`)
      .run(msg, now(), jobId);
    return;
  }

  db.prepare(
    `UPDATE youtube_jobs SET sheet_id=?, sheet_tab=?, total_rows=? WHERE id = ?`
  ).run(schema.spreadsheetId, schema.sheetTitle, schema.rows.length, jobId);

  const insertRow = db.prepare(
    `INSERT INTO youtube_job_rows (job_id, sheet_row, drive_link, title, description, tags, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  );
  for (const r of schema.rows) {
    insertRow.run(
      jobId,
      r.sheetRow,
      r.driveLink,
      r.title,
      r.description,
      r.tags.length ? r.tags.join(',') : null
    );
  }

  // Per-row status (queued / done / error) lives in the youtube_job_rows table
  // and the UI renders it from /api/youtube/jobs/:id — we no longer write back
  // to the source sheet (read-only Sheets scope is sufficient now).

  // Phase 2 — upload one row at a time. Sequential is intentional: YouTube
  // upload bandwidth is the bottleneck, parallel uploads usually don't help
  // and increase the chance of 5xx rate-limit responses.
  let done = 0;
  let errors = 0;
  const rowIds = db
    .prepare(`SELECT id, sheet_row, drive_link, title, description, tags FROM youtube_job_rows WHERE job_id = ? ORDER BY sheet_row`)
    .all(jobId) as Array<{
      id: number; sheet_row: number; drive_link: string;
      title: string | null; description: string | null; tags: string | null;
    }>;

  for (const row of rowIds) {
    db.prepare(`UPDATE youtube_job_rows SET status='uploading', started_at=? WHERE id = ?`)
      .run(now(), row.id);
    try {
      const fileId = parseDriveFileId(row.drive_link);
      const info = await getDriveFileInfo(refreshToken, fileId);
      db.prepare(`UPDATE youtube_job_rows SET drive_file_id=?, bytes_total=? WHERE id = ?`)
        .run(fileId, info.size, row.id);

      const finalTitle = (row.title ?? info.name).slice(0, 100);
      const tags = row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];

      const updateProgress = db.prepare(
        `UPDATE youtube_job_rows SET bytes_uploaded=? WHERE id = ?`
      );

      const result = await uploadDriveFileToYouTube({
        refreshToken,
        fileId,
        fileInfo: info,
        title: finalTitle,
        description: row.description ?? '',
        tags,
        privacyStatus: input.privacyStatus ?? 'unlisted',
        onProgress: (n) => updateProgress.run(n, row.id),
      });

      db.prepare(
        `UPDATE youtube_job_rows
         SET status='done', youtube_video_id=?, youtube_url=?, finished_at=?, bytes_uploaded=COALESCE(bytes_total, bytes_uploaded)
         WHERE id = ?`
      ).run(result.videoId, result.url, now(), row.id);
      done++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.prepare(`UPDATE youtube_job_rows SET status='error', error=?, finished_at=? WHERE id = ?`)
        .run(msg, now(), row.id);
      errors++;
    }
    db.prepare(`UPDATE youtube_jobs SET done_rows=?, error_rows=? WHERE id = ?`)
      .run(done, errors, jobId);
  }

  db.prepare(
    `UPDATE youtube_jobs SET status='completed', finished_at=? WHERE id = ?`
  ).run(now(), jobId);
}

export function getJob(id: number): JobSummary | null {
  const row = getDb()
    .prepare(`SELECT * FROM youtube_jobs WHERE id = ?`)
    .get(id) as JobSummary | undefined;
  return row ?? null;
}

export function listJobs(limit = 25): JobSummary[] {
  return getDb()
    .prepare(`SELECT * FROM youtube_jobs ORDER BY id DESC LIMIT ?`)
    .all(limit) as JobSummary[];
}

export function getJobRows(jobId: number): JobRow[] {
  return getDb()
    .prepare(`SELECT * FROM youtube_job_rows WHERE job_id = ? ORDER BY sheet_row`)
    .all(jobId) as JobRow[];
}
