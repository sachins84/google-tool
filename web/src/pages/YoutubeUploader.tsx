import { useEffect, useRef, useState } from 'react';
import { api, type YoutubeChannel, type YoutubeJob, type YoutubeJobRow } from '../lib/api';

type Privacy = 'unlisted' | 'private' | 'public';

function fmtBytes(n: number | null | undefined): string {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function rowPct(row: YoutubeJobRow): number {
  if (!row.bytes_total) return row.status === 'done' ? 100 : 0;
  return Math.min(100, Math.round((row.bytes_uploaded / row.bytes_total) * 100));
}

export function YoutubeUploader() {
  const [channels, setChannels] = useState<YoutubeChannel[]>([]);
  const [channelKey, setChannelKey] = useState<string>('');
  const [sheet, setSheet] = useState('');
  const [tab, setTab] = useState('');
  const [privacy, setPrivacy] = useState<Privacy>('unlisted');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobs, setJobs] = useState<YoutubeJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [job, setJob] = useState<YoutubeJob | null>(null);
  const [rows, setRows] = useState<YoutubeJobRow[]>([]);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.ytChannels();
        setChannels(res.channels);
        if (res.channels[0]) setChannelKey(res.channels[0].key);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    void refreshJobs();
  }, []);

  async function refreshJobs(): Promise<void> {
    try {
      const res = await api.ytJobs();
      setJobs(res.jobs);
    } catch { /* ignore */ }
  }

  // Poll selected job + its rows every 2s while it's running.
  useEffect(() => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    if (selectedJobId == null) return;

    const tick = async (): Promise<void> => {
      try {
        const res = await api.ytJob(selectedJobId);
        setJob(res.job);
        setRows(res.rows);
        if (res.job.status === 'completed' || res.job.status === 'failed') {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          void refreshJobs();
        }
      } catch { /* ignore transient */ }
    };
    void tick();
    pollRef.current = window.setInterval(() => { void tick(); }, 2000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [selectedJobId]);

  async function start(): Promise<void> {
    setError(null);
    if (!channelKey) return setError('Pick a channel');
    if (!sheet.trim()) return setError('Paste a Google Sheet URL or ID');
    setStarting(true);
    try {
      const res = await api.ytUploadStart({
        channel_key: channelKey,
        sheet: sheet.trim(),
        sheet_tab: tab.trim() || undefined,
        privacy_status: privacy,
      });
      setSelectedJobId(res.job.id);
      void refreshJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="bg-white rounded border p-4 space-y-3">
        <h2 className="font-semibold">New upload job</h2>

        {!channels.length && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
            No YouTube channels connected yet. Open the{' '}
            <strong>YT Channels</strong> tab to connect one via Google OAuth.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-sm">
            <div className="text-gray-600 mb-1">YouTube channel</div>
            <select
              value={channelKey}
              onChange={(e) => setChannelKey(e.target.value)}
              className="border rounded px-2 py-1.5 w-full"
            >
              {!channels.length && <option value="">No channels</option>}
              {channels.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.title ?? c.label}
                  {c.brandName ? ` — ${c.brandName}` : ''}
                  {c.source === 'env' ? ' (env)' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <div className="text-gray-600 mb-1">Privacy</div>
            <select
              value={privacy}
              onChange={(e) => setPrivacy(e.target.value as Privacy)}
              className="border rounded px-2 py-1.5 w-full"
            >
              <option value="unlisted">Unlisted (ads-ready)</option>
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </label>

          <label className="text-sm md:col-span-2">
            <div className="text-gray-600 mb-1">Google Sheet URL or ID</div>
            <input
              value={sheet}
              onChange={(e) => setSheet(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              className="border rounded px-2 py-1.5 w-full"
            />
          </label>

          <label className="text-sm">
            <div className="text-gray-600 mb-1">
              Tab name <span className="text-gray-400">(blank = first tab)</span>
            </div>
            <input
              value={tab}
              onChange={(e) => setTab(e.target.value)}
              placeholder="Sheet1"
              className="border rounded px-2 py-1.5 w-full"
            />
          </label>
        </div>

        <div className="text-xs text-gray-500">
          The tool auto-detects the Drive-link column. Optional headers (case-insensitive):
          <code className="mx-1 bg-gray-100 px-1 rounded">Title</code>
          <code className="mx-1 bg-gray-100 px-1 rounded">Description</code>
          <code className="mx-1 bg-gray-100 px-1 rounded">Tags</code> (comma-separated).
          A <code className="bg-gray-100 px-1 rounded">YouTube URL</code> and{' '}
          <code className="bg-gray-100 px-1 rounded">Status</code> column are appended automatically.
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void start()}
            disabled={starting || !channels.length}
            className="bg-black text-white text-sm px-4 py-1.5 rounded disabled:opacity-50"
          >
            {starting ? 'Starting…' : 'Start upload'}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-[260px,1fr] gap-4">
        <div className="bg-white rounded border">
          <div className="px-3 py-2 border-b text-sm font-semibold">Recent jobs</div>
          <ul className="divide-y text-sm max-h-[600px] overflow-auto">
            {!jobs.length && <li className="px-3 py-4 text-gray-500 text-xs">No jobs yet</li>}
            {jobs.map((j) => (
              <li key={j.id}>
                <button
                  onClick={() => setSelectedJobId(j.id)}
                  className={`w-full text-left px-3 py-2 hover:bg-gray-50 ${
                    selectedJobId === j.id ? 'bg-gray-50' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">#{j.id}</span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        j.status === 'completed'
                          ? 'bg-green-100 text-green-800'
                          : j.status === 'failed'
                          ? 'bg-red-100 text-red-800'
                          : j.status === 'running'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {j.status}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {j.channel_label ?? j.channel_key} · {j.done_rows}/{j.total_rows} done
                    {j.error_rows ? `, ${j.error_rows} err` : ''}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-white rounded border min-h-[200px]">
          {!job ? (
            <div className="p-6 text-sm text-gray-500">Select a job to see per-row progress.</div>
          ) : (
            <div>
              <div className="px-4 py-3 border-b flex items-center justify-between">
                <div>
                  <div className="font-semibold text-sm">Job #{job.id} — {job.status}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {job.channel_label ?? job.channel_key} · {job.privacy_status} ·{' '}
                    <a
                      href={`https://docs.google.com/spreadsheets/d/${job.sheet_id}/edit`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline text-blue-700"
                    >
                      sheet
                    </a>
                    {job.sheet_tab ? ` / ${job.sheet_tab}` : ''}
                  </div>
                  {job.error && (
                    <div className="text-xs text-red-700 mt-1">{job.error}</div>
                  )}
                </div>
                <div className="text-xs text-gray-600">
                  {job.done_rows} / {job.total_rows} done
                  {job.error_rows ? ` · ${job.error_rows} errors` : ''}
                </div>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-3 py-2">Row</th>
                    <th className="text-left px-3 py-2">Title / Drive link</th>
                    <th className="text-left px-3 py-2">Size</th>
                    <th className="text-left px-3 py-2 w-40">Progress</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-left px-3 py-2">YouTube</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => {
                    const pct = rowPct(r);
                    return (
                      <tr key={r.id}>
                        <td className="px-3 py-2 text-gray-500">{r.sheet_row}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.title ?? '—'}</div>
                          <a
                            href={r.drive_link}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-700 hover:underline break-all"
                          >
                            {r.drive_link}
                          </a>
                          {r.error && <div className="text-red-700 mt-0.5">{r.error}</div>}
                        </td>
                        <td className="px-3 py-2">{fmtBytes(r.bytes_total)}</td>
                        <td className="px-3 py-2">
                          <div className="w-32 h-2 bg-gray-200 rounded overflow-hidden">
                            <div
                              className={`h-full ${
                                r.status === 'error'
                                  ? 'bg-red-500'
                                  : r.status === 'done'
                                  ? 'bg-green-500'
                                  : 'bg-blue-500'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <div className="text-[10px] text-gray-500 mt-0.5">{pct}%</div>
                        </td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2">
                          {r.youtube_url ? (
                            <a
                              href={r.youtube_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-700 hover:underline"
                            >
                              open
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length && (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                        Waiting for first row…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
