import { useEffect, useState } from 'react';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { api } from './lib/api';

interface User {
  id: number;
  username: string;
  role: string;
}

export function App(): JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  async function refresh(): Promise<void> {
    try {
      const res = await api.me();
      setUser(res.user);
    } catch {
      setUser(null);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (checking) {
    return <div className="min-h-full flex items-center justify-center text-sm text-gray-500">Loading…</div>;
  }

  if (!user) {
    return <Login onLogin={() => void refresh()} />;
  }

  return <Dashboard username={user.username} onLogout={() => setUser(null)} />;
}
