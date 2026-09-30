/**
 * fleet-control-reconcile — flip `agent_fleets.control_state` off 'active' for fleets that
 * have actually finished, so the flag means what its readers assume it means.
 *
 * WHY THIS EXISTS (WI-35718, 2026-08-08). `control_state` is a DECLARED fact: it only ever
 * leaves 'active' when someone calls `fleet:wind-down`. Closing a fleet in prose ("fleet is
 * closed, drain off") does not touch it, and that omission is silent — the fleet reads
 * 'active' forever. Measured on this workspace: 155 fleets 'active' vs 17 'winding-down',
 * with the newest 'active' fleet last touched 6 days prior and the distribution trailing back
 * through mid-July, against 24 agents alive. Essentially all of them were dead.
 *
 * That backlog is not cosmetic. `system:unguarded-halt-rescue` gates on
 * `controlState === 'active'` BY DESIGN (never guess liveness — EI-18733935898107794), so
 * every stale row is a standing false positive for the rescue: it treats members of a
 * long-dead fleet as agents worth waking. That is what produced the rescue's noise
 * complaints, and the rescue was hand-paused on 2026-07-27 as a result — leaving the fleet
 * with NO silent-halt protection for the 12 days that followed, a window containing two
 * separate measured 4-day agent blackouts. Fixing the declared-fact drift is the
 * precondition for turning that rescue back on.
 *
 * DESIGN: the decision is a PURE function (`decideFleetWindDown`) so every rule is testable
 * without PG, and the IO wrapper only gathers inputs and applies the verdict. Membership
 * comes from `fleetEverMembers` (the append-only membership log, which SURVIVES the presence
 * reaper) rather than from whoever happens to be in the assignments read right now.
 *
 * ⚠ THE LOAD-BEARING SAFETY ARGUMENT, because the failure is asymmetric. Wrongly winding down
 * a LIVE fleet breaks scheduler fleet-scope admission for its members (EI-12832); failing to
 * wind down a dead one merely preserves the status quo. So every ambiguous signal resolves to
 * SKIP. The one inference we do make is: a LIVE session is always observable in presence, so
 * "no member observed in a non-terminal state" IS sound evidence of "no live members" —
 * but ONLY when the liveness read actually succeeded. A degraded read is not evidence of
 * death; it is the absence of evidence, and it skips.
 */
import type { Sql } from 'postgres';
import type { SessionState } from '../../agent-tools/coordination/presence-wakeability';

/**
 * How stale a fleet must be before it is even a candidate. Belt-and-braces beside the
 * liveness check: a fleet mid-launch whose members have not registered yet reads as
 * memberless for a moment, and this floor keeps that moment from being fatal.
 */
export const STALE_FLEET_FLOOR_MS = 3 * 24 * 60 * 60 * 1000;

/** Bound the blast radius of any single pass (mirrors the rescue's own per-tick cap). */
export const MAX_WIND_DOWNS_PER_TICK = 25;

/**
 * The session states that mean "this member is NOT finished". Derived from the shared
 * `SessionState` union, and deliberately inclusive: 'suspect' is an UNRESOLVED verdict, not a
 * death certificate, so a suspect member keeps its fleet alive. Only 'ended' and 'recorded'
 * are terminal.
 */
export const NON_TERMINAL_SESSION_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'live',
  'parked',
  'draining',
  'suspect',
]);

export type FleetWindDownVerdict =
  | { windDown: true; reason: string }
  | { windDown: false; skip: string };

/**
 * Decide whether ONE fleet should be wound down (PURE).
 *
 * `liveMembers` is the subset of members observed in a NON-terminal state. `livenessRead`
 * reports whether the observation actually happened — 'degraded' means we could not see, which
 * is never the same as seeing nothing.
 */
export function decideFleetWindDown(input: {
  updatedAtMs: number;
  nowMs: number;
  everMembers: ReadonlySet<string>;
  liveMembers: ReadonlySet<string>;
  livenessRead: 'ok' | 'degraded';
  floorMs?: number;
}): FleetWindDownVerdict {
  const floor = input.floorMs ?? STALE_FLEET_FLOOR_MS;

  // Absence of evidence, not evidence of absence. Checked FIRST so a degraded read can never
  // be laundered into a wind-down by the emptiness it causes.
  if (input.livenessRead !== 'ok') return { windDown: false, skip: 'liveness-read-degraded' };

  // `fleetEverMembers` documents that an unknown fleet and a genuinely memberless one both
  // return an empty set, and that only the caller knows which it can assume. We cannot, so
  // this is a skip — winding down on "no members known" would act on the ambiguity.
  if (input.everMembers.size === 0) return { windDown: false, skip: 'no-members-known' };

  const ageMs = input.nowMs - input.updatedAtMs;
  if (ageMs < floor) return { windDown: false, skip: 'too-recent' };

  if (input.liveMembers.size > 0) return { windDown: false, skip: 'has-live-members' };

  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  return {
    windDown: true,
    reason:
      `fleet-control-reconcile: all ${input.everMembers.size} known member(s) are in a terminal ` +
      `session state and the fleet has been untouched for ${days}d — 'active' no longer reflects reality`,
  };
}

/** One fleet's inputs, as gathered by the caller. */
export interface FleetControlCandidate {
  fleetSlug: string;
  updatedAtMs: number;
}

export interface FleetControlReconcileDeps {
  /** Fleets currently declared 'active'. */
  listActiveFleets?: () => Promise<FleetControlCandidate[]>;
  /** Durable membership for a fleet (append-only log; survives the presence reaper). */
  everMembers?: (fleetSlug: string) => Promise<Set<string>>;
  /**
   * Session state per owner, via the SHARED oracle. Returning a partial map is fine — a
   * member absent from it contributes no liveness evidence. THROWING is what signals a
   * degraded read, and a degraded read skips the fleet entirely.
   */
  sessionStates?: (ownerIds: string[]) => Promise<Map<string, SessionState | null>>;
  /** Apply the verdict. */
  /**
   * Apply a wind-down against the snapshot that produced the verdict. Returning false means
   * the compare-and-set lost to a newer fleet update (for example, fleet:resume) and the
   * caller must not report the stale wind-down as applied.
   */
  windDown?: (
    fleetSlug: string,
    reason: string,
    expected: { state: 'active'; updatedAtMs: number },
  ) => Promise<boolean | void>;
  nowMs?: number;
  cap?: number;
  floorMs?: number;
}

export interface FleetControlReconcileResult {
  considered: number;
  woundDown: string[];
  skipped: Record<string, number>;
}

/**
 * Reconcile every declared-'active' fleet against observed reality. Best-effort per fleet: one
 * fleet's failure is recorded as a skip and never aborts the pass, because a sweep that dies
 * on its first bad row silently stops protecting every row after it.
 */
export async function reconcileFleetControlStates(
  deps: FleetControlReconcileDeps = {},
): Promise<FleetControlReconcileResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const cap = deps.cap ?? MAX_WIND_DOWNS_PER_TICK;
  const result: FleetControlReconcileResult = { considered: 0, woundDown: [], skipped: {} };
  const note = (k: string) => {
    result.skipped[k] = (result.skipped[k] ?? 0) + 1;
  };

  if (!deps.listActiveFleets || !deps.everMembers || !deps.sessionStates || !deps.windDown) {
    throw new Error('reconcileFleetControlStates: all IO deps must be supplied by the caller');
  }

  const fleets = await deps.listActiveFleets();
  for (const fleet of fleets) {
    if (result.woundDown.length >= cap) {
      note('cap-reached');
      continue;
    }
    result.considered += 1;
    try {
      const everMembers = await deps.everMembers(fleet.fleetSlug);
      let liveMembers = new Set<string>();
      let livenessRead: 'ok' | 'degraded' = 'ok';
      if (everMembers.size > 0) {
        try {
          const states = await deps.sessionStates([...everMembers]);
          liveMembers = new Set(
            [...states.entries()]
              .filter(([, s]) => s != null && NON_TERMINAL_SESSION_STATES.has(s))
              .map(([id]) => id),
          );
        } catch {
          livenessRead = 'degraded';
        }
      }

      const verdict = decideFleetWindDown({
        updatedAtMs: fleet.updatedAtMs,
        nowMs,
        everMembers,
        liveMembers,
        livenessRead,
        floorMs: deps.floorMs,
      });
      if (!verdict.windDown) {
        note(verdict.skip);
        continue;
      }
      const applied = await deps.windDown(fleet.fleetSlug, verdict.reason, {
        state: 'active',
        updatedAtMs: fleet.updatedAtMs,
      });
      if (applied === false) {
        note('state-changed-since-snapshot');
        continue;
      }
      result.woundDown.push(fleet.fleetSlug);
    } catch {
      note('error');
    }
  }
  return result;
}

/** Default IO wiring, kept separate so the logic above unit-tests with no PG at all. */
export async function defaultFleetControlReconcileDeps(
  workspaceId: string,
  sql?: Sql,
): Promise<Required<Pick<FleetControlReconcileDeps, 'listActiveFleets' | 'everMembers' | 'sessionStates' | 'windDown'>>> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const db = sql ?? getOrgPg().sql;

  return {
    listActiveFleets: async () => {
      const rows = await db<Array<{ fleet_slug: string; updated_at: string | number }>>`
        SELECT fleet_slug, updated_at
          FROM harness_shared.agent_fleets
         WHERE workspace_id = ${workspaceId} AND control_state = 'active'`;
      return rows.map((r) => ({ fleetSlug: r.fleet_slug, updatedAtMs: Number(r.updated_at) }));
    },
    everMembers: async (fleetSlug: string) => {
      const { fleetEverMembers } = await import('../../fleet-membership-store');
      return fleetEverMembers(fleetSlug, { workspaceId }, db);
    },
    sessionStates: async (ownerIds: string[]) => {
      const { listFleetAssignments } = await import('../../fleet/assignments');
      const {
        reconcileWakeability,
        RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
      } = await import('../../agent-tools/fleet/assignments');
      const wanted = new Set(ownerIds);
      type Row = { agentId: string; sessionState?: SessionState | null };
      // `agentId` is nullable on AgentAssignment; a row without one identifies nobody, so it
      // can neither match a member nor contribute liveness evidence.
      const rows = (await listFleetAssignments({})).filter(
        (a) => a.agentId != null && wanted.has(a.agentId),
      );
      const reconciled = (await reconcileWakeability(
        rows as never,
        undefined,
        undefined,
        undefined,
        undefined,
        RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
      )) as unknown as Row[];
      const out = new Map<string, SessionState | null>();
      for (const r of reconciled) out.set(r.agentId, r.sessionState ?? null);
      return out;
    },
    windDown: async (
      fleetSlug: string,
      reason: string,
      expected: { state: 'active'; updatedAtMs: number },
    ) => {
      const { setFleetControlState } = await import('../../agent-fleets-store');
      const updated = await setFleetControlState(
        workspaceId,
        fleetSlug,
        {
          state: 'winding-down',
          reason,
          by: 'system:fleet-control-reconcile',
          // WI-2034563: this reconcile only fires when EVERY known member is already
          // in a terminal session state — there is nobody left to park, so the park is
          // TERMINAL by construction. Declaring a resume gate here would publish a key
          // with no possible awaiter, and leader-brief would then report a janitorial
          // tidy-up as recoverable lost capacity.
          noResumePath: true,
        },
        db,
        undefined,
        expected,
      );
      return updated !== null;
    },
  };
}
