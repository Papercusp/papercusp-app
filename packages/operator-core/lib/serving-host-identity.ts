/**
 * serving-host-identity — WHICH host process served a tool call, and what code it
 * had loaded (WI-1565914).
 *
 * `harness_shared.tool_invocations` is named for the TOOL and identifies the CALLER
 * (`coord_owner_id`); until this module it recorded nothing about the SERVER. That
 * gap has a measured cost. Host processes running code from before 2026-08-09 were
 * serving live agent calls as late as 2026-08-27 — ≥17.5 days stale — concurrently
 * with current-code hosts, and the difference was invisible in telemetry. It was
 * found only by noticing an impossible aggregate (`pot:wake` returning `ok` after a
 * retirement gate should have refused it) and then spending nine queries partitioning
 * the table by proxies until `coord_owner_id` happened to separate the populations —
 * and it separated them only because sessions are host-sticky, which is a property of
 * the fleet, not a guarantee of the schema.
 *
 * ⚠ The trap this replaces: `spawn_id` LOOKS like a process id and is a LABEL. All 490
 * subscription-driven `pot:wake` rows carry the literal `'event-reaction'`, so
 * `GROUP BY spawn_id` returns ONE mixed bucket — which reads as "a single process
 * produced both outcomes" (nondeterminism) when it actually means the field cannot see
 * processes at all. A field that cannot distinguish the population you group it by
 * returns a confident, well-formed, WRONG partition.
 *
 * ── Three fields, because they answer three different questions ──────────────────────
 *   host       — WHICH SERVICE (`port-3070`). Stable across restarts of the same
 *                logical service, so it is what you GROUP BY for "does :3070 behave
 *                differently from :3170?".
 *   processId  — WHICH RUN of it. Kernel-backed (`linux:<boot-id>:<start-ticks>`) and
 *                therefore immune to PID reuse, which happens ~daily on this box under
 *                fleet load. A bare pid would silently merge two processes into one.
 *   buildSha   — WHAT CODE it loaded. The load-bearing one: a stale host is defined by
 *                its code, not by its address.
 *
 * Boot time needs no column — `min(invoked_at) GROUP BY serving_process_id` bounds it
 * from the ledger itself.
 *
 * ── Why NULL must stay NULL ──────────────────────────────────────────────────────────
 * `buildSha` comes from `getBuildInfo()`, which deliberately reports `null` for a
 * bundled artifact carrying no baked sha rather than reading the current checkout's
 * HEAD. That refusal is the whole point and must survive this indirection: reporting a
 * *plausible* sha for a process whose loaded bytes are unproven would recreate exactly
 * the false-confidence failure this column exists to end. An honest unknown is
 * distinguishable from a known value; a fabricated one is not.
 *
 * Every field is a process CONSTANT, so all three are resolved once and cached — the
 * dispatch path pays a property read, not a syscall.
 */
import { getBuildInfo } from './build-info';
import { readProcessIdentity } from './process-identity';

export interface ServingHostIdentity {
  /** Logical service: `port-3070`, else `pid-<n>` when no port is resolvable. */
  host: string;
  /** Kernel-backed per-process identity, or null when it could not be read. */
  processId: string | null;
  /** Short git sha of the code this process LOADED, or null when unprovable. */
  buildSha: string | null;
}

/**
 * The logical-service label. Prefers the operator's own port, which is stable across
 * restarts of "the same" service (:3070 / :3170 / :3270 / :3271); falls back to a
 * pid-scoped label when no port is resolvable.
 *
 * Exported and shared on purpose: `stale-routine-executor-watchdog` keys its
 * escalations and `coord_event_log` condition keys off this SAME string. If telemetry
 * and the watchdog computed the label separately they could drift, and a drifted label
 * cannot be joined — the staleness page and the calls that host actually served would
 * silently stop lining up, which is the failure one level up from the one this module
 * fixes.
 */
export function hostIdentity(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): string {
  const port = env.PAPERCUSP_HONO_PORT ?? env.PORT;
  return port ? `port-${port}` : `pid-${pid}`;
}

/** Pure resolver (injectable seams for tests). */
export function resolveServingHostIdentity(opts: {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  processId?: () => string | null;
  buildSha?: () => string | null;
} = {}): ServingHostIdentity {
  const pid = opts.pid ?? process.pid;
  const readId = opts.processId ?? (() => readProcessIdentity(pid));
  const readSha = opts.buildSha ?? (() => getBuildInfo().sha);
  // Best-effort like every other field on this row: telemetry must never break a
  // tool call, and a null here reads correctly as "not recorded".
  let processId: string | null = null;
  try {
    processId = readId() || null;
  } catch {
    processId = null;
  }
  let buildSha: string | null = null;
  try {
    buildSha = readSha() || null;
  } catch {
    buildSha = null;
  }
  return { host: hostIdentity(opts.env ?? process.env, pid), processId, buildSha };
}

let cached: ServingHostIdentity | null = null;

/** This process's serving identity, resolved once and cached. */
export function getServingHostIdentity(): ServingHostIdentity {
  if (!cached) cached = resolveServingHostIdentity();
  return cached;
}

/** Test-only — clear the cache. */
export function _resetServingHostIdentityForTest(): void {
  cached = null;
}
