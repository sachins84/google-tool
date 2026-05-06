import { getDb } from '../db/init.js';

export interface AuditEntry {
  user_id: number | null;
  action: string;
  brand_id: number | null;
  customer_id: string | null;
  target_resource: string | null;
  before_json?: unknown;
  after_json?: unknown;
  dry_run: boolean;
  response_json?: unknown;
}

export function recordAudit(entry: AuditEntry): number {
  const result = getDb()
    .prepare(
      `INSERT INTO audit_log
        (user_id, action, brand_id, customer_id, target_resource, before_json, after_json, dry_run, response_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.user_id,
      entry.action,
      entry.brand_id,
      entry.customer_id,
      entry.target_resource,
      entry.before_json != null ? JSON.stringify(entry.before_json) : null,
      entry.after_json != null ? JSON.stringify(entry.after_json) : null,
      entry.dry_run ? 1 : 0,
      entry.response_json != null ? JSON.stringify(entry.response_json) : null
    );
  return result.lastInsertRowid as number;
}
