/**
 * loop:status — read the loop on your own session (or another owner's): is it
 * active, its interval, whether its turn is in flight (parked), the next/last
 * fire, and the cost-cap (loop-routines-interval-recurrence-2026-06-20, B-LOOP-5).
 * The targeted "observe a loop" read; fleet:assignments shows the work the loop
 * is creating, and the routine fire-history shows each wake.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { describeStoreIdentityMismatch, storeIdentityViolation } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';
import { getLoopStatus } from '../../harness/routines/loop';
import {
  readLatestLoopTransition,
  type LatestLoopTransitionRead,
} from '../../harness/routines/loop-transition-log';
import { getLoopCarryNoteWithMeta, shortCarryHash } from '../../carry-note';
import { probeWakeReachability, type WakeReachabilityVerdict } from '../../events/await/wake-reachability';
import { listWakeAwaitsForSubscriber } from '../../events/await/store';
import type { LivePushChannels } from './arm';
import { classifyLoopNextWake } from './next-wake';

/** WI-10004466: a currently-withheld loop wake, derived from the latest transition. */
export interface ActiveAwaitSuppression {
  suppressedUntil: string;
  drivingEventKey: string | null;
  summary: string;
}

/**
 * WI-10004466: the loop's next wake is being WITHHELD by await suppression right now when
 * the newest transition is loop-fire's `await-suppression` re-arm, its target is still in
 * the future, and the loop's schedule is still the one that re-arm wrote (a later arm or
 * re-arm supersedes it). Pure; null whenever any of that cannot be shown.
 */
export function deriveActiveAwaitSuppression(
  lastTransition: LatestLoopTransitionRead | null,
  nextFireAt: Date | string | null | undefined,
  nowMs: number,
): ActiveAwaitSuppression | null {
  if (!lastTransition || lastTransition.status !== 'found') return null;
  const t = lastTransition.transition;
  if (t.actor !== 'await-suppression' || t.event !== 'rearmed' || !t.newNextFireAt) return null;
  const untilMs = Date.parse(t.newNextFireAt);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return null;
  const nextMs = nextFireAt instanceof Date ? nextFireAt.getTime() : nextFireAt ? Date.parse(nextFireAt) : NaN;
  if (!Number.isFinite(nextMs) || Math.abs(nextMs - untilMs) > 1_000) return null;
  const key = typeof t.detail?.drivingEventKey === 'string' ? t.detail.drivingEventKey : null;
  const until = new Date(untilMs).toISOString();
  return {
    suppressedUntil: until,
    drivingEventKey: key,
    summary:
      `Routine wakes are withheld until ${until} because you hold an active await` +
      `${key ? ` (${key})` : ''}; the loop is not firing on its interval. If you have other ` +
      'work, cancel that await (events:cancel) or set the waiting item blocked (work_items:set_blocker).',
  };
}

export default defineTool({
  name: 'loop:status',
  profile: 'engineer',
  // @not-a-cell live state, but a SINGLE DOOR and inherently owner-scoped + argument-taking
  // (ownerId), not a no-arg globally cacheable value — the shape the cell registry exists for.
  // `getLoopStatus` (harness/routines/loop.ts) is the one derivation of "this owner's loop
  // record"; nothing else re-derives it independently, so a cell would add a registry entry
  // without removing a door (the D-010 failure this gate exists to prevent).
  // P-011 prompt-weight budget counts description + when + notWhen + chaining
  // and NOT returns/seeAlso. The RESPONSE documentation below therefore lives in
  // `guidance.returns`: it was in `description`, which pushed this tool to 1568
  // chars and breached the 1500 budget, reddening the fleet gate (WI-9334). It is
  // documentation of the RESPONSE, so `returns` is also where it belongs — and it
  // is demand-loaded via tools:find rather than baked into every system prompt.
  description:
    'Inspect the loop on your own session (or another owner\'s, with `ownerId`); this read is owner-scoped, so a `harness` arg is accepted and ignored. It reports active?, interval, parked (turn in flight), next/last fire, cost-cap, latest lifecycle transition, and the current carry-note read-back. Four fields carry warnings you must read before acting — `turnsStalled` (armed but not producing), `cadenceDrift` (a late fire path after sustained slow cadence), `pendingAwaits` (whether you are REALLY parked), and a `storeIdentityViolation` guard that makes a `null` mean UNKNOWN rather than "no loop": see `returns`.',
  guidance: {
    when: "Check whether your loop is still armed + when it next fires, or inspect another agent's loop. Pass `ownerId` for another session; this owner-scoped read ignores `harness` if passed.",
    returns:
      '`cadenceDrift` (EI-21276782387845111) is true only when sustained slow-cadence evidence is corroborated by a scheduled fire several intervals overdue. It stays false for a parked turn (the configured interval begins after turn settlement), missing cadence history, or a fire that is not demonstrably late; combine it with the raw cadence fields rather than treating false as proof of normal cadence.\n\n' +
      "ROOT ENVELOPE: `{ ok, ownerId, loop, lastTransition, carryNote, reachability, pendingAwaits, storeIdentityWarning? }` — the loop RECORD is NESTED under `loop`: `{ active, intervalSec, parked, nextFireAt, lastFiredAt, fireCount, firesSinceArm, cost-cap, … }`, or null when no loop exists for the owner. `lastTransition` is null when no loop exists; otherwise it is a tri-state diagnostic read (`found`/`none`/`unknown`). A found transition preserves the scheduling cause — for example `actor:'await-suppression'` plus `detail.drivingEventKey` explains why a 60s loop was deliberately re-armed to an await deadline instead of firing each minute. A found transition also carries `cycle`: `parked` means the member's own TURN is in flight (next_fire_at is infinity), NOT a re-arm delay — read `cycle.lastTurn.turnSec` (parked→rearmed) and `postSettleDelaySec` (rearmed→next parked, ~intervalSec + <=30s tick) separately, because `loop.cadenceRatio`/`effectiveIntervalSec` include the turn by construction. `carryNote` is the routine-scoped read-back `{ note, contentHash, updatedAtMs }`, or null when no loop exists; use its hash to reconcile an uncertain `loop:checkpoint` transport result. jq / code:run reducers must descend through `.loop`; assuming root-level active/interval fields iterates null (EI-21197839138727609).\n\n" +
      "`rewake` is the SAME classifier loop:checkpoint's continuation gate uses. `rewakeGuaranteed:false` on an ACTIVE loop names why the next turn is not guaranteed: `last-fire-parked` (the newest fire parked undelivered), `last-fire-no-loop-turn` (the latest delivered fire has no loop-origin completion proof after `lastFiredAt`), `fire-starved`, or an exhausted maxFires/maxDurationSec bound. A later loop:arm does not clear that failure; a delayed loop turn clears it only when `lastFailedFireLoopTurnCompletedAt` is strictly later than `lastFiredAt`. Do not settle a turn on an active loop whose rewake is false; inspect and repair the delivery-to-turn path before settling. Null when no loop exists.\n\n" +
      "REACHABILITY SCOPE (EI-21452056705704146): `reachability` reports the standing owner wake path even when `loop:null`, including the host-registered inbox-wake waiter. `pendingAwaits.scope:'non-inbox-wake'` deliberately excludes that always-armed host channel and measures only caller-authored park awaits; its `status:'none'` is NEVER evidence that the owner is globally unreachable.\n\n" +
      "The loop record for the owner (active, intervalSec, parked, nextFireAt, lastFiredAt, fireCount, firesSinceArm, cost-cap), or null when no loop exists.\n\nFields that change what you should DO:\n• `firesSinceArm` vs `maxFires` (WI-36070) — the ONLY valid dead-man comparison. `fireCount` is a LIFETIME counter and a re-arm resets the budget, so `fireCount > maxFires` on an active loop is the EXPECTED reading, not a breached bound. Comparing those two reports a healthy loop as already-halted, and hides a loop one fire from going silently inert (EI-19899671638499010).\n• `turnsStalled` (EI-18712914572668391) — true when fires keep landing (fireCount climbing) but `lastTurnAt` (the most recent real turn-completion marker) isn't keeping pace, e.g. a wedged wake channel. This is the armed-but-not-PRODUCING case: `stalled` alone only catches a PARKED in-flight turn stuck past its dwell window, so a loop can be firing on schedule and doing nothing while `stalled` stays false.\n• `storeIdentityViolation` (EI-19384072467112035) — a `null` loop alongside this block means the process was reading from the WRONG database when it looked. Treat that null as UNKNOWN, NOT as \"no loop\", and do NOT re-arm on the strength of it alone: re-arming on a misread is how a live loop gets duplicated.\n• `pendingAwaits` (EI-19415169477907694) — your OWN live non-inbox-wake events:await registrations right now, so \"am I actually parked?\" is answerable after a call whose response you never trust (a dropped MCP transport, a backgrounded/failed events:await). `status:'found'` with a sample of keys means a registration IS live; `status:'none'` means NOTHING is registered — the loud signal that a believed-successful await never actually landed; `status:'unknown'` means the lookup itself failed and must NEVER be read as 'none'.\n• `monitor` / `monitorStanddown` (mode:'monitor' only) — `monitor.remainingNoDeltaBudget` is how many QUIET wakes this monitor has left before the engine stands it down; `monitorStanddown` explains an `active:false` monitor (`no_delta_budget_exhausted` or `authority_lost` + the admission code). Report a delta with `loop:checkpoint { monitorDelta: true }` to reset the budget.\n• Cadence (EI-20217869515819188) — compare `expectedFiresSinceArm` with `firesSinceArm` to see how many interval-sized opportunities elapsed versus attempted fires. `effectiveIntervalSec` and `cadenceRatio` expose a slow fire path (`cadenceRatio` > 1 means slower than configured; > 3 is a warning), and `longestObservedGapSec` reports the largest arm-scoped wake gap. A null cadence field means insufficient timestamps/history, never zero.",
    notWhen:
      'See the WORK a loop is producing — that is fleet:assignments (the self-assigned work_items). Whole-engine health — autoloop:status.',
    chaining: 'loop:arm to start; loop:end to stop.',
    seeAlso: ['loop:arm (start a loop)', 'loop:end (stop it)', 'fleet:assignments (the work the loop is producing)'],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  // EI-20229292848756531: this read performs independent DB probes
  // (loop status, wake reachability, and pending awaits) and never consumes
  // ctx.tx. Do not hold the dispatcher's ambient org-app transaction across
  // those awaits; pool contention would make loop:status itself time out at
  // withWorkspace:acquire(app).
  skipWorkspaceTx: true,
  // loop:status is a model-facing liveness read whose complete diagnostics can
  // legitimately exceed the generic per-result/aggregate door during a
  // parallel reconciliation fan-out. Keep its JSON envelope intact so the
  // caller can inspect the full loop record instead of receiving an
  // aggregate-output-budget-exceeded spill reference.
  skipResultDoor: 'oversize-by-design',
  agentRoles: [...COORD_ROLES],
  args: z.object({
    // EI-21137205137669557 (repeatCount 9, plus 4 duplicate filings): this arg
    // used to be REJECTED, and the rejection was the single most-repeated
    // caller error on this tool. `loop:end` had already settled the same
    // question the other way — accept and ignore — so `loop:status` was the
    // lone sibling in its own family that hard-errored on a harmless arg.
    // Ignoring it is safe by code truth, not by convention: getLoopStatuses
    // selects `WHERE r.target_owner_id = ANY(...)` with no harness/install
    // predicate at all, so a `harness` value could not change the answer.
    harness: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Accepted for compatibility and IGNORED — loops are keyed by owner, not by harness, so this has no effect. Present only because nearly every other tool in this catalog takes a `harness` arg and callers reasonably reach for it out of habit; omit it, or pass anything.',
      ),
    ownerId: z
      .string()
      .max(120)
      .optional()
      .describe("Inspect the loop for this owner id, or 'self' for the caller (default: yourself). Mirrors loop:arm/end/checkpoint."),
    // tool-contract-repair-2026-09-05 P-005 / EI-21206535634211412. `owner` is an
    // unambiguous synonym here: this tool has exactly one selector, so there is no
    // second meaning `owner` could collide with (the ALIAS-vs-BETTER-ERROR test the
    // plan sets — contrast work_items:get's `limit`, where the caller's word plausibly
    // means a DIFFERENT count than the declared arg and aliasing would answer the
    // wrong question). Explicit `ownerId` wins when both are supplied.
    owner: z
      .string()
      .max(120)
      .optional()
      .describe('Compatibility alias for `ownerId`; explicit `ownerId` wins when both are supplied.'),
  }),
  result: z
    .object({
      ok: z.unknown().optional(),
      ownerId: z.unknown().optional(),
      loop: z.unknown().optional(),
      lastTransition: z.unknown().optional(),
      carryNote: z.unknown().optional(),
      reachability: z.unknown().optional(),
      pendingAwaits: z.unknown().optional(),
      storeIdentityWarning: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Resolve the documented self selector before querying. Passing the literal
    // through would read a plausible but unrelated row whose ownerId is "self"
    // instead of this caller's loop (EI-22564327654701627).
    const ownerId =
      resolveSelfLiteral(args.ownerId ?? args.owner, identity.ownerId) ?? identity.ownerId;
    const status = await getLoopStatus(ownerId);

    // EI-21869094231635430: these four probes are each independent of the OTHERS
    // (only lastTransition/carryNote depend on `status`, already resolved above) —
    // they used to run as five SEQUENTIAL awaits, so their wall-clock cost SUMMED.
    // Under DB pool contention (this box runs a large concurrent fleet), summing
    // four-to-five round-trips on a lightweight per-owner status read is exactly
    // how it accumulates past the 5s per-statement timeout or the 16s whole-call
    // deadline — the recorded failure mode (harness_shared.tool_invocations shows
    // 9 genuine `canceling statement due to statement timeout` errors on this tool
    // between 09:17 and 13:07 on 2026-08-30, none attributable to a single slow
    // query). Running them concurrently bounds the wall-clock cost to the SLOWEST
    // probe instead of their sum, and shortens how long any one probe's DB
    // connection is held open under contention. Each retains its exact original
    // fail-soft behavior (see the per-branch comments below) — only the scheduling
    // changed, never the semantics.
    const [lastTransition, carryNote, reachability, pendingAwaitsResult] = await Promise.all([
      status
        ? readLatestLoopTransition({
            workspaceId: identity.workspaceId,
            installSlug: status.harnessSlug,
            routineName: status.name,
            targetOwnerId: ownerId,
          })
        : Promise.resolve(null),
      // EI-21380031331878722: loop:checkpoint may commit and lose its transport
      // response after connect. Surface the same routine-scoped carry-note read and
      // content hash here so the caller can reconcile that outcome without guessing
      // or blindly retrying a replacement note. The routine's install slug is the
      // authoritative carry-note harness, just as it is for the cold wake reader.
      status
        ? getLoopCarryNoteWithMeta({ harness: status.harnessSlug, ownerId })
            .then((meta) => ({
              note: meta.note,
              contentHash: meta.note === null ? null : shortCarryHash(meta.note),
              updatedAtMs: meta.updatedAtMs,
            }))
            .catch(() => ({ note: null, contentHash: null, updatedAtMs: null }))
        : Promise.resolve(null),
      // WI-655 / EI-21452056705704146 — surface LIVE wake-reachability independently
      // of whether a loop row exists. A paused/idle session can be deliberately
      // loopless while the host-registered inbox-wake await remains its one correct
      // resume channel. Gating this probe on status?.active made that healthy state
      // read as reachability:null + pendingAwaits:none, which falsely looked globally
      // unreachable and nudged agents to arm a forbidden loop during stand-down.
      // Best-effort: probeWakeReachability already degrades its component reads.
      probeWakeReachability(ownerId).catch((): WakeReachabilityVerdict | null => null),
      // EI-19415169477907694: "am I actually parked?" — the caller's own live, non-inbox-wake
      // events:await registrations. Answers the exact filed failure: a dropped MCP transport
      // (or any await call whose response the caller cannot trust) can leave an agent believing
      // it registered a park when nothing was ever written. Run unconditionally (not gated on
      // loop.active) — an agent that never armed a loop and instead parked on a bare events:await
      // deserves this answer too. Best-effort + fail-soft, same discipline as reachability above
      // and as loop:arm's own use of this exact read (EI-19447204017443244): a lookup failure
      // must read as 'unknown', never collapse into 'none' (that would fabricate a measurement).
      listWakeAwaitsForSubscriber(ownerId)
        .then(
          ({ totalCount, sample }): LivePushChannels =>
            totalCount > 0
              ? { status: 'found', count: totalCount, sample: sample.slice(0, 5).map((a) => a.eventKey) }
              : { status: 'none' },
        )
        .catch((): LivePushChannels => ({ status: 'unknown' })),
    ]);

    const reachabilityOut = reachability
      ? {
          reachable: reachability.reachable,
          channel: reachability.channel,
          durableWhileAlive: reachability.durableWhileAlive,
          summary: reachability.summary,
          ...(reachability.warning ? { warning: reachability.warning } : {}),
        }
      : null;

    // The standing host inbox-wake is a reachability channel, not evidence that a
    // caller-authored events:await landed. Keep the useful exclusion, but stamp the
    // scope on the wire so status:none can no longer be misread as global absence.
    const pendingAwaitsOut = { ...pendingAwaitsResult, scope: 'non-inbox-wake' as const };

    // EI-19384072467112035: a `loop: null` here is the documented "no loop exists" signal,
    // and an agent reading it correctly re-arms. But `getLoopStatus` reads through
    // `getOrgPg()`, which can (per plan outage-must-not-be-silent-2026-08-02) be talking to
    // a DIFFERENT, freshly-initdb'd store than the one this process pinned — in which case
    // "no row for this owner" is a correct answer from the WRONG database, not evidence the
    // loop is gone. Only checked on the null/negative path: a found row is trustworthy
    // regardless (a match against another store's data, by a snowflake-shaped owner id, is
    // not a realistic false positive), so this can never make a healthy `loop:null` noisier.
    // `storeIdentityViolation()` is non-null only after two successfully-read, genuinely
    // different cluster identities — never on a failed/absent probe — so it cannot fire
    // spuriously either. Mirrors dev:pg_health's delivery of the same guard (D-004: DETECT
    // already existed everywhere: the gap was always that nobody surfaced it where an agent
    // was actually looking).
    let storeIdentityWarning: {
      severity: 'critical';
      headline: string;
      whatThisMeans: string;
      detail: string;
    } | null = null;
    if (status === null) {
      const violation = storeIdentityViolation();
      if (violation) {
        storeIdentityWarning = {
          severity: 'critical',
          headline:
            'WRONG STORE — this null may not mean "no loop exists". This process has talked to a different database than the one it pinned.',
          whatThisMeans:
            'Do NOT treat this loop:null as "no loop is armed" and re-arm on its strength alone — that risks a duplicate loop if the real store (with the real loop row) becomes reachable again moments later. Re-check after confirming the store is healthy (dev:pg_health), or via fleet:assignments / coord:presence for corroborating signs the owner already has an active loop.',
          detail: describeStoreIdentityMismatch(violation.pinned, violation.observed),
        };
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ownerId,
            loop: status,
            // P-013 / EI-24023838400909760: an active loop is not a re-wake guarantee
            // when its last fire parked (or a dead-man bound is spent). One classifier,
            // shared with loop:checkpoint's continuation gate, so the two cannot disagree.
            rewake: status
              ? (() => {
                  const verdict = classifyLoopNextWake(status);
                  return { rewakeGuaranteed: verdict.guaranteed, reason: verdict.reason };
                })()
              : null,
            lastTransition,
            // WI-10004466: the withheld-wake state, stated at top level. `rewake` reads
            // guaranteed during an await suppression (a wake IS scheduled, just late), and
            // the cadence fields reflect the delay without naming it.
            awaitSuppression: status
              ? deriveActiveAwaitSuppression(lastTransition, status.nextFireAt, Date.now())
              : null,
            carryNote,
            reachability: reachabilityOut,
            pendingAwaits: pendingAwaitsOut,
            ...(storeIdentityWarning ? { storeIdentityWarning } : {}),
          }),
        },
      ],
    };
  },
});
