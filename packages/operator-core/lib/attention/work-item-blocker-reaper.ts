/**
 * work-item-blocker-reaper.ts — the ENFORCEMENT half of the owner-attention ledger
 * (WI-10005010; the DECLARATION half is EI-23783029010995961).
 *
 * `work_items:set_blocker` already REQUIRES a `defaultIfUnanswered` on owner-capability
 * asks and the owner card/digest disclose it — but until this module nothing ENFORCED it,
 * so the declared default was only a promise. `gate-reaper.ts` does this for SESSION
 * gates (`session_pending_gates`); this is its work-item sibling and reuses its shape:
 * a PURE decide-fn (`decideBlockerDefault`, external-blockers.ts) feeding a sweep.
 *
 * OWNER-AUTHORITY SEMANTICS (the design ruling). An agent acting on an owner's silence
 * must never act on prose it did not author a closed meaning for, so:
 *   - ONLY the typed `defaultAction` (a closed vocabulary: `stay_parked` |
 *     `release_to_agents`) ever executes. The free-text default is never interpreted.
 *   - A blocker with a passed `decideBy` but no typed action is surfaced, not applied.
 *   - Exactly once: `defaultAppliedAt` is the fence, written in the same payload write
 *     that applies the action, and the history row records who/when/what.
 *   - Rollout is inert by construction: only blockers that carry BOTH `decideBy` and a
 *     typed `defaultAction` are candidates (measured 2026-10-01: 233 active human
 *     blockers, 0 with either), so nothing is applied retroactively.
 *
 * Hosted inside the existing `gate-watcher-tick` system action (gate-watch-action.ts) as
 * an additive, isolated try/catch — no new routine, no third scheduler.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  applyBlockerDefaultToHistory,
  decideBlockerDefault,
  readExternalBlockers,
  type BlockerDefaultSkipReason,
  type ExternalBlockerRecord,
  type OwnerAskDefaultAction,
} from '../external-blockers';
import {
  getWorkItem,
  mergeWorkItemPayload,
  setWorkItemClaimHold,
  setWorkItemStateWithAliasInfo,
} from '../work-items';
import { hasActiveStrictHumanAsk } from '../hold-registry';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

export const BLOCKER_DEFAULT_REAPER_ACTOR = 'system:blocker-default-reaper';

export interface BlockerReapCandidate {
  id: string;
  harness: string;
  payload: unknown;
}

export interface BlockerReapDeps {
  listCandidates(limit: number): Promise<BlockerReapCandidate[]>;
  /** Fresh read so the apply is compare-and-set against CURRENT blocker history. */
  readPayload(id: string, harness: string): Promise<{ payload: unknown; family?: string; state?: string } | null>;
  writeBlockers(id: string, harness: string, blockers: ExternalBlockerRecord[]): Promise<boolean>;
  /** Return the item to the claimable pool (or the right parked state) after a release. */
  restoreLifecycle(args: {
    id: string;
    harness: string;
    family?: string;
    state?: string;
    remaining: ExternalBlockerRecord[];
  }): Promise<void>;
}

export interface BlockerSweepResult {
  examined: number;
  applied: Record<OwnerAskDefaultAction, number>;
  skipped: Partial<Record<BlockerDefaultSkipReason | 'lost-race' | 'read-failed', number>>;
  truncatedByLimit: boolean;
}

function bump(result: BlockerSweepResult, why: keyof BlockerSweepResult['skipped']): void {
  result.skipped[why] = (result.skipped[why] ?? 0) + 1;
}

export const defaultBlockerReapDeps: BlockerReapDeps = {
  async listCandidates(limit) {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ id: string; harness: string; payload: unknown }>>`
      SELECT w.feature_id AS id, w.harness_slug AS harness, w.payload AS payload
        FROM harness_shared.work_items w
       WHERE NOT (w.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND jsonb_typeof(w.payload->'externalBlockers') = 'array'
         AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(w.payload->'externalBlockers') b
                WHERE b->>'kind' = 'human' AND b->>'status' = 'active'
                  AND b->>'decideBy' IS NOT NULL AND b->>'defaultAction' IS NOT NULL
                  AND b->>'defaultAppliedAt' IS NULL)
       ORDER BY w.feature_id
       LIMIT ${limit}
    `;
    return rows.map((r) => ({ id: r.id, harness: r.harness, payload: r.payload }));
  },
  async readPayload(id, harness) {
    const wi = await getWorkItem(id, harness);
    return wi ? { payload: wi.payload, family: wi.family, state: wi.state } : null;
  },
  async writeBlockers(id, harness, blockers) {
    return (await mergeWorkItemPayload(id, { externalBlockers: blockers }, { harness })) !== null;
  },
  // Mirrors work_items:set_blocker's lifecycle restore branch-for-branch: lifecycle
  // follows the blockers that REMAIN, never the shape of this request.
  async restoreLifecycle({ id, harness, family, state, remaining }) {
    if (remaining.length > 0) {
      // D-029: the hold registry's answerable ask, the predicate the needs-human writer refuses on.
      const strict = hasActiveStrictHumanAsk({ externalBlockers: remaining });
      await setWorkItemStateWithAliasInfo(id, strict ? 'needs-human' : 'blocked', {
        harness,
        by: BLOCKER_DEFAULT_REAPER_ACTOR,
      });
    } else if (family === 'feature' && (state === 'blocked' || state === 'needs-human')) {
      await setWorkItemStateWithAliasInfo(id, 'open', { harness, by: BLOCKER_DEFAULT_REAPER_ACTOR });
    } else if (family === 'issue') {
      await setWorkItemClaimHold(id, false, {
        harness,
        by: BLOCKER_DEFAULT_REAPER_ACTOR,
        reason: 'owner-ask decideBy passed; typed default release_to_agents applied',
      });
      // setWorkItemClaimHold only strips the payload hold keys — it never touches `status`.
      // An issue parked on a strict human ask is stored as `needs-human` (set_blocker
      // enters it via setWorkItemStateWithAliasInfo), so without this the item would be
      // left `needs-human` with ZERO active blockers: unclaimable AND unexplained. Found
      // by the real-PG integration test (WI-10005093); the fake-deps unit test could not.
      if (state === 'blocked' || state === 'needs-human') {
        await setWorkItemStateWithAliasInfo(id, 'open', { harness, by: BLOCKER_DEFAULT_REAPER_ACTOR });
      }
    }
  },
};

/**
 * One sweep. Never throws for a single bad row: a per-item failure is counted and the
 * sweep continues, because one malformed payload must not strand every other deadline.
 */
export async function sweepWorkItemBlockerDefaults(opts?: {
  now?: Date;
  limit?: number;
  dryRun?: boolean;
  deps?: BlockerReapDeps;
}): Promise<BlockerSweepResult> {
  const deps = opts?.deps ?? defaultBlockerReapDeps;
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? 200;
  const rows = await deps.listCandidates(limit + 1);
  const truncatedByLimit = rows.length > limit;
  const batch = truncatedByLimit ? rows.slice(0, limit) : rows;
  const result: BlockerSweepResult = {
    examined: batch.length,
    applied: { stay_parked: 0, release_to_agents: 0 },
    skipped: {},
    truncatedByLimit,
  };

  for (const row of batch) {
    for (const blocker of readExternalBlockers(row.payload)) {
      const decision = decideBlockerDefault(blocker, now);
      if (!decision.apply) {
        // not-human / not-active / no-decide-by are the NORMAL shape of most rows on a
        // multi-blocker item; counting them would drown the signal, so only report the
        // two that mean "an owner-visible deadline is not being honoured".
        if (decision.why === 'no-typed-action' || decision.why === 'decide-by-unparseable') bump(result, decision.why);
        continue;
      }
      if (opts?.dryRun) {
        result.applied[decision.action] += 1;
        continue;
      }
      try {
        const fresh = await deps.readPayload(row.id, row.harness);
        if (!fresh) {
          bump(result, 'read-failed');
          continue;
        }
        const history = applyBlockerDefaultToHistory(
          fresh.payload,
          blocker.ref,
          decision.action,
          BLOCKER_DEFAULT_REAPER_ACTOR,
          now.toISOString(),
        );
        if (!history.changed) {
          bump(result, 'lost-race');
          continue;
        }
        if (!(await deps.writeBlockers(row.id, row.harness, history.blockers))) {
          bump(result, 'read-failed');
          continue;
        }
        if (decision.action === 'release_to_agents') {
          await deps.restoreLifecycle({
            id: row.id,
            harness: row.harness,
            family: fresh.family,
            state: fresh.state,
            remaining: history.blockers.filter((b) => b.status === 'active'),
          });
        }
        result.applied[decision.action] += 1;
      } catch (err) {
        console.warn(
          `[blocker-default-reaper]   ! ${row.id} ${blocker.ref}: ${err instanceof Error ? err.message : String(err)}`,
        );
        bump(result, 'read-failed');
      }
    }
  }
  return result;
}
