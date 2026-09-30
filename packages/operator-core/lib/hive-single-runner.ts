/**
 * hive-single-runner — the per-Hive SINGLE-RUNNER gate for node-local autonomous
 * loops (domain-generic-hive-architecture-2026-06-18 P-019 / P-020; closes the
 * Phase-4 audit's I3 + I4).
 *
 * ## The problem this closes
 *
 * Scout (`blender:cycle`) and the gym (`system:gym-cycle`) are CADENCE loops fired
 * by per-Hive routines. Their single-flight guard is `autoloop.claimFire` — a CAS
 * on `harness_shared.autoloop_state`, scoped by `activeWorkspaceId()`. That is
 * single-flight WITHIN one Postgres only. A SHARED Hive gives each NODE its own
 * embedded Postgres (CLAUDE.md "Database topology"), so every node WINS its own
 * claim and runs its own cycle: N nodes ⇒ N independent scout/gym loops ⇒
 * duplicate ideation + duplicate routed plans/improvements/gym-seeds into the
 * federated backlog + divergent learning + duplicate LLM spend. The claim is
 * per-NODE single-flight, NOT per-HIVE-across-nodes (D-014, I3/I4 confirmed).
 *
 * ## The fix: reuse the SHIPPED per-Hive authority election
 *
 * The same `lockAuthorityForHive` (the lowest-live-device-pubkey election over the
 * Hive's `shared_presence` Swarms — `lib/authority/lock-authority.ts`, D-005) that
 * already serializes work-item claims (`work-item-claim-authority`) and Queen
 * steering writes (`steering-lease`) IS the cross-node single-runner. One node —
 * the elected authority — runs the cadence loop; the others stand down. No new
 * lease table, no CAS race, no election round-trip: every node computes the same
 * argmin from the federated presence roster, and when the authority's heartbeat
 * goes stale the next-lowest peer automatically IS the runner (failover with zero
 * coordination — the exact liveness property D-014 asked for, "lease-current-first
 * else lowest-pubkey").
 *
 * This is the EXACT shape of `steering-lease.checkSteeringLease` (single STEERER),
 * applied to single RUNNER — the two are siblings on the one authority primitive.
 *
 * ## Behaviour-neutral at N=1 (the only world today)
 *
 * - A non-Hive harness ⇒ `run: true, reason: 'not-in-hive'` (every standalone
 *   harness's scout/gym fires exactly as before).
 * - A single-box Hive ⇒ `lockAuthorityForHive` returns `{isSelf:true,liveCount:0}`
 *   (no remote Swarms in presence) ⇒ `run: true, reason: 'authority'`.
 * - FAIL-OPEN (D-004): any resolution error ⇒ `run: true, reason: 'fail-open'`.
 *   A node must never STALL its own learning loop on an unreachable peer; a rare
 *   duplicate cycle is the tolerated price (same posture as work-item claims and
 *   the steering lease — duplicate work over a stall, git/backlog is the backstop).
 *
 * The cross-node teeth only grow in once a second Swarm of the Hive publishes its
 * `hive_slug` presence row — i.e. exactly when the duplication would otherwise
 * begin. Pure resolution over injectable seams (tests drive the election with a
 * fake presence roster + clock); never throws.
 */
import type { AuthorityResolution, LockAuthorityDeps } from './authority/lock-authority';
import { lockAuthorityForHive } from './authority/lock-authority';
import { potHomeSlugForHarness } from './hive-federation';

/** The single-runner verdict for one cadence tick of a per-Hive loop. */
export interface HiveSingleRunnerVerdict {
  /** True ⇒ this node runs the cycle (we are the authority, standalone, or fail-open). */
  run: boolean;
  reason: 'not-in-hive' | 'authority' | 'remote-runner' | 'fail-open';
  /** The Hive whose authority arbitrated (absent for not-in-hive / fail-open). */
  potSlug?: string;
  /** Live Swarms considered by the election (when resolved). */
  liveCount?: number;
  /** Human-readable runner label, set when a REMOTE Swarm is the runner. */
  runnerLabel?: string;
}

/** Injectable resolution seams (tests; production uses the live defaults). */
export interface HiveSingleRunnerDeps {
  /** harness → its home Hive slug (null = not in a Hive). Default: potHomeSlugForHarness. */
  resolveHive?: (workspaceId: string, harnessSlug: string) => Promise<string | null>;
  /**
   * The per-Hive lock authority. Default: lockAuthorityForHive. The optional
   * `authorityDeps` are forwarded to it (tests inject a fake presence roster +
   * clock here to drive the election deterministically).
   */
  hiveAuthority?: (potSlug: string) => Promise<AuthorityResolution>;
  /** Forwarded to the default lockAuthorityForHive (presence roster / clock / staleness). */
  authorityDeps?: LockAuthorityDeps;
}

/**
 * Resolve whether THIS node is the single runner for a harness's Hive cadence
 * loop. Inert at N=1 (single Swarm ⇒ trivially the authority ⇒ run) and for
 * non-Hive harnesses (always run); FAIL-OPEN on every resolution error (D-004 —
 * never stall a learning loop on an unreachable peer). Never throws.
 */
export async function checkHiveSingleRunner(
  workspaceId: string,
  harnessSlug: string,
  deps: HiveSingleRunnerDeps = {},
): Promise<HiveSingleRunnerVerdict> {
  const resolveHive = deps.resolveHive ?? potHomeSlugForHarness;
  // WI-6032 (P-005): scope the election to THIS workspace — we already have it
  // (the caller's own `workspaceId` param), so it is a genuine, non-ambient
  // caller-known value, not a guess (see LockAuthorityDeps.workspaceId). An
  // explicit `authorityDeps.workspaceId` override (tests) still wins.
  // EI-18761517980514694: elect only among nodes that actually RUN this pot's
  // cadence loops (`shared_presence.runs_routines`). Without it the election is a
  // bare argmin over the presence roster with no notion of capability, so a peer
  // that never fires the loop won every tick and the pot went dark for hours —
  // while this node, holding the enabled autoloop and the budget, stood down as
  // `remote-runner` ~89% of the time. It cannot stall anything: eligibility
  // constrains PEERS only and self is always a candidate, so worst case every peer
  // is excluded and this node runs its own loop. An explicit
  // `authorityDeps.routineHostsOnly` (tests) still wins.
  const authority =
    deps.hiveAuthority ??
    ((slug: string) =>
      lockAuthorityForHive(slug, {
        ...deps.authorityDeps,
        workspaceId: deps.authorityDeps?.workspaceId ?? workspaceId,
        routineHostsOnly: deps.authorityDeps?.routineHostsOnly ?? true,
      }));
  try {
    const potSlug = await resolveHive(workspaceId, harnessSlug);
    if (!potSlug) return { run: true, reason: 'not-in-hive' };
    const res = await authority(potSlug);
    if (res.isSelf) {
      return { run: true, reason: 'authority', potSlug, liveCount: res.liveCount };
    }
    return {
      run: false,
      reason: 'remote-runner',
      potSlug,
      liveCount: res.liveCount,
      runnerLabel: res.peer
        ? res.peer.machineLabel || `${res.peer.devicePubkey.slice(0, 12)}…`
        : 'an unidentified peer Swarm',
    };
  } catch {
    // Fail-open: a gate that cannot be resolved must never stall the loop — a rare
    // duplicate cycle is tolerable; a permanently-dark learning loop is not.
    return { run: true, reason: 'fail-open' };
  }
}

/** Convenience: the bare boolean. Equivalent to `checkHiveSingleRunner(...).run`. */
export async function isHiveSingleRunner(
  workspaceId: string,
  harnessSlug: string,
  deps: HiveSingleRunnerDeps = {},
): Promise<boolean> {
  return (await checkHiveSingleRunner(workspaceId, harnessSlug, deps)).run;
}
