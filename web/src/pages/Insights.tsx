import { useEffect, useState, type FormEvent } from 'react';
import { api, type DailyInsight, type PerfRow } from '../lib/api';

interface Props {
  brandId: number;
  brandName: string;
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
}

interface ChatTurn { role: 'user' | 'assistant'; content: string; }

export function Insights({ brandId, brandName, from, to, compareFrom, compareTo }: Props) {
  const [rows, setRows] = useState<PerfRow[]>([]);
  const [brandTotals, setBrandTotals] = useState<{ ncs: number; amount: number } | undefined>(undefined);
  const [insights, setInsights] = useState<DailyInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [asking, setAsking] = useState(false);

  // Load campaigns + compute insights whenever brand/date changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.perf('campaigns', { brand_id: brandId, from, to, compare_from: compareFrom, compare_to: compareTo })
      .then(async (res) => {
        if (cancelled) return;
        setRows(res.rows);
        setBrandTotals(res.brand_redshift_totals?.primary);
        const d = await api.insightsDaily(
          { brand_id: brandId, from, to, compare_from: compareFrom, compare_to: compareTo },
          res.rows
        );
        if (!cancelled) setInsights(d.insights);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, from, to, compareFrom, compareTo]);

  async function handleAsk(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;

    setQuestion('');
    setAsking(true);
    setChat((c) => [...c, { role: 'user', content: q }]);
    try {
      const res = await api.insightsAsk(
        { brand_id: brandId, from, to },
        { question: q, rows, brand_totals: brandTotals }
      );
      setChat((c) => [...c, { role: 'assistant', content: res.answer }]);
    } catch (err) {
      setChat((c) => [...c, { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setAsking(false);
    }
  }

  const SUGGESTED = [
    'Which campaigns dropped most in Calc ROAS?',
    'Where should I cut spend?',
    'Which campaigns are scaling efficiently?',
    'What changed most vs the previous period?',
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Insights — {brandName}</h2>
        <p className="text-sm text-gray-500">{from} → {to} (vs prev period)</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">{error}</div>}

      <section className="space-y-2">
        <h3 className="font-medium">Today's top observations</h3>
        {loading ? (
          <div className="text-sm text-gray-500">Computing…</div>
        ) : insights.length === 0 ? (
          <div className="bg-white rounded shadow border p-4 text-sm text-gray-500">
            No notable movements in this period — performance looks stable.
          </div>
        ) : (
          <ul className="space-y-2">
            {insights.map((i, idx) => (
              <li key={idx} className={`bg-white rounded shadow border-l-4 ${
                i.severity === 'high' ? 'border-l-red-500'
                : i.severity === 'medium' ? 'border-l-amber-500'
                : 'border-l-emerald-500'
              } px-4 py-2 text-sm`}>
                <div className="flex items-start gap-2">
                  <span className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${
                    i.severity === 'high' ? 'bg-red-100 text-red-800'
                    : i.severity === 'medium' ? 'bg-amber-100 text-amber-800'
                    : 'bg-emerald-100 text-emerald-800'
                  }`}>{i.severity}</span>
                  <span className="text-gray-800">{i.message}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="font-medium">Ask a question</h3>

        {chat.length === 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {SUGGESTED.map((s) => (
              <button
                key={s}
                onClick={() => setQuestion(s)}
                disabled={asking}
                className="text-xs bg-gray-100 hover:bg-gray-200 px-3 py-1 rounded text-gray-700"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-3">
          {chat.map((t, idx) => (
            <div
              key={idx}
              className={`rounded p-3 text-sm whitespace-pre-wrap ${
                t.role === 'user' ? 'bg-gray-100 text-gray-800' : 'bg-white border shadow-sm text-gray-900'
              }`}
            >
              <div className="text-[10px] uppercase text-gray-500 mb-1">{t.role}</div>
              {t.content}
            </div>
          ))}
          {asking && (
            <div className="rounded p-3 text-sm bg-white border shadow-sm text-gray-500">
              <div className="text-[10px] uppercase text-gray-400 mb-1">assistant</div>
              Thinking…
            </div>
          )}
        </div>

        <form onSubmit={handleAsk} className="flex gap-2">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about campaign performance, ROAS, NCs, what to scale or pause…"
            className="flex-1 border rounded px-3 py-2 text-sm"
            disabled={asking}
          />
          <button
            type="submit"
            disabled={asking || !question.trim() || loading}
            className="bg-black text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-40"
          >
            Ask
          </button>
        </form>
        <p className="text-xs text-gray-500">
          Powered by Claude. Answers are based on the campaigns + Calc ROAS shown for the selected brand and date range.
        </p>
      </section>
    </div>
  );
}
