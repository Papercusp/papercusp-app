/**
 * pg-jsonb.ts — defensive decode for a jsonb column READ.
 *
 * A jsonb column written as `${JSON.stringify(x)}::jsonb` (the portable bind —
 * sql.json THROWS on the getOrgPg client, EI-607) reads back as the raw JSON
 * STRING under the testcontainer pool (and any prepare:false client that does not
 * auto-decode jsonb), whereas the prod getOrgPg/CJS client auto-parses it to an
 * object/array. So any reader that uses a jsonb value as an object/array MUST
 * decode defensively to work across both clients. Mirrors experiment/ledger.ts
 * `coerceJsonArray`, slot-parked-store `parseEnvelope`, and pg-log `parseBody`.
 *
 * Runbook: agent-insight `sql-json-throws-on-getorgpg-client`.
 */
export function coerceJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}
