/**
 * bench-park — the ONE registration of a fleet bench park, shared by every caller.
 *
 * WHY THIS MODULE EXISTS (plan fleet-friction-remediation-2026-08-21, D-009):
 * `fleet:bench` already performs exactly the park P-009's context-critical auto-bench
 * needs — `registerAwait({ policy:'wake', timeoutBehavior:'wake', timeoutSec })`. D-009
 * ruled that an auto-bench is therefore a new CALLER of an existing park, not a new
 * lifecycle plane (so D-001 is satisfied), and directed the second caller to REUSE the
 * surface rather than open-code a second await. This module is that shared surface:
 * `fleet:bench` (leader-driven) and the scheduler's context-critical auto-bench both
 * register through `registerBenchPark`, so the two can never drift into two subtly
 * different park semantics.
 *
 * THE HAZARD THIS MODULE ENCODES — `supersedePriorBenches` has NO DEFAULT, on purpose.
 * The leader-driven park supersedes every prior bench for its member atomically, because
 * a leader staging a NEW assignment must replace the old one rather than leave a member
 * parked on two gates. That behaviour is correct for a leader and DESTRUCTIVE for an
 * auto-bench: a member that benches itself would silently retire the staged assignment
 * its leader had parked it on, and the leader would never learn its staging was dropped.
 * Making the flag required forces every new caller to answer that question deliberately
 * instead of inheriting a default that is wrong for half the call sites.
 */
import { FLEET_BENCH_NOTE_PREFIX, type registerAwait as RegisterAwaitFn } from '../events/await/store';
import type { captureWakeHandleForOwner as CaptureWakeHandleFn } from '../events/await/handle';

/** A parked-await row, narrowed to what a bench check actually reads. */
export interface ParkedAwaitRowLike {
  subscriberId: string;
  eventKey: string;
  note: string | null;
}

/**
 * PURE: does this member already hold a bench park?
 *
 * A bench is identified by its note prefix, exactly as `fleet:bench { list:true }`
 * identifies one — the same predicate, so "benched" cannot mean one thing to the
 * lister and another to the auto-bench gate.
 *
 * Callers pass the rows they already read. Fail-CLOSED on bench is the caller's job:
 * an unreadable await table must be treated as "may already be benched" and skip the
 * auto-bench, never as "not benched" (which would double-park the member).
 */
export function hasActiveBench(rows: readonly ParkedAwaitRowLike[], member: string): boolean {
  return rows.some(
    (row) => row.subscriberId === member && typeof row.note === 'string' && row.note.startsWith(FLEET_BENCH_NOTE_PREFIX),
  );
}

export interface BenchParkRequest {
  /** The agent being parked. For a leader-driven bench this is NOT the caller. */
  member: string;
  /** Concrete event key (patterns must already be expanded and validated by the caller). */
  eventKey: string;
  /** Leader-staged next assignment; '' / null for an auto-bench, which stages nothing. */
  stagedAssignment?: string | null;
  /** Bounded deadline in seconds; null = park until the key fires. */
  timeoutSec?: number | null;
  /** Optional claim-spec-derived payload predicate. */
  payloadFilter?: unknown | null;
  /**
   * REQUIRED, no default. True retires every prior bench for this member atomically
   * (leader semantics). False leaves prior benches untouched (auto-bench semantics).
   * See the hazard note at the top of this file.
   */
  supersedePriorBenches: boolean;
}

/**
 * Deps are typed against the REAL functions (`typeof`), not a hand-written structural
 * stand-in. A `(input: Record<string, unknown>) => …` stand-in does not typecheck against
 * the concrete `registerAwait` — a function taking a narrower parameter is not assignable
 * to one taking a wider one — and, worse, it would erase the await field types at exactly
 * the call site where getting `timeoutBehavior` or `supersedePending` wrong is the bug.
 */
export interface BenchParkDeps {
  captureWakeHandleForOwner: typeof CaptureWakeHandleFn;
  registerAwait: typeof RegisterAwaitFn;
}

export interface BenchParkOutcome {
  /** `AwaitRow.id` is numeric; kept numeric here rather than stringified so callers
   *  see the real type instead of a lossy re-render of it. */
  benchId: number;
  eventKey: string;
  expiresTs: string | null;
  /** Whether a live wake handle was captured — a park with none cannot be woken in place. */
  registered: boolean;
  wakeHandleNote: string | null;
  supersededBenches: number;
}

/**
 * Register the park. The await shape here is the one `fleet:bench` has always used;
 * the only thing that varies between callers is `supersedePriorBenches`.
 */
export async function registerBenchPark(req: BenchParkRequest, deps: BenchParkDeps): Promise<BenchParkOutcome> {
  const staged = req.stagedAssignment ?? '';
  const { handle, note: handleNote } = await deps.captureWakeHandleForOwner(req.member);
  const row = await deps.registerAwait({
    subscriberId: req.member,
    eventKey: req.eventKey,
    policy: 'wake',
    note: FLEET_BENCH_NOTE_PREFIX + staged,
    wakeHandle: handle,
    timeoutBehavior: 'wake',
    // A fleet bench is a managed park, not a normal short-lived await. An omitted
    // deadline must survive a long-lived blocker (and the leader's own session
    // ending); callers opt into a deadline when the park has a natural horizon.
    timeoutSec: req.timeoutSec ?? null,
    payloadFilter: req.payloadFilter ?? null,
    ...(req.supersedePriorBenches
      ? {
          supersedePending: {
            allEventKeys: true,
            includeNotePrefix: FLEET_BENCH_NOTE_PREFIX,
          },
        }
      : {}),
  });
  return {
    benchId: row.id,
    eventKey: row.eventKey,
    expiresTs: row.expiresTs,
    registered: handle !== null,
    wakeHandleNote: handleNote,
    supersededBenches: row.supersededPendingCount ?? 0,
  };
}
