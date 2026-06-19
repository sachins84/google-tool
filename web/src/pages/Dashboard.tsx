import { useCallback, useEffect, useState } from 'react';
import { Header, type DashState, type View } from '../components/Header';
import { Performance } from './Performance';
import { Settings } from './Settings';
import { Audit } from './Audit';
import { Insights } from './Insights';
import { Daily } from './Daily';
import { Actions } from './Actions';
import { YoutubeUploader } from './YoutubeUploader';
import { YoutubeAuth } from './YoutubeAuth';
import { api } from '../lib/api';

interface Props {
  username: string;
  onLogout: () => void;
}

function initialView(): View {
  if (typeof window === 'undefined') return 'performance';
  const u = new URL(window.location.href);
  if (u.searchParams.has('yt_auth_connected') || u.searchParams.has('yt_auth_error')) {
    return 'youtube_auth';
  }
  return 'performance';
}

export function Dashboard({ username, onLogout }: Props) {
  const [view, setView] = useState<View>(initialView);
  const [state, setState] = useState<DashState>({
    brandId: null,
    from: '',
    to: '',
  });
  const [brands, setBrands] = useState<Array<{ id: number; name: string }>>([]);

  // Brands list is owned here so Settings can refresh it after CRUD and the
  // Header dropdown stays in sync without a page reload.
  const refreshBrands = useCallback(async () => {
    try {
      const res = await api.brandsList();
      const list = res.brands.map((b) => ({ id: b.id, name: b.name }));
      setBrands(list);
      // If currently-selected brand was deleted, fall back to first available.
      setState((s) => {
        if (s.brandId != null && !list.some((b) => b.id === s.brandId)) {
          return { ...s, brandId: list[0]?.id ?? null };
        }
        return s;
      });
    } catch {
      /* ignore — Header will retry on next mount */
    }
  }, []);

  useEffect(() => { void refreshBrands(); }, [refreshBrands]);

  return (
    <div className="min-h-full">
      <Header
        username={username}
        view={view}
        state={state}
        brands={brands}
        onState={setState}
        onView={setView}
        onLogout={onLogout}
      />

      <main className="max-w-7xl mx-auto px-4 py-6">
        {view === 'settings' ? (
          <Settings onBrandsChanged={refreshBrands} />
        ) : view === 'audit' ? (
          <Audit />
        ) : view === 'youtube' ? (
          <YoutubeUploader />
        ) : view === 'youtube_auth' ? (
          <YoutubeAuth />
        ) : view === 'actions' ? (
          state.brandId ? (
            <Actions
              brandId={state.brandId}
              brandName={brands.find((b) => b.id === state.brandId)?.name ?? ''}
            />
          ) : (
            <div className="text-sm text-gray-500 py-8 text-center">Select a brand above.</div>
          )
        ) : view === 'daily' ? (
          state.brandId && state.from && state.to ? (
            <Daily
              brandId={state.brandId}
              brandName={brands.find((b) => b.id === state.brandId)?.name ?? ''}
              from={state.from}
              to={state.to}
            />
          ) : (
            <div className="text-sm text-gray-500 py-8 text-center">Select a brand and date range above.</div>
          )
        ) : view === 'insights' ? (
          state.brandId && state.from && state.to ? (
            <Insights
              brandId={state.brandId}
              brandName={brands.find((b) => b.id === state.brandId)?.name ?? ''}
              from={state.from}
              to={state.to}
              compareFrom={state.compareFrom}
              compareTo={state.compareTo}
            />
          ) : (
            <div className="text-sm text-gray-500 py-8 text-center">Select a brand and date range above.</div>
          )
        ) : state.brandId && state.from && state.to ? (
          <Performance
            brandId={state.brandId}
            from={state.from}
            to={state.to}
            compareFrom={state.compareFrom}
            compareTo={state.compareTo}
          />
        ) : (
          <div className="text-sm text-gray-500 py-8 text-center">Select a brand and date range above.</div>
        )}
      </main>
    </div>
  );
}
