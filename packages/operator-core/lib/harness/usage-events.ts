/**
 * P-070 — contributor_usage_events runtime (PG-ledger core).
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-070 (v5
 * addendum 3, D-027). The append-only activity ledger that backs every tier-C
 * contributor stat (§9.0 Insights People, §9.2 Contributors, §18 User profile,
 * card avatars). Per §7.1: never store mutable counters on `contributors` —
 * rollups derive on read from this ledger.
 *
 * Contract: `contributor-usage-event-types.ts` (the live, DDL-matching module —
 * ULID `event_id`, the 8-kind enum, `UsageRollupForContributor`). (A divergent
 * `lib/sync/usage-events-types.ts` duplicate with a different id format + kind
 * enum was deleted 2026-06-02 — this is the single contract.)
 *
 * Scope of THIS module (the unblocked, model-independent core):
 *   - `makeUsageEventId` — ULID-shaped, time-sortable, matches `isUsageEventId`.
 *   - `emitUsageEvent` — writes ONE event to PG, idempotent on the
 *     `(harness_slug, event_id)` PK (P-070a/P-070d). The INSERT mirrors the
 *     receive-side projection (`projections/usage.ts`) byte-for-byte so a local
 *     emit and a replicated remote op land identically.
 *   - `rollupForContributor` — read-time GROUP-BY aggregate (P-070b), using the
 *     `(harness_slug, github_user_id, ts DESC)` index.
 *
 * Deferred (each entangled with the paused gate/substrate arc, tracked in the
 * Phase-5a plan):
 *   - Cross-peer propagation (P-070c): append the event as a Hyperbee `usage`
 *     op so peers' projection mirrors it. This rides the model-A substrate
 *     write path that the deferred model-B rewrite reshapes — wire it once the
 *     substrate write-model settles. Until then the ledger is PG-canonical +
 *     populated locally; remote peers' events still arrive via their projection.
 *   - `device_pubkey` auto-resolution from the local device identity (the OS
 *     keychain / autobase writer key) — an identity-layer dependency; for now
 *     the caller supplies it.
 *   - Emitter wiring (feature CRUD / PR daemon / plan + decision writes / agent
 *     run completion) — incremental, per-surface; this runtime is the unblock.
 */
import { randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  USAGE_EVENT_SCHEMA_VERSION,
  USAGE_EVENT_ID_LENGTH,
  USAGE_EVENT_KINDS,
  type UsageEventKind,
  type UsageEventPayloadByKind,
  type UsageRollupForContributor,
  emptyRollup,
} from './contributor-usage-event-types';
import { resolveWorkspaceForHarness } from './workspace-for-harness';

// ── ULID event-id generator ────────────────────────────────────────────────
// 26 Crockford base32 chars (no I/L/O/U): 10 chars of 48-bit ms timestamp
// (lex-sortable by time) + 16 chars of randomness. Matches `isUsageEventId`.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TS_CHARS = 10;
const RAND_CHARS = USAGE_EVENT_ID_LENGTH - TS_CHARS; // 16

/** Generate a ULID-shaped usage-event id. Injectable clock + randomness for
 *  deterministic tests; defaults to Date.now + node:crypto randomBytes. */
export function makeUsageEventId(
  nowMs: number = Date.now(),
  rand: (n: number) => Uint8Array = randomBytes,
): string {
  let ts = Math.floor(nowMs);
  let out = '';
  for (let i = 0; i < TS_CHARS; i++) {
    out = CROCKFORD[ts % 32] + out;
    ts = Math.floor(ts / 32);
  }
  const bytes = rand(RAND_CHARS);
  for (let i = 0; i < RAND_CHARS; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

export interface EmitUsageEventInput {
  harness_slug: string;
  github_user_id: number;
  /** The emitting device's public key. Caller-supplied until the identity-layer
   *  resolver lands (see module header). */
  device_pubkey: string;
  kind: UsageEventKind;
  ref_id?: string | null;
  payload?: UsageEventPayloadByKind[UsageEventKind] | null;
}

export interface EmitDeps {
  sql?: Sql;
  nowMs?: number;
  /** Override the generated event_id (e.g. to re-emit the same logical event
   *  idempotently — the PK ON CONFLICT makes the re-emit a no-op). */
  eventId?: string;
  /** Skip the harness_slug → workspace_id resolve (e.g. caller already knows it). */
  workspaceId?: string;
  /** Injectable seam for tests — overrides resolveWorkspaceForHarness. */
  resolveWorkspace?: typeof resolveWorkspaceForHarness;
}

/**
 * Append one activity event to the ledger. Idempotent on `(harness_slug,
 * event_id)`: re-emitting the same `eventId` is a no-op (P-070d). Returns the
 * `event_id` so the caller can re-emit idempotently on retry.
 *
 * WI-1572: the table's `workspace_id` column is filled by a BEFORE-INSERT
 * trigger (`fill_workspace_id_from_projects`, migration 301) ONLY when this
 * INSERT leaves it null/empty — but that SQL-level trigger consults ONLY
 * `harness_shared.projects` (a sparse, non-authoritative projection; see
 * `lookupProjectWorkspaceIds`'s doc comment), with NO fallback to the
 * authoritative `harness_shared.harness_registry`. A harness registered only
 * in the registry (papercusp itself is exactly this case — no `projects` row,
 * but a real registry entry under workspace 'papercusp-workspace') silently
 * falls to 'default' and its usage-event outbox rows never match the real
 * workspace drain → permanently stranded (144+ rows observed, growing).
 * Fix: resolve the SAME way every other per-harness surface does —
 * `resolveWorkspaceForHarness` (projects, THEN the authoritative registry,
 * THROW if truly unregistered) — and set it explicitly on the INSERT so the
 * incomplete SQL trigger never gets a say.
 */
export async function emitUsageEvent(
  input: EmitUsageEventInput,
  deps: EmitDeps = {},
): Promise<{ event_id: string }> {
  const nowMs = deps.nowMs ?? Date.now();
  const event_id = deps.eventId ?? makeUsageEventId(nowMs);
  const sql = deps.sql ?? getOrgPg().sql;
  const resolve = deps.resolveWorkspace ?? resolveWorkspaceForHarness;
  const workspace_id = deps.workspaceId ?? (await resolve(input.harness_slug));
  await sql`
    INSERT INTO harness_shared.contributor_usage_events
      (harness_slug, event_id, github_user_id, device_pubkey, kind, ref_id, payload, ts, schema_version, workspace_id)
    VALUES
      (${input.harness_slug}, ${event_id}, ${input.github_user_id}, ${input.device_pubkey},
       ${input.kind}, ${input.ref_id ?? null},
       ${input.payload == null ? null : JSON.stringify(input.payload)}::text::jsonb,
       to_timestamp(${nowMs} / 1000.0),
       ${USAGE_EVENT_SCHEMA_VERSION}, ${workspace_id})
    ON CONFLICT (harness_slug, event_id) DO NOTHING
  `;
  return { event_id };
}

interface RollupAggRow {
  kind: string;
  n: number | string | bigint;
  last_ms: number | string | bigint | null;
}

/**
 * All-time per-kind rollup for one contributor in one harness. A single
 * GROUP-BY aggregate over the `(harness_slug, github_user_id, ts DESC)` index —
 * never fetches the raw event stream (P-070b). Windowing (since/until) is a
 * later refinement. Always tier-C per §17.
 */
export async function rollupForContributor(
  github_user_id: number,
  harness_slug: string,
  opts: { sql?: Sql } = {},
): Promise<UsageRollupForContributor> {
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<RollupAggRow[]>`
    SELECT kind,
           COUNT(*)::bigint AS n,
           MAX((EXTRACT(EPOCH FROM ts) * 1000))::bigint AS last_ms
      FROM harness_shared.contributor_usage_events
     WHERE harness_slug = ${harness_slug}
       AND github_user_id = ${github_user_id}
     GROUP BY kind
  `;
  const rollup = emptyRollup(github_user_id, harness_slug);
  const known = new Set<string>(USAGE_EVENT_KINDS);
  let last: number | null = null;
  for (const r of rows) {
    if (!known.has(r.kind)) continue; // ignore unknown/legacy kinds defensively
    const n = Number(r.n);
    rollup.counts[r.kind as UsageEventKind] = n;
    rollup.total += n;
    const lm = r.last_ms == null ? null : Number(r.last_ms);
    if (lm != null) last = last == null ? lm : Math.max(last, lm);
  }
  rollup.last_event_ts = last;
  return rollup;
}
