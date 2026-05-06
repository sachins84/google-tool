import { getDb } from '../db/init.js';

export interface BrandWithAccounts {
  id: number;
  name: string;
  rto_factor: number;
  rto_mode: string;
  accounts: Array<{ customer_id: string; customer_name: string | null }>;
}

export function getBrand(id: number): BrandWithAccounts | null {
  const db = getDb();
  const brand = db
    .prepare('SELECT id, name, rto_factor, rto_mode FROM brands WHERE id = ?')
    .get(id) as { id: number; name: string; rto_factor: number; rto_mode: string } | undefined;
  if (!brand) return null;
  const accounts = db
    .prepare('SELECT customer_id, customer_name FROM brand_accounts WHERE brand_id = ?')
    .all(id) as Array<{ customer_id: string; customer_name: string | null }>;
  return { ...brand, accounts };
}
