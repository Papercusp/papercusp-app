/**
 * Normalize a jsonb projection input that may have arrived already-stringified.
 *
 * Projections bind jsonb as `${JSON.stringify(x)}::jsonb` because the operator
 * runtime client (getOrgPg) THROWS on `sql.json()` / bare-object jsonb params
 * (see agent-insights/postgres-js-jsonb-binding). In that runtime, jsonb columns
 * round-trip as objects, so a federated row's jsonb field is already an object
 * and this is a no-op.
 *
 * But a peer that wrote the same field under a *different* postgres-js client —
 * one that double-encodes `${JSON.stringify}::jsonb` into a jsonb STRING — will
 * capture that string into its CDC outbox and federate it here as a string.
 * Writing that string back through `JSON.stringify(...)::jsonb` would add another
 * encoding layer every hop, so the row is never `IS DISTINCT FROM`-stable and the
 * outbox never reaches a fixed point. Parsing the string back to its value makes
 * the projection write canonical and the round-trip converge under any client.
 */
export function normalizeJsonbInput(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v; // not JSON — leave it for the column to accept/reject as-is
  }
}
