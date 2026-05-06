import { useState } from 'react';
import { Header, type DashState, type View } from '../components/Header';
import { Performance } from './Performance';
import { Settings } from './Settings';
import { Audit } from './Audit';

interface Props {
  username: string;
  onLogout: () => void;
}

export function Dashboard({ username, onLogout }: Props) {
  const [view, setView] = useState<View>('performance');
  const [state, setState] = useState<DashState>({
    brandId: null,
    from: '',
    to: '',
  });

  return (
    <div className="min-h-full">
      <Header
        username={username}
        view={view}
        state={state}
        onState={setState}
        onView={setView}
        onLogout={onLogout}
      />

      <main className="max-w-7xl mx-auto px-4 py-6">
        {view === 'settings' ? (
          <Settings />
        ) : view === 'audit' ? (
          <Audit />
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
