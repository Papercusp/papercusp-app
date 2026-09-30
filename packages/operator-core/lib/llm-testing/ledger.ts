/**
 * Claim ledger for parallel llm-test runners.
 *
 * Plan §0 / handoff §D item 3. Coordinates parallel runners so two
 * processes don't double-spend on the same (scenario × identity ×
 * matrix_index) tuple.
 *
 * Semantics:
 *   - `tryClaim()` inserts a row with a TTL. If the natural key is
 *     already held, returns { ok: false, holder }.
 *   - `heartbeat()` extends an existing claim's expires_at. Caller
 *     should heartbeat at least every TTL/2.
 *   - `release()` deletes the claim. Must be called from a finally
 *     block; if the process crashes, the TTL expires and the next
 *     `tryClaim()` reaps the row first.
 *   - `reapExpired()` removes claims whose expires_at < now(). Called
 *     opportunistically at acquire time.
 *
 * Schema lives in libs/papercusp/libs/db/sql/074-llm-test-claims.sql.
 */

import { hostname } from 'node:os';

import { getLongLivedAdminPool } from '../long-lived-admin-pool';

// Transactional pool — re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264). Shared connection options + idle policy come with it.
const db = () => getLongLivedAdminPool('llm-testing-ledger', { max: 2, prepare: false });

const DEFAULT_TTL_SEC = 600; // 10 min — covers a slow 6-turn scenario

/** Stable default owner id when callers don't pass one. */
export function defaultOwnerId(): string {
  return `${hostname()}:${process.pid}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the pid exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * EI-281: a crashed runner's claim otherwise blocks its scenario for the full
 * TTL (the gate's runner-aggregate su-S11 attempt sat behind a 10-min stale
 * claim from a dead pid). Owner ids are `${hostname()}:${pid}` (the ledger
 * default) or `${hostname()}:${pid}/${runId8}` (the testing-shell runner) — when
 * the holder is on THIS host and its pid is gone, the claim is reapable now
 * rather than at expiry (the same liveness probe the lock store uses). A
 * custom owner id without the host:pid shape, or a holder on another host,
 * is never treated as dead.
 *
 * The pid segment may carry a trailing `/<runId8>` (the runner's owner id) — we
 * strip it before parsing the pid. Without this strip, `Number('<pid>/<runId>')`
 * is NaN, so the runner's claims were NEVER reapable and a killed run (timeout /
 * rate-limit exhaustion) stranded its scenario for the full TTL (observed
 * 2026-06-21 while iterating on the SU-S13/S14 code:run behavior gates).
 */
export function holderIsDeadLocalPid(
  ownerId: string,
  host: string = hostname(),
  isAlive: (pid: number) => boolean = pidAlive,
): boolean {
  const idx = ownerId.lastIndexOf(':');
  if (idx <= 0) return false;
  const ownerHost = ownerId.slice(0, idx);
  // The pid segment is everything after the last ':' up to an optional '/<runId>'.
  const pid = Number(ownerId.slice(idx + 1).split('/')[0]);
  if (ownerHost !== host || !Number.isInteger(pid) || pid <= 0) return false;
  return !isAlive(pid);
}

export interface ClaimKeyInput {
  scenarioId: string;
  identityHash: string;
  matrixIndex?: number;
}

export function buildClaimKey(input: ClaimKeyInput): string {
  return `${input.scenarioId}@${input.identityHash.slice(0, 16)}#${input.matrixIndex ?? 0}`;
}

export interface ClaimHolder {
  ownerId: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export type ClaimResult =
  | { ok: true; claimKey: string; ownerId: string; expiresAt: Date }
  | { ok: false; reason: 'busy'; holder: ClaimHolder };

export interface TryClaimOpts extends ClaimKeyInput {
  ownerId?: string;
  ttlSec?: number;
  metadata?: Record<string, unknown>;
}

export async function tryClaim(opts: TryClaimOpts): Promise<ClaimResult> {
  const sql = db();
  const ownerId = opts.ownerId ?? defaultOwnerId();
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const claimKey = buildClaimKey(opts);
  const expiresAt = new Date(Date.now() + ttlSec * 1000);

  // Reap any expired holders first so we don't block on a dead claim.
  await sql`DELETE FROM harness_shared.llm_test_claims WHERE expires_at < now()`;

  // INSERT ... ON CONFLICT DO NOTHING returns 0 rows when a holder
  // already exists. We RETURNING the row we wanted to learn whether it
  // was actually inserted vs. existing.
  const rows = await sql<Array<{ owner_id: string; acquired_at: Date; expires_at: Date }>>`
    INSERT INTO harness_shared.llm_test_claims
      (claim_key, owner_id, scenario_id, identity_hash, matrix_index, expires_at, metadata_json)
    VALUES
      (${claimKey}, ${ownerId}, ${opts.scenarioId}, ${opts.identityHash},
       ${opts.matrixIndex ?? null}, ${expiresAt}, ${sql.json(opts.metadata ?? {})})
    ON CONFLICT (claim_key) DO NOTHING
    RETURNING owner_id, acquired_at, expires_at
  `;

  if (rows.length > 0) {
    return { ok: true, claimKey, ownerId, expiresAt };
  }

  // Conflict — fetch holder for the error envelope.
  const holders = await sql<Array<{ owner_id: string; acquired_at: Date; expires_at: Date }>>`
    SELECT owner_id, acquired_at, expires_at
    FROM harness_shared.llm_test_claims
    WHERE claim_key = ${claimKey}
  `;
  const holder = holders[0];
  if (!holder) {
    // Race: holder expired between our reap and our select. One retry.
    return tryClaim(opts);
  }
  if (holderIsDeadLocalPid(holder.owner_id)) {
    // Crashed local runner (EI-281) — reap its claim and retry instead of
    // reporting busy until the TTL lapses.
    await sql`
      DELETE FROM harness_shared.llm_test_claims
       WHERE claim_key = ${claimKey}
         AND owner_id = ${holder.owner_id}
    `;
    return tryClaim(opts);
  }
  return {
    ok: false,
    reason: 'busy',
    holder: {
      ownerId: holder.owner_id,
      acquiredAt: holder.acquired_at,
      expiresAt: holder.expires_at,
    },
  };
}

export async function heartbeat(claimKey: string, ownerId: string, ttlSec = DEFAULT_TTL_SEC): Promise<boolean> {
  const sql = db();
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const rows = await sql<Array<{ claim_key: string }>>`
    UPDATE harness_shared.llm_test_claims
       SET expires_at = ${expiresAt}
     WHERE claim_key = ${claimKey}
       AND owner_id = ${ownerId}
    RETURNING claim_key
  `;
  return rows.length > 0;
}

export async function release(claimKey: string, ownerId: string): Promise<void> {
  const sql = db();
  await sql`
    DELETE FROM harness_shared.llm_test_claims
     WHERE claim_key = ${claimKey}
       AND owner_id = ${ownerId}
  `;
}

/** Manual reap entry point — usually not needed; tryClaim reaps inline. */
export async function reapExpired(): Promise<number> {
  const sql = db();
  const rows = await sql<Array<{ claim_key: string }>>`
    DELETE FROM harness_shared.llm_test_claims
     WHERE expires_at < now()
    RETURNING claim_key
  `;
  return rows.length;
}
