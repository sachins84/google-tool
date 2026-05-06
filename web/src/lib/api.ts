export interface ApiError {
  error: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as ApiError;
      if (body.error) message = body.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => request<{ user: { id: number; username: string; role: string } }>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: { id: number; username: string; role: string } }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  accountsAccessible: () =>
    request<{
      accounts: Array<{
        customer_id: string;
        descriptive_name: string | null;
        currency_code: string | null;
        time_zone: string | null;
        is_manager: boolean;
      }>;
    }>('/api/accounts/accessible'),

  brandsList: () =>
    request<{
      brands: Array<{
        id: number;
        name: string;
        rto_factor: number;
        rto_mode: string;
        accounts: Array<{ customer_id: string; customer_name: string | null }>;
      }>;
    }>('/api/brands'),
};
