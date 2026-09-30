/**
 * federation-probe-store — PG persistence for `harness_shared.federation_probes`
 * (fleet-reliability-verification-2026-07-10 P-010, WI-3812; migration 544).
 *
 * Thin persistence layer over the pure shape/logic in `federation-probe.ts`
 * (mirrors the `results-receipt.ts` shape / `agent-facts/store.ts` persistence
 * split used elsewhere in this package). `insertProbe` is the only write path
 * that can create an accepted row (probe:emit); accepted means only that the
 * stamped declaration was captured locally. Post-capture federation health is
 * observed through the outbox, merge cursor, and remote-origin rows instead.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { InvalidInputError } from '@papercusp/tooldef';
import type { ProbeReceipt, StampedProbe } from './federation-probe';

function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

interface FederationProbeRow {
  probe_key: string;
  workspace_id: string;
  harness_slug: string;
  emitted_by: string;
  emitted_at: string;
  captured_at: string | null;
  status: 'pending' | 'acked' | 'refused' | 'timed_out';
  refusal_reason: string | null;
}

function rowToReceipt(row: FederationProbeRow): ProbeReceipt {
  const hops: ProbeReceipt['hops'] = {};
  const at = (v: string | null): number | undefined => (v ? new Date(v).getTime() : undefined);
  const captured = at(row.captured_at);
  if (captured !== undefined) hops.captured = captured;
  return {
    probeKey: row.probe_key,
    workspaceId: row.workspace_id,
    harnessSlug: row.harness_slug,
    emittedBy: row.emitted_by,
    emittedAtMs: new Date(row.emitted_at).getTime(),
    // Expand/contract bridge (WI-3962): until the captured-only contract
    // migration is armed, historical rows can still carry pending/timed_out.
    // The physical fact is unambiguous: captured_at means accepted local
    // capture; its absence means a refused pre-capture attempt.
    status: captured !== undefined ? 'acked' : 'refused',
    ...(row.refusal_reason ? { refusalReason: row.refusal_reason } : {}),
    hops,
  };
}

/**
 * Persist a stamped probe (probe:emit's success path) with `captured` stamped
 * at insert time — a probe row only ever exists once captured. Throws
 * InvalidInputError on a probe_key collision (should be astronomically rare
 * given buildProbeKey's nonce, but a collision must be a loud caller error,
 * never a silent overwrite of a DIFFERENT probe's receipts).
 */
export async function insertProbe(stamped: StampedProbe, inject?: Sql): Promise<ProbeReceipt> {
  const sql = sqlOf(inject);
  const nowIso = new Date(stamped.emittedAtMs).toISOString();
  let rows: FederationProbeRow[];
  try {
    rows = await sql<FederationProbeRow[]>`
      INSERT INTO harness_shared.federation_probes
        (workspace_id, harness_slug, probe_key, emitted_by, emitted_at, captured_at, status)
      VALUES
        (${stamped.workspaceId}, ${stamped.harnessSlug}, ${stamped.probeKey}, ${stamped.emittedBy},
         ${nowIso}, ${nowIso}, 'acked')
      RETURNING probe_key, workspace_id, harness_slug, emitted_by, emitted_at::text,
                captured_at::text, status, refusal_reason`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate key value.*federation_probes_probe_key/.test(msg)) {
      throw new InvalidInputError(
        `probe:emit — probe_key '${stamped.probeKey}' already exists (collision) — retry (buildProbeKey re-nonces)`,
      );
    }
    throw e;
  }
  return rowToReceipt(rows[0]);
}

/**
 * Persist a REFUSED probe attempt (loud-refusal discipline: a refusal is
 * still recorded, not just returned-and-forgotten, so a pattern of refusals
 * against one harness is visible via probe:get / a future sweep).
 */
export async function insertRefusedProbe(
  args: { workspaceId: string; harnessSlug: string; emittedBy: string; probeKey: string; reason: string; nowMs: number },
  inject?: Sql,
): Promise<void> {
  const sql = sqlOf(inject);
  const nowIso = new Date(args.nowMs).toISOString();
  await sql`
    INSERT INTO harness_shared.federation_probes
      (workspace_id, harness_slug, probe_key, emitted_by, emitted_at, status, refusal_reason)
    VALUES
      (${args.workspaceId}, ${args.harnessSlug}, ${args.probeKey}, ${args.emittedBy}, ${nowIso}, 'refused', ${args.reason})
    ON CONFLICT (probe_key) DO NOTHING`;
}

export async function getProbe(probeKey: string, inject?: Sql): Promise<ProbeReceipt | null> {
  const sql = sqlOf(inject);
  const rows = await sql<FederationProbeRow[]>`
    SELECT probe_key, workspace_id, harness_slug, emitted_by, emitted_at::text,
           captured_at::text, status, refusal_reason
      FROM harness_shared.federation_probes
     WHERE probe_key = ${probeKey}`;
  return rows[0] ? rowToReceipt(rows[0]) : null;
}

export async function listRecentProbes(
  workspaceId: string,
  harnessSlug: string,
  limit = 20,
  inject?: Sql,
): Promise<ProbeReceipt[]> {
  const sql = sqlOf(inject);
  const rows = await sql<FederationProbeRow[]>`
    SELECT probe_key, workspace_id, harness_slug, emitted_by, emitted_at::text,
           captured_at::text, status, refusal_reason
      FROM harness_shared.federation_probes
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
     ORDER BY emitted_at DESC
     LIMIT ${limit}`;
  return rows.map(rowToReceipt);
}
