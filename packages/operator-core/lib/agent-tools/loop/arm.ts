/**
 * loop:arm — arm an engine-managed LOOP on your OWN session (or another
 * owner's, with `ownerId` — WI-1471): the tracked, restart-surviving,
 * observable replacement for Claude Code's built-in `/loop` for su/interactive
 * agents (loop-routines-interval-recurrence-2026-06-20, B-LOOP-5 / P-008).
 *
 * Each fire re-wakes THIS warm session ~intervalSec AFTER the previous turn
 * settles (a `coord:send {wake}` to the caller's ownerId, riding the wake-executor
 * liveness ladder — inject if live, `claude --resume` if exited; B-LOOP-3) — NOT
 * a fresh cold run, so the conversation/context carries across iterations. The
 * loop is a durable `harness_shared.routines` row, so it survives operator
 * restarts, is observable (loop:status + fleet:assignments + fire-history), and
 * inherits the engine guardrails (failure-streak fire-gate + an optional
 * cost-cap). End it with loop:end.
 *
 * This is the user-directed counterpart to the autonomous queen/bee/scout loop,
 * which is a SEPARATE system (pot:declare-wake) and is out of scope here (plan
 * D-007) — do not use loop:arm from an autonomous-fleet agent. (Its Kettle half,
 * `kettle:declare-wake`, retired with the tier — retire-mug-kettle-su-only-2026-08-09
 * P-059/D-080.)
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import { resolveHomePotSlug } from '../pot/_resolve';
import { isParkedNextFire } from '@papercusp/db-org';
import {
  materializeLoop,
  buildLoopWakePrompt,
  detectDrivenWorkItemId,
  readActiveLoopFacts,
  type PriorLoopFacts,
  LOOP_INTERVAL_FLOOR_SEC,
} from '../../harness/routines/loop';
import {
  resolveBlockedSince,
  suggestBlockerRef,
  type LoopBlockedOnRecord,
} from '../../harness/routines/loop-blocker-liveness';
import {
  claimWorkItem,
  classifyClaimFailure,
  getWorkItem,
  isClaimHoldParked,
  isSelfOwnerRecord,
} from '../../work-items';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import { hasLiveExactAwaitForSubscriberKey, listWakeAwaitsForSubscriber } from '../../events/await/store';
import { probeWakeReachability, type WakeReachabilityVerdict } from '../../events/await/wake-reachability';
import {
  readEventConditionReachability,
  type ExternalConditionReachability,
} from '../../external-condition-reachability';
import { softText, clampText } from '../limits';
import { refreshControlAnchorAfterMutation } from '../coordination/control-anchor';
import { getSessionBrief } from '../../session-brief';
import { lintCarrySurfaceProvenance } from '../../carry-surface-provenance-lint';
import { acceptancePlaneAdvisoryForWait, mainWaitPlanReviewForWait } from '../../acceptance-runtime-wait-guard';
import { getLoopCarryNoteWithMeta } from '../../carry-note';
import {
  admitMonitorArm,
  monitorPredicateDedupRefusal,
  monitorArmConfigSchema,
  prepareMonitorConfig,
  type PersistedMonitorConfig,
} from '../../harness/routines/monitor-policy';

const MAX_LOOP_INTERVAL_SEC = 60 * 60 * 24 * 7; // 7 days — beyond this, use a schedule (a fixed clock), not a loop

/**
 * EI-19395290807657827 — the SELF-SEALING BACKOFF. An agent's only backoff lever is a
 * longer interval, but a longer interval is exactly what removes its ability to observe
 * the blocker CLEARING: the wider you set it because you are blocked, the longer you keep
 * sleeping after you stop being blocked. Nothing in the loop re-evaluates the premise the
 * interval was chosen under.
 *
 * Measured 2026-08-03 on fleet nonp2p-bug-drain-0801: FIVE members re-armed at a ~2 HOUR
 * interval inside a 32-SECOND window — the clustering proving it was one shared reaction
 * (an 8h-red gate), not five independent judgments. The gate was fixed and re-fired by
 * 01:54Z; they would have slept until 03:58Z regardless. Cost: ~9 agents x ~1h idle
 * against 70 claimable items, on a fleet whose entire mission was draining that queue.
 * Only an external actor (the leader, hand-waking all 10) broke it — none were dead, all
 * were merely asleep on a timer. The persona already says "restore the cadence the instant
 * the blocker clears", but that is UNACTIONABLE from inside a sleeping agent: restoring
 * requires a wake, and the wake is precisely what was postponed.
 *
 * The fix makes the persona's own push-beats-polling rule enforceable, via an INCENTIVE
 * rather than a refusal — name the blocker's event and keep your long interval only when
 * the event authority proves that key reachable (the clear can then push a wake); an
 * unknown or impossible key is treated like no event and the interval is CAPPED, because
 * an agent that cannot be pushed must at least poll often enough to notice. Either way
 * the premise is written into the KICKOFF, which is re-delivered on every wake, so the
 * next wake re-checks the specific condition instead of silently inheriting it.
 */
const BLOCKED_INTERVAL_CAP_SEC = 15 * 60;

/** What the caller declared it is blocked on, when it widened the interval. */
export interface LoopBlockedOn {
  reason: string;
  event?: string;
}

export interface BlockedBackoffResolution {
  /** The interval to actually arm — capped when the backoff has no push channel. */
  intervalSec: number;
  /** True when the cap was applied (i.e. the requested interval was reduced). */
  clamped: boolean;
  /** Arm-time evidence for a named clearing event, or null when none was named. */
  eventReachability: ExternalConditionReachability | null;
  /** Advisory line for the response, or null when nothing needs saying. */
  note: string | null;
  /**
   * Premise text to inject into the KICKOFF so it is re-delivered on EVERY wake. This is
   * the actual auto-restore mechanism: the sleeping agent cannot re-read this tool's
   * response, but it always re-reads its wake prompt.
   */
  wakePremise: string | null;
}

/**
 * EI-19447204017443244: what the ARM-TIME lookup of the caller's own live wake-capable
 * awaits found. Purely descriptive — it changes the MESSAGE, never the cap (the item
 * chose that explicitly: the nudge toward a catalogued clearing event is what actually
 * helps, so the fix is to stop asserting an unchecked premise, not to relax the guard).
 *
 * `unknown` is the DEFAULT precisely because it is the honest state when the lookup was
 * not run or failed. It must never collapse into `none`: "I did not look" and "I looked
 * and there was nothing" are different claims, and printing the second for the first is
 * the exact defect this whole change exists to remove.
 */
export type LivePushChannels =
  | { status: 'none' }
  | { status: 'found'; count: number; sample: readonly string[] }
  | { status: 'unknown' };

function unmeasuredEventReachability(): ExternalConditionReachability {
  return {
    verdict: 'unknown',
    basis: 'unmeasured',
    authoritative: false,
    evidence: 'event reachability was not measured at arm time',
    checkedAt: new Date().toISOString(),
  };
}

function eventReachabilityEvidence(
  event: string,
  reachability: ExternalConditionReachability,
): string {
  const verdict =
    reachability.verdict === 'reachable'
      ? 'reachable'
      : reachability.verdict === 'impossible'
        ? 'proven unreachable'
        : 'not proven reachable';
  return `Reachability check for \`${event}\`: ${verdict} (${reachability.basis}) — ${reachability.evidence}.`;
}

/**
 * PURE: resolve a blocker-motivated interval. Omitting `blockedOn` preserves the exact
 * pre-existing BEHAVIOUR (no cap, no premise, interval untouched) — since P-006/D-098 it
 * may return an advisory `note`, but nothing that changes what the loop does.
 *
 * `livePush` (EI-19447204017443244) is an OPTIONAL arm-time observation supplied by the
 * handler; omitting it yields `unknown`, which is why every pre-existing caller and test
 * is untouched by this parameter.
 *
 * `eventReachability` (EI-22323707896569406) is required for a named event to bypass the
 * cap. Missing or failed reachability is deliberately represented as `unknown`, never
 * treated as proof that the caller can be pushed.
 */
export function resolveBlockedBackoff(
  requestedIntervalSec: number,
  blockedOn?: LoopBlockedOn | null,
  livePush: LivePushChannels = { status: 'unknown' },
  eventReachability?: ExternalConditionReachability | null,
): BlockedBackoffResolution {
  if (!blockedOn) {
    // P-006 / D-098 — SURFACE THE AFFORDANCE AT THE ONE MOMENT IT IS ACTIONABLE.
    //
    // `blockedOn` was built, is strictly better than a prose-matching auto-attach, and
    // measured 0 uses in 294 arm calls across 91 distinct arming agents (14d). Zero, not
    // low. It is optional and nothing ever asks for it — D-016's shape exactly, so it got
    // the adoption prose earns.
    //
    // ⚠ THE TRIGGER IS THE INTERVAL, NEVER THE GOAL TEXT, and that is a ruling not a
    // preference (D-098). Matching the goal prose was P-006's original proposal and it is
    // undecidable here: of 292 armed goals, 182 are work-pull/drain loops where a loop is
    // CORRECT, and 117 (40%) match the drain AND blocker vocabularies simultaneously — a
    // drain loop that mentions a gate in passing is textually identical to a gate-watch
    // loop. Every false positive would nudge an agent toward parking a loop that must keep
    // pulling. The interval is a STRUCTURAL signal and needs no matcher.
    //
    // Threshold reuses BLOCKED_INTERVAL_CAP_SEC rather than inventing a second constant, so
    // the nudge fires exactly where the cap WOULD have applied had the blocker been
    // declared — i.e. on loops that took the widening without the annotation that governs
    // it. Measured: 115 of 292 arms (39%) sit at or above it, p90 1800s, max 4200s; the
    // 65 arms at <=60s never see this.
    //
    // Advisory ONLY — no cap, no premise, no behaviour change. An undeclared long interval
    // is legitimate (a genuinely slow cadence), so this must inform and never obstruct.
    if (requestedIntervalSec >= BLOCKED_INTERVAL_CAP_SEC) {
      return {
        intervalSec: requestedIntervalSec,
        clamped: false,
        eventReachability: null,
        note:
          `⏸ ${requestedIntervalSec}s is a WIDE interval. If you widened it because you are waiting on something, ` +
          `say so: loop:arm { blockedOn: { reason, event } }. A clearing event whose reachability is proven at arm time ` +
          `(events:catalog lists the known families) keeps your interval AND re-checks the premise on every wake; ` +
          `an unknown or impossible event, or naming only a reason, caps the interval at ${BLOCKED_INTERVAL_CAP_SEC}s ` +
          `so a cleared blocker cannot leave you asleep (EI-19395290807657827). ` +
          `⚠ Park on the event IN ADDITION to this loop, never instead of it — a parked await suppresses these ` +
          `fires, so an await on an event that never fires (a gate that goes red, say) removes your only way back ` +
          `(WI-6595). If the cadence is simply slow by design, ignore this.`,
        wakePremise: null,
      };
    }
    return {
      intervalSec: requestedIntervalSec,
      clamped: false,
      eventReachability: null,
      note: null,
      wakePremise: null,
    };
  }

  // A named event is safe only when the event authority proves it reachable. A plausible
  // string, a missing registration, or a failed lookup is not enough to remove the timer
  // backstop — that was the exact self-sealing failure this item measured.
  if (blockedOn.event) {
    const resolvedEventReachability = eventReachability ?? unmeasuredEventReachability();
    const reachabilityText = eventReachabilityEvidence(blockedOn.event, resolvedEventReachability);
    if (resolvedEventReachability.verdict !== 'reachable') {
      const capped = Math.min(requestedIntervalSec, BLOCKED_INTERVAL_CAP_SEC);
      const clamped = capped < requestedIntervalSec;
      const capReason =
        resolvedEventReachability.verdict === 'impossible'
          ? `the named clearing event is proven unreachable, so it cannot push a wake and the timer is the only way back`
          : `the named clearing event was not proven reachable, so the timer is the only backstop this arm can trust`;
      return {
        intervalSec: capped,
        clamped,
        eventReachability: resolvedEventReachability,
        note: clamped
          ? `⏸ Backoff recorded: blocked on "${blockedOn.reason}". Interval CAPPED ${requestedIntervalSec}s → ${capped}s ` +
            `${reachabilityText} ${capReason} — a wider interval could leave you asleep after the blocker clears. ` +
            `Use a catalogued, reachable clearing key before re-arming a longer interval, and park on it with ` +
            `events:await { event: '${blockedOn.event}', timeout_sec, on_timeout: 'wake' }.` +
            ` (EI-22323707896569406)`
          : `⏸ Backoff recorded: blocked on "${blockedOn.reason}". Interval ${capped}s is within the ` +
            `${BLOCKED_INTERVAL_CAP_SEC}s cap because ${reachabilityText.toLowerCase()} ${capReason}.`,
        wakePremise:
          `You widened this loop's interval because you were BLOCKED ON: "${blockedOn.reason}". ` +
          `RE-CHECK THAT PREMISE FIRST, before anything else — it may have cleared while you slept. ` +
          `${reachabilityText} Do not rely on \`${blockedOn.event}\` as the only wake until it is proven reachable. ` +
          `If the blocker has cleared, RESTORE your normal cadence immediately (re-arm without blockedOn).`,
      };
    }

    // The named event is backed by a catalogued/live/fired authority, so the clear can
    // push a wake and the long interval is no longer self-sealing. The timer remains a
    // backstop, not the only way back.
    return {
      intervalSec: requestedIntervalSec,
      clamped: false,
      eventReachability: resolvedEventReachability,
      note:
        `⏸ Backoff recorded: blocked on "${blockedOn.reason}" — interval honoured as ${requestedIntervalSec}s because ` +
        `${reachabilityText} ` +
        `NOW ACTUALLY PARK ON IT: events:await { event: '${blockedOn.event}', timeout_sec, on_timeout: 'wake' } — naming the event here does NOT register the await, and an unparked long interval is the self-sealing backoff this field exists to prevent (EI-19395290807657827).`,
      wakePremise:
        `You widened this loop's interval because you were BLOCKED ON: "${blockedOn.reason}". ` +
        `RE-CHECK THAT PREMISE FIRST, before anything else — it may have cleared while you slept. ` +
        `${reachabilityText} It should push a wake via \`${blockedOn.event}\`; if it has cleared, RESTORE your normal cadence immediately (re-arm without blockedOn) rather than continuing at the widened interval.`,
    };
  }

  // No event to be pushed by ⇒ the timer is the ONLY way back, so it must stay short
  // enough to notice a clear. Cap rather than refuse: backing off is legitimate, and a
  // refusal would just push agents back to the un-annotated widening this replaces.
  const capped = Math.min(requestedIntervalSec, BLOCKED_INTERVAL_CAP_SEC);
  const clamped = capped < requestedIntervalSec;

  // EI-19447204017443244 — THE CLAIM IS SCOPED TO THIS LOOP, which is what makes it
  // true by construction. The old text said "nothing can push you a wake" flatly, and
  // that is a statement about the caller's WHOLE wake surface, which this function had
  // never looked at: a caller holding a live `state:subscribe` watch was told, as fact,
  // that no push channel existed. Saying "no clearing event was named FOR THIS LOOP, so
  // nothing will push you a wake WHEN IT CLEARS" keeps every ounce of the nudge while
  // asserting only what the cap actually knows — a separately-registered await is not
  // wired to this blocker, which is the very reason the cap still applies.
  const capReason =
    `because you named no clearing event for this loop, so nothing will push you a wake when it clears and the timer is your only way back ` +
    `— a wider interval would just mean sleeping longer AFTER the blocker clears (EI-19395290807657827). `;

  // The arm-time observation, attached ONLY in the branch that actually made it.
  // `unknown` adds nothing: the base sentence above is already true without a lookup,
  // so silence is the honest rendering of "not measured" (never a fabricated "none").
  const livePushNote =
    livePush.status === 'found'
      ? ` ⓘ FWIW you DO hold ${livePush.count} live wake-await(s) right now (${livePush.sample.map((k) => `\`${k}\``).join(', ')}) — ` +
        `this tool cannot tell whether any of them fires on THIS blocker, so it still capped. If one of them IS your clearing signal, re-arm with blockedOn.event naming it.`
      : livePush.status === 'none'
        ? ` (Checked: apart from your standing inbox-wake you hold no live wake-awaits, so this is measured, not assumed.)`
        : '';

  return {
    intervalSec: capped,
    clamped,
    eventReachability: null,
    note: clamped
      ? `⏸ Backoff recorded: blocked on "${blockedOn.reason}". Interval CAPPED ${requestedIntervalSec}s → ${capped}s ` +
        capReason +
        `To keep a longer interval, pass blockedOn.event with the events:catalog key that fires on the clear (events:catalog lists them) and park on it with events:await.` +
        livePushNote
      : `⏸ Backoff recorded: blocked on "${blockedOn.reason}". Interval ${capped}s is within the ${BLOCKED_INTERVAL_CAP_SEC}s cap for a backoff with no clearing event.`,
    // The premise is re-injected on EVERY wake, arbitrarily later — so it deliberately
    // names NO specific await. A once-await fires and is gone; "you hold watch #44071"
    // would be a fresh false claim of this same class, merely time-shifted.
    wakePremise:
      `You widened this loop's interval because you were BLOCKED ON: "${blockedOn.reason}". ` +
      `RE-CHECK THAT PREMISE FIRST, before anything else — it may have cleared while you slept. ` +
      `No clearing event was named for this loop, so NOTHING will push you a wake when this blocker clears: this timer is the only way you find out. ` +
      `If it has cleared, RESTORE your normal cadence immediately (re-arm without blockedOn).`,
  };
}

/** Cosmetic short form for an overridden owner id (display only, never keyed
 *  on) — mirrors resolveAgentIdentity's own `shortId` formatting so an
 *  ownerId-override loop's label reads the same as a self-armed one. */
function shortOwnerLabel(id: string): string {
  if (id.startsWith('pus-')) return id.slice(0, 12);
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * EI-21424742792137469: carry is an owner/fleet launch policy, not a property of
 * whether this process happens to have a TTY. A headless fleet launched with the
 * standing warm default must not silently become cold when a member later calls
 * loop:arm without repeating that option. Fresh arms therefore always default to
 * warm. Cold remains available only as an explicit opt-in, while a re-arm with an
 * active prior loop preserves that loop's already-chosen carry below.
 */
const FRESH_LOOP_DEFAULT_CARRY = 'warm' as const;

// The shared carry-surface lint also uses `manual-owner-tag` for an unbracketed
// `owner directive` noun phrase. loop:arm's replay guard is narrower: it exists
// to stop a literal `[owner:…]` tag from laundering a goal into owner speech,
// not to reject ordinary prose that happens to discuss ownership or directives.
const BRACKETED_OWNER_TAG_RE = /\[\s*owner\b\s*[:=\-]?\s*[^\]]+\]/i;

/** Normalize free text for a loose goal-containment check (case/whitespace-insensitive). */
function normalizeLoopText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The surfaced comparison when a re-arm materially changes an ACTIVE loop's goal
 *  (EI-18221784742583615). Advisory only — the loop is still (re-)armed. */
export interface LoopOverwriteNote {
  priorIntervalSec: number | null;
  priorFireCount: number;
  priorCarry: 'warm' | 'cold';
  priorMode: 'work' | 'monitor';
  priorArmedAt: string | null;
  priorKickoffExcerpt: string;
  intervalChanged: boolean;
  /** EI-21542193720279374: true when this re-arm moves the loop's harness away
   *  from `prior.harnessSlug`. A harness move silently orphans the
   *  harness-scoped carry-note (arm.ts:688 already prevents an IMPLICIT move
   *  for an active prior loop, but an EXPLICIT `harness` override on a re-arm
   *  still moves it deliberately) — surfaced here for the same reason a goal
   *  swap is: so the arming agent sees what it is about to detach, instead of
   *  discovering it only when the next cold wake resets blind. */
  harnessChanged: boolean;
  message: string;
}

/** True for a caller-usable harness slug — not null/empty and not the
 *  wildcard/all-workspaces sentinel. Mirrors the identical check the arm
 *  handler keeps closure-scoped (isConcreteHarness, ~line 522); duplicated
 *  here at module scope only because this pure decision function must not
 *  depend on handler-local state. */
function isConcreteHarnessSlug(value?: string | null): value is string {
  const trimmed = value?.trim().toLowerCase();
  return Boolean(trimmed && trimmed !== '*' && trimmed !== 'all');
}

/**
 * EI-18221784742583615 — the PURE arm-time overwrite decision. loop:arm is an UPSERT
 * keyed on (owner, name), so re-arming REPLACES the owner's single loop row wholesale.
 * A stale/replayed fleet-kickoff turn (an expired-nonce envelope redelivered ~25h late)
 * could therefore silently clobber an ACTIVE, specialized, long-running loop (rich
 * checkpoint state, high fireCount, e.g. a 1200s WI-5672 watch) with a generic goal and
 * a fast 120s cadence — the arming agent, taking the stale premise at face value before
 * reading its own held work-items, never saw what it replaced.
 *
 * Given the prior active loop's facts and the incoming arm, decide whether the re-arm
 * MATERIALLY changes the loop's GOAL or HARNESS — either is harmful — and, if so,
 * produce the comparison to surface. Returns null (no warning — the loop still arms)
 * when:
 *   - there is no prior loop, or it is not active (a fresh start / re-arm over an ended
 *     loop is fine); OR
 *   - the harness is unchanged AND the newly-built kickoff equals the prior kickoff (an
 *     identical re-arm); OR
 *   - the harness is unchanged AND the new goal text already appears in the prior kickoff
 *     (the default template embeds `{goal}`, so an interval-only / carry / mode retune —
 *     the normal in-turn re-arm — keeps the goal and is NOT flagged).
 * A goal SWAP or a HARNESS MOVE (new harness concrete and different from
 * `prior.harnessSlug`, both resolved) surfaces the note — EI-21542193720279374: kickoff
 * text never encodes harness, so a same-goal harness move used to pass the
 * identical-kickoff / goal-preserved shortcuts above and skip the warning entirely, even
 * though moving harness silently orphans the harness-scoped carry-note (arm.ts:688 only
 * prevents an IMPLICIT move for an active prior loop; an explicit `harness` override on a
 * re-arm still moves it deliberately, with no disclosure). Pure + exported for unit
 * tests, mirroring computeLoopStall.
 */
export function computeLoopOverwriteNote(
  prior: PriorLoopFacts | null,
  next: { goal: string; intervalSec: number; kickoff: string; harnessSlug?: string | null },
): LoopOverwriteNote | null {
  if (!prior || !prior.active) return null;
  const harnessChanged =
    isConcreteHarnessSlug(prior.harnessSlug) &&
    isConcreteHarnessSlug(next.harnessSlug) &&
    prior.harnessSlug.trim().toLowerCase() !== next.harnessSlug.trim().toLowerCase();
  const priorKickoffNorm = normalizeLoopText(prior.kickoff);
  // Identical re-arm (same built kickoff, incl. a re-armed custom wakePrompt) AND no
  // harness move: the same loop, unchanged — no warning. A harness move alone leaves
  // kickoff text untouched, so it must be checked independently of this shortcut.
  if (priorKickoffNorm === normalizeLoopText(next.kickoff) && !harnessChanged) return null;
  const nextGoal = normalizeLoopText(next.goal);
  // EI-20248422377293824: a custom wakePrompt (or a legacy kickoff shape) may
  // not render the mission text, so kickoff containment alone cannot recognize
  // a carry-only re-arm that preserved the structurally stored goal.
  const priorGoal = normalizeLoopText(prior.goal ?? '');
  const goalPreserved =
    (priorGoal.length > 0 && priorGoal === nextGoal) ||
    // Goal preserved (present verbatim in the prior kickoff)? Then only interval/carry/mode
    // changed — a deliberate retune, not a goal swap.
    (nextGoal.length > 0 && priorKickoffNorm.includes(nextGoal));
  if (goalPreserved && !harnessChanged) return null;
  const intervalChanged = prior.intervalSec != null && prior.intervalSec !== next.intervalSec;
  const excerpt = prior.kickoff.trim().slice(0, 240);
  const harnessClause = harnessChanged
    ? ` — harness '${prior.harnessSlug}' → '${next.harnessSlug}': the existing carry-note is` +
      ` scoped to the OLD harness and will NOT travel with it; a future cold wake resets` +
      ` BLIND unless you re-checkpoint under the new scope`
    : '';
  const goalClause = goalPreserved ? '' : ` whose goal DIFFERS from the new one`;
  const message =
    `This re-arm OVERWRITES an already-ACTIVE loop (fired ${prior.fireCount}×` +
    `${prior.armedAt ? `, last armed ${prior.armedAt}` : ''})` +
    (intervalChanged ? ` — interval ${prior.intervalSec}s → ${next.intervalSec}s` : '') +
    harnessClause +
    goalClause +
    `. If you did NOT intend to replace it (e.g. this` +
    ` turn came from a stale/replayed kickoff), do NOT proceed on the new goal — check` +
    ` loop:status, then loop:end + re-arm the correct loop. Prior kickoff: "${excerpt}` +
    `${prior.kickoff.length > 240 ? '…' : ''}"`;
  return {
    priorIntervalSec: prior.intervalSec,
    priorFireCount: prior.fireCount,
    priorCarry: prior.carry,
    priorMode: prior.mode,
    priorArmedAt: prior.armedAt,
    priorKickoffExcerpt: excerpt,
    intervalChanged,
    harnessChanged,
    message,
  };
}

function monitorRefusal(error: string, message: string, details?: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ ok: false, error, message, ...(details ? { details } : {}) }),
      },
    ],
    isError: true,
  };
}

export default defineTool({
  name: 'loop:arm',
  profile: 'engineer',
  description:
    'Arm the tracked engine loop for your session (or another ownerId) — the durable replacement for Claude /loop. Each fire re-wakes that warm session after its prior turn settles; context carries across iterations. Observable via loop:status / fleet:assignments and stoppable with loop:end.',
  guidance: {
    when: 'Use for an su/interactive session that should keep advancing a goal on a recurring cadence. Arm it last before ending your turn. Pass ownerId only to arm an already-running, wake-reachable session other than your own.',
    notWhen:
      'Not for wall-clock schedules (plans:set-schedule) or autonomous queen/bee/scout loops (pot:declare-wake). Do not use Claude /loop instead. Not the PRIMARY watcher when the thing you watch already emits — park on it with events:await and keep the loop as the slow backstop.',
    chaining:
      'loop:arm { intervalSec, goal } → end turn → re-wakes each iteration → loop:status to inspect → loop:end to stop.',
    seeAlso: [
      'loop:end (stop the loop — also takes ownerId)',
      'loop:status (inspect it — also takes ownerId)',
      'plans:set-schedule (wall-clock recurrence instead)',
    ],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  // EI-20224334803038640: the handler owns several independent DB scopes
  // (harness resolution, prior-loop reads, optional work-item claiming,
  // routine materialization, and wake reachability). Holding the dispatcher's
  // ambient workspace transaction across those awaits pins an org-app pool
  // slot for the whole arm and can make subsequent loop:arm calls wait until
  // the 45s acquisition deadline. The handler never reads ctx.tx, so keep the
  // ambient transaction out of the long orchestration path.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    ownerId: z
      .string()
      .max(120)
      .optional()
      .describe(
        "Arm the loop for this owner id instead of the caller's own resolved identity (default: yourself). Mirrors loop:end/loop:status's ownerId — the same \"or another owner's\" override, previously missing here (WI-1471).",
      ),
    intervalSec: z
      .number()
      .int()
      .min(LOOP_INTERVAL_FLOOR_SEC)
      .max(MAX_LOOP_INTERVAL_SEC)
      .optional()
      .describe(
        'Seconds AFTER each turn settles before the next wake (≥60). IN AUTO MODE the DEFAULT is 60 (a 1-minute cadence) unless the owner specifies otherwise — only lengthen it when the loop is genuinely blocked on a slower-moving dependency (a deploy, a long gate suite), and restore 1m the moment it clears, because a multi-minute loop is indistinguishable from a dead one to an owner watching for progress. The true period is interval + up-to-30s (the turn-settle is observed on the 30s reconcile tick), so sub-minute is not supported. OMITTED on a retune of an ACTIVE loop: the live interval is inherited, so `loop:arm { carry }` retunes without re-stating it. Required when arming a loop with no active prior.',
      ),
    blockedOn: z
      .preprocess(
        // tool-contract-repair-2026-09-05 P-005 / EI-21266013579763384: callers pass the
        // blocker as a bare string ("blockedOn expected object, received string"). A
        // string can only BE the reason here — `event` is a catalog key the caller would
        // have had to name deliberately — so this is a lossless 1:1 map, the same
        // bare-string shorthand `coerceCarryRowShape` already blesses on carry rows.
        // Empty/whitespace still routes through so `reason.min(1)` names the real problem.
        (v) => (typeof v === 'string' ? { reason: v } : v),
        z.object({
        reason: z
          .string()
          .min(1)
          .max(500)
          .describe('What you are blocked on, in one line (e.g. "green gate red 8h, blocking every deploy").'),
        event: z
          .string()
          .max(200)
          .optional()
          .describe(
            "The events:catalog key that fires when this blocker CLEARS. The key is checked against event authority at arm time: only a proven reachable key bypasses the 15min cap; unknown or impossible keys remain capped with evidence in the result. Naming it does not register the await — actually park on it with events:await { event, timeout_sec, on_timeout:'wake' }. Omit it and the interval is CAPPED to 15min.",
          ),
        // EI-21526226279199560 — the same `kind`/`ref` vocabulary coord's blockedOn uses
        // (D-003), deliberately NOT a second spelling of one concept. Prose cannot be
        // resolved; a ref can, which is what lets each wake re-check the blocker instead
        // of re-reading a frozen sentence.
        kind: z
          .enum(['process', 'event', 'work-item', 'agent', 'owner', 'other'])
          .optional()
          .describe(
            "What KIND of thing you are blocked on — same vocabulary as coord's blockedOn. With kind:'agent' + `ref`, every wake re-checks that agent's sessionState and tells you when it has DIED, so you stop waiting on a corpse.",
          ),
        ref: z
          .string()
          .max(200)
          .optional()
          .describe(
            "The blocker's identity in its own namespace: an ownerId for kind:'agent', a WI-/EI- id for 'work-item', an events:catalog key for 'event'.",
          ),
        }),
      )
      .optional()
      .describe(
        'A bare string is accepted as the `reason`. Pass this WHENEVER you are lengthening the interval because you are BLOCKED (rather than because the work is genuinely slow-moving) — EI-19395290807657827. It records WHY the interval was widened so the premise is re-checked on the next wake instead of silently inherited, caps a blocker-motivated interval whose clearing event is not proven reachable, and lets a fleet leader see "N members backed off for X, which cleared M minutes ago".',
      ),
    goal: softText(4000, { min: 1 })
      .optional()
      .describe(
        "One line: what this loop is working toward — echoed into every wake. Auto-truncated to 4000 chars if longer. OMITTED on a retune of an ACTIVE loop: the live goal is inherited, so a carry-only retune does not re-state it. Required when arming a loop with no active prior.",
      ),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Harness the loop is scoped to / namespaced under. Omit it (or use the workspace-global all/* scope) to resolve the workspace home pot; otherwise defaults to your concrete session harness.',
      ),
    wakePrompt: softText(4000)
      .optional()
      .describe(
        'Advanced: a custom per-wake instruction, replacing the default "create + self-assign your work_items, work them, set_state" template. Most loops should omit this. Auto-truncated to 4000 chars if longer.',
      ),
    workItem: z
      .string()
      .max(120)
      // tool-contract-repair-2026-09-05 P-005 (EI-20248542835326817): `.nullish()`, not
      // `.optional()`, for exactly the reason loop:checkpoint's own `workItem` was widened
      // (EI-21719647580242620) — these two tools share a payload, and an explicit `null` is
      // the shape a shared payload takes for a slot with no value, so `.optional()` refused
      // the case the field exists to serve. arm.ts was the unfixed half of that pair: a
      // fleet wake-recovery carry that armed with `workItem: null` was rejected outright.
      // `null` is an explicit request to clear an active loop's binding; omission preserves
      // that binding during a cadence/goal retune. The handler therefore must distinguish
      // `args.workItem === undefined` from `args.workItem === null` even though both are
      // accepted by the shared nullable payload shape.
      .nullish()
      .describe(
        "The WI-/EI-/F- work-item this WORK loop is driving. For mode:'monitor', pass workItem only when monitor.authority is kind:'work-item' and names this same already-held item. For monitor.authority kind:'fleet-leader' or 'owner-turn', OMIT workItem even if you hold one separately; the fleet/turn authority already governs the monitor. On an active-loop retune, explicit null clears the prior binding while omission preserves it. A work loop attempts to auto-CLAIM a provided item for the loop owner at arm time (WI-2429), subject to fleet-scope admission. When admitted, the item is HELD from wake 1 and a successor/reclaimer inherits it if the session dies. A conflict never steals a live peer's item. If omitted on a COLD work loop, a single WI-/EI-/F- id mentioned in goal is auto-detected and attempted the same way.",
      ),
    carry: z
      .enum(['warm', 'cold'])
      .optional()
      .describe(
        "Loop lifecycle (su-cold-auto-mode-2026-07-03). DEFAULT: 'warm' for every fresh arm, including headless/fleet sessions; choose 'cold' explicitly when you want fresh-context wakes. A re-arm that omits carry preserves an active prior loop's already-chosen carry. 'warm' = each fire re-wakes THIS same session in place, context carried (an unbounded warm loop can hit the ceiling and die — WI-5557). 'cold' = the fresh-context lifecycle for an UNATTENDED AUTO loop: each fire RESETs the session to its carry-note (a periodic RECYCLE every Nth wake) instead of a warm turn, so the transcript never grows unbounded. Cold requires a carry-note anchor and the cold-auto master gate (decideColdWake). NEVER use 'cold' for an interactive/human-present session (D-005).",
      ),
    continuation: z
      .enum(['settle', 'gated'])
      .optional()
      .describe(
        "Continuation policy (flush-to-proceed-stretch-discipline-2026-07-04 P-005). 'settle' (DEFAULT) = today's behaviour — do one iteration's work each wake, then end the turn. 'gated' = the runtime expects MULTIPLE units per turn, each gated by the continuation gate (loop:checkpoint returns the verdict: context headroom below the ceiling? no pending owner input / inbox interrupt?): after settling a unit you flush your checkpoints then continue in-turn while the gate is OPEN, else end the turn. Recovers the per-wake orient/re-read boundary tax by running units back-to-back — arm a LONGER interval for a gated loop. Rides payload_template (no schema change); a settle loop is byte-identical to today.",
      ),
    mode: z
      .enum(['work', 'monitor'])
      .optional()
      .describe(
        "Wake-contract shape. 'work' (DEFAULT) = each wake creates + self-assigns work_items and works them. 'monitor' = a leader/supervisor loop that WATCHES something (a fleet, a pipeline, a soak): the wake says check → act only on deltas → checkpoint → end turn, with NO per-wake work-item boilerplate. Ignored when a custom wakePrompt is passed.",
      ),
    monitor: monitorArmConfigSchema
      .optional()
      .describe(
        "REQUIRED when mode:'monitor' and refused for work loops. Names the normalized watched predicate, concrete stop condition, finite consecutive no-delta budget (default 1, max 100), and exactly one verified authority: an already-held nonterminal work-item, live durable fleet leadership, or an exact owner-turn ref + quote. With fleet-leader or owner-turn authority, omit the separate top-level workItem argument. Admission is read-only and completes before any work-item claim or routine materialization.",
      ),
    costCapCents: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Auto-pause the loop if its cumulative cost crosses this many cents (best-effort).'),
    maxFires: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Dead-man guard: auto-pause the loop after this many wake fires SINCE THIS ARM (a bound on a runaway loop). Arm-relative, like maxDurationSec — a re-arm resets the count to 0, so `maxFires: 4` always means "4 more fires from now", never a lifetime total (EI-19339729634604096: this used to compare against the loop\'s cumulative lifetime fire count, so re-arming a session that had already fired more times than the new bound auto-paused it on the very first post-re-arm fire).',
      ),
    maxDurationSec: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Dead-man guard: auto-pause the loop this many seconds after it was armed (a bound on a forgotten / permanently-dead loop). Must be a positive integer. OMIT this optional field when no duration ceiling is intended; `maxDurationSec: 0` is invalid and is not a disable sentinel.',
      ),
  }),
  async handler(args, ctx) {
    // Feature gate (papercusp-loops). Default OFF until the full loop engine
    // (fire + completion-rebase) is verified green end-to-end; flip in
    // /admin/features. loop:end is intentionally NOT gated (always stoppable).
    if (!(await getFlag(FLAGS.LOOPS, 'system'))) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'loops_disabled',
              message:
                'The loop feature (flag papercusp-loops) is off — enable it in /admin/features once the loop engine is verified green.',
            }),
          },
        ],
        isError: true,
      };
    }

    const identity = resolveAgentIdentity(ctx);
    // WI-1471: honor an explicit owner override (mirrors loop:end/loop:status,
    // which already accept `ownerId` with no extra gate beyond this tool's own
    // `capability:'routines:write'`). Without this, a caller with no per-session
    // uiClientId (e.g. a client-less ptool/curl bridge over the superuser
    // transport) silently binds the loop to resolveAgentIdentity's SUPERUSER_
    // FALLBACK_CLIENT_ID ('su-loopback') — a fixed id that is never a live,
    // wake-reachable session, so the loop is armed but can never actually fire
    // into a running turn.
    const ownerId = resolveSelfLiteral(args.ownerId, identity.ownerId) ?? identity.ownerId;
    const ownerLabel =
      args.ownerId && ownerId !== identity.ownerId
        ? `su · ${shortOwnerLabel(ownerId)}`
        : identity.ownerLabel;
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const isConcreteHarness = (value?: string | null): value is string => {
      const trimmed = value?.trim().toLowerCase();
      return Boolean(trimmed && trimmed !== '*' && trimmed !== 'all');
    };
    // A superuser MCP scope is carried on the verified request origin rather than
    // in the tool args. Preserve it through tools:invoke: otherwise an operator
    // session has ctx.harnessSlug='*', misses args.harness, and silently falls
    // through to the workspace home pot (which may be a different harness).
    const innerHarness = args.harness?.trim();
    const dispatchHarness = ctx.requestOrigin?.query?.harness?.trim();
    const requestedHarness = isConcreteHarness(innerHarness)
      ? innerHarness
      : isConcreteHarness(dispatchHarness)
        ? dispatchHarness
        : undefined;
    if (isConcreteHarness(innerHarness) && isConcreteHarness(dispatchHarness) && innerHarness !== dispatchHarness) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'harness_scope_mismatch',
              dispatchHarness,
              requestedHarness: innerHarness,
              message:
                `Refusing to arm: dispatch scope harness "${dispatchHarness}" conflicts with inner harness "${innerHarness}". ` +
                'The verified dispatch scope is authoritative; re-arm with a matching harness.',
            }),
          },
        ],
        isError: true,
      };
    }
    // Read the active loop before resolving mode. A retune commonly omits mode and
    // monitor because it is changing only cadence/carry; defaulting that omission to
    // 'work' silently converts a fleet-leader monitor into a work loop. Explicit mode
    // changes remain authoritative, while an omitted mode inherits the active loop's
    // persisted lifecycle.
    let prior: PriorLoopFacts | null = null;
    try {
      prior = await readActiveLoopFacts(ownerId);
    } catch (e) {
      console.warn(
        `[loop:arm] prior-loop read failed (falling back to default carry resolution): ${e instanceof Error ? e.message : e}`,
      );
    }
    const modeExplicit = args.mode !== undefined;
    const preservingPriorMonitor =
      !modeExplicit && prior?.active === true && prior.mode === 'monitor' && !args.monitor;
    const requestedMode = args.mode ?? (prior?.active === true ? prior.mode : 'work');
    let preparedMonitorConfig: PersistedMonitorConfig | null = null;
    if (requestedMode === 'monitor') {
      if (preservingPriorMonitor) {
        // This is a carry/cadence retune, not a new monitor authority request. Reuse
        // the already-admitted policy and avoid re-running admission/dedup checks.
        preparedMonitorConfig = prior?.monitor ?? null;
      } else {
        if (!args.monitor) {
          return monitorRefusal(
            'monitor_config_required',
            "mode:'monitor' requires monitor:{ predicateKey, stopCondition, noDeltaBudget?, authority }.",
          );
        }
        const prepared = prepareMonitorConfig(args.monitor);
        if (!prepared.allowed) return monitorRefusal(prepared.code, prepared.message, prepared.details);
        preparedMonitorConfig = prepared.config;
      }
    } else if (args.monitor) {
      return monitorRefusal(
        'monitor_config_requires_monitor_mode',
        "The typed monitor config is valid only with mode:'monitor'; work loops remain byte-compatible and carry no monitor state.",
      );
    }
    // No `?? ''` collapse — keep the unresolved case nullish so the guard below catches
    // it and fails loud (a routine with an empty harness namespace would collide across
    // hives). workspace-data-isolation-leaks P-003.
    // EI-7734: route through resolvePotHomeSlug(explicit, ctxSlug) — NOT a raw `??`
    // chain — so its '*'-skip logic actually runs. Every superuser/operator-scope
    // session sets ctx.harnessSlug = '*' (the wildcard sentinel, `_harness-scope.ts`),
    // which is truthy and so WON A raw `args.harness ?? ctx.harnessSlug ?? …` chain
    // outright, before ever reaching the env-home fallback. That '*' then got
    // interpolated verbatim into the wake prompt's self-task example
    // (`work_items:create { …, harness:'*', … }`) — a value work_items:create's own
    // harness resolution rejects, so an SU loop's every wake failed to self-assign its
    // iteration's work_item. Same class of bug as the 2026-07-01 `pot:wake` 404
    // (installSlug='*') that resolvePotHomeSlug's '*'-skip was written to prevent —
    // this call site just wasn't routed through it.
    // Workspace-scoped operator sessions carry the '*' sentinel rather than a
    // concrete harness. A durable loop cannot be installed under that sentinel:
    // every wake must carry a real harness for coord:orient/scheduler:get_next.
    // Resolve the workspace's formal home pot in that case, so callers do not
    // have to discover and repeat a concrete slug (EI-20185529721601434). Keep
    // the synchronous resolver as a fallback for legacy env-only sessions and
    // explicit concrete selectors.
    // EI-20245033088778955: tools:invoke may dispatch this re-arm through a
    // wildcard transport context even though the owner already has a durable
    // loop installed under a concrete harness. Read the existing routine before
    // resolving the new scope so a scope-less re-arm preserves that install_slug
    // instead of returning no_harness (or silently moving the loop home).
    // EI-21476896242465605: a carry/mode retune of an ACTIVE loop must not have to
    // re-state intervalSec/goal — inherit both from the live row so the documented
    // `loop:arm { carry }` retune works. A FRESH arm missing either still fails,
    // now with an explicit invalid_args response naming the fields instead of an
    // opaque schema rejection.
    const inheritedIntervalSec =
      args.intervalSec ?? (prior?.active === true ? prior.intervalSec ?? undefined : undefined);
    const inheritedGoal =
      args.goal ?? (prior?.active === true ? prior.goal ?? undefined : undefined);
    // A FRESH arm missing either still fails — now with an explicit invalid_args
    // response naming the fields instead of an opaque schema rejection.
    if (
      inheritedIntervalSec == null ||
      inheritedGoal == null ||
      inheritedGoal.trim() === ''
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'invalid_args',
              missing: [
                ...(inheritedIntervalSec == null ? ['intervalSec'] : []),
                ...(inheritedGoal == null || inheritedGoal.trim() === '' ? ['goal'] : []),
              ],
              message:
                'intervalSec and goal are required when arming a loop that has no active prior ' +
                '(a carry-only RETUNE inherits them from the live loop). Read loop:status for ' +
                'the current values, or pass both explicitly.',
            }),
          },
        ],
        isError: true,
      };
    }
    const intervalSecArg: number = inheritedIntervalSec;
    const rawGoal: string = inheritedGoal;
    const explicitWorkItem = args.workItem?.trim();
    const workItemWasExplicitlyCleared = args.workItem === null;
    // An empty string retains the legacy omission behavior; a non-empty id or explicit
    // null is a meaningful override that must suppress prior-anchor/autodetect fallback.
    const workItemOverride = Boolean(explicitWorkItem) || workItemWasExplicitlyCleared;
    const monitorAuthorityWorkItem =
      preparedMonitorConfig?.authority.kind === 'work-item' ? preparedMonitorConfig.authority.workItem : undefined;
    // Resolve the effective carry before choosing the harness so a COLD loop's
    // goal-detected work-item can contribute its canonical harness scope. Without
    // this, a workspace-scoped caller falls through to the workspace home first
    // (which may be an unrelated pot), then attempts the by-id claim in that wrong
    // namespace and reports not_found even though coord:orient reconciled a held
    // item in another harness (EI-21358731971685285).
    // Keep the raw goal for structural work-item detection. The persisted/wake-prompt
    // copy is intentionally soft-capped, but detecting after that clamp can turn an
    // identifier that straddles the 4000-character boundary into a valid-looking
    // truncated prefix (for example `EI-214022`), producing a misleading not_found
    // auto-claim result (EI-21405190650662222).
    const goal = clampText(rawGoal, 4000);
    // Refuse a plan-wide release wait while staging work remains available or
    // blocked descendants have not been reviewed. This runs before any loop or
    // work-item claim is written; the same guard serves events:await and sugar.
    const mainWaitPlanReview = await mainWaitPlanReviewForWait({
      ownerId,
      goal,
      note: [goal, args.blockedOn?.reason].filter(Boolean).join('\n'),
    });
    if (mainWaitPlanReview && !mainWaitPlanReview.allowWait) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: mainWaitPlanReview.code, ...mainWaitPlanReview }) }],
        isError: true,
      };
    }
    const carryForScope: 'warm' | 'cold' | undefined =
      args.carry ??
      (prior?.active
        ? prior.carry
        : !workItemOverride && !monitorAuthorityWorkItem
          ? FRESH_LOOP_DEFAULT_CARRY
          : undefined);
    const autoDetectedWorkItemForScope =
      !workItemOverride && carryForScope === 'cold' ? (detectDrivenWorkItemId(rawGoal) ?? undefined) : undefined;
    const scopeWorkItem = explicitWorkItem ?? monitorAuthorityWorkItem ?? autoDetectedWorkItemForScope;
    // Only the INNER tool argument is an explicit migration request. A concrete
    // request-origin harness is still authoritative for a FRESH arm, but tools:invoke
    // can preserve a transient outer dispatch scope that must not migrate an already-
    // active owner loop when the inner loop:arm call omitted `harness`
    // (EI-21550331830461260).
    const explicitHarnessRequested = isConcreteHarness(innerHarness);
    const requestScopeHarnessAvailable = isConcreteHarness(requestedHarness);
    const onlyWorkspaceScope = !requestScopeHarnessAvailable && !isConcreteHarness(ctx.harnessSlug);
    // An inner harness is the caller's explicit install-scope choice. Resolve it
    // before consulting the session brief or workspace home, which can describe
    // a different active plan and otherwise silently move a cold carry-note.
    let harness: string | null = explicitHarnessRequested
      ? resolvePotHomeSlug(innerHarness, undefined)
      : null;
    // EI-20245033088778955 / EI-21481296218316052: an ACTIVE routine's install
    // scope is authoritative whenever the caller OMITS args.harness — not only
    // through a wildcard transport. A concrete ctx harness describes where this
    // invocation arrived; it is not an explicit request to migrate the durable
    // loop. Letting it win silently rewrites routines.install_slug while leaving
    // the cold carry-note under the old scope, so the next reset finds no note.
    // An explicit args.harness remains the deliberate migration override.
    if (!explicitHarnessRequested && prior?.active === true && isConcreteHarness(prior.harnessSlug)) {
      harness = resolvePotHomeSlug(prior!.harnessSlug!, undefined);
    }
    // EI-21302411209364135 / EI-21358731971685285 / EI-21448192328031315: a pinned or
    // COLD goal-detected work-item is also a durable scope hint. A caller that omits
    // `args.harness` may still carry a concrete but stale `ctx.harnessSlug` from an
    // unrelated prior session (for example, a Codex member relaunched into a different
    // harness). Numeric WI/EI ids are globally unique, so resolve the item without a
    // harness before falling back to that context; then use its canonical harness for
    // both fleet admission and the compare-and-claim. An explicit harness remains the
    // caller's choice, and an active loop's existing install scope remains authoritative
    // above, so ordinary re-arms do not silently migrate an already-installed routine.
    if (!isConcreteHarness(requestedHarness) && !harness && scopeWorkItem) {
      try {
        const item = await getWorkItem(scopeWorkItem.toUpperCase());
        if (isConcreteHarness(item?.harness)) {
          harness = resolvePotHomeSlug(item!.harness!, undefined);
        }
      } catch {
        // Scope inference is a convenience for an otherwise-valid arm. Preserve the
        // existing home-harness fallback when the unscoped lookup cannot complete.
      }
    }
    // EI-21545786648324241: a concrete dispatch context can itself be stale. The
    // reported session had just oriented onto a Papercusp plan, but its transport
    // still carried `ctx.harnessSlug='sb-devboard-hive'`; because the old code read
    // the durable brief only for wildcard contexts, that stale transport value
    // silently moved the newly-armed loop into the wrong harness.
    //
    // A durable brief is authoritative here only when it names an ACTIVE plan.
    // Requiring currentPlanSlug keeps a populate-once historical harness from
    // overriding an otherwise-valid concrete context after the plan lane is gone.
    // Explicit args, an active loop's install scope, and a canonical work-item scope
    // have all already won above. A concrete request-origin harness is still useful as
    // the fallback for a fresh arm, but it is transport state that may be stale after
    // the session re-oriented; let an active plan brief correct it when the context is
    // concrete too.
    if (!harness && isConcreteHarness(ctx.harnessSlug)) {
      const brief = await getSessionBrief({ ownerId }).catch(() => null);
      if (brief?.currentPlanSlug && isConcreteHarness(brief.harnessSlug)) {
        harness = resolvePotHomeSlug(brief.harnessSlug, undefined);
      }
    }
    // A wildcard operator session means "this workspace", not "whatever harness
    // the last session brief happened to retain". Resolve the formal workspace
    // home before consulting the populate-once brief; the latter can be stale
    // after a Codex member is relaunched into a different harness (EI-212804...).
    if (onlyWorkspaceScope && !harness) {
      try {
        const home = await resolveHomePotSlug(workspaceId);
        if (home) harness = resolvePotHomeSlug(home, undefined);
      } catch {
        // Home-pot discovery is a convenience for workspace-scoped callers. If
        // the registry is temporarily unreadable, preserve the older env/ctx
        // fallback and let the existing no_harness response explain the gap.
        harness = null;
      }
    }
    // EI-20211399000978706: retain the durable coord:orient/declare-intent
    // scope as a fallback for workspaces without a formal home pot. Explicit
    // args, concrete request context, an active routine, and the workspace home
    // all win by construction above.
    if (onlyWorkspaceScope && !harness) {
      const brief = await getSessionBrief({ ownerId }).catch(() => null);
      if (isConcreteHarness(brief?.harnessSlug)) {
        harness = resolvePotHomeSlug(brief!.harnessSlug!, undefined);
      }
    }
    harness ??= resolvePotHomeSlug(requestedHarness, ctx.harnessSlug);
    if (!harness) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_harness',
              message:
                'Pass `harness` — your session is not scoped to a harness and no home hive is set, so the loop routine has nowhere to live.',
            }),
          },
        ],
        isError: true,
      };
    }

    // EI-19966210024116714 — a loop armed against a harness its OWN SESSION cannot
    // address is doomed from `armedAt`, and the failure is SILENT for hours. Every
    // harness-scoped call the wake contract prescribes (`coord:orient`,
    // `scheduler:get_next`) is refused by the scoped-superuser dispatch clamp with
    // `harness_forbidden`, so the agent wakes on cadence, errors on every pull, and
    // produces no turn output — until the stalled-loops guard disarms it (WI-6639) and
    // the claim reaper releases its held work-items as `reaper:dead`. Every individual
    // signal reads healthy meanwhile: wakes report `delivered`, `turnsStalled` stays
    // false, `lastRealTurnAt` keeps advancing. The agent looks dead from outside and
    // fine from inside. Observed live 2026-08-08/09 across FOUR fleet members
    // (su-334bd763, su-28297628, su-b5111af0, +1) who armed loops on harness
    // 'papercusp' from sessions scoped to workspace 'default'; one burned 44 wakes over
    // ~8h and lost a held item mid-diagnosis to the reaper.
    //
    // The mismatch is fully determinable HERE, so refuse at arm time rather than let it
    // present as death 8h later. Mirrors the dispatch clamp's semantics EXACTLY
    // (`_mcp-handler.ts` scopedSuperuserClamp + resolveWorkspaceForHarnessSlugIn), so
    // this can only ever refuse an arm that clamp would go on to refuse call-by-call:
    // only a CLAMPED session is checked (an UNSCOPED '*' superuser legitimately spans
    // workspaces), and we fail OPEN on a resolver throw/miss — fail CLOSED only on a
    // CONFIRMED foreign resolution.
    const scopedClamp =
      ctx.isSuperuser === true && workspaceId !== '*' && (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, 'system'));
    if (scopedClamp) {
      let harnessWs: string | null = null;
      try {
        const { resolveWorkspaceForHarnessSlugIn } = await import('../../harness-core');
        harnessWs = await resolveWorkspaceForHarnessSlugIn(workspaceId, harness);
      } catch {
        // Ambiguous cross-workspace collision (resolver throws) or an infra error:
        // fail OPEN — never block a legitimate arm on a read we could not complete.
        harnessWs = null;
      }
      if (harnessWs && harnessWs !== workspaceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'harness_workspace_mismatch',
                harness,
                harnessWorkspace: harnessWs,
                sessionWorkspace: workspaceId,
                message:
                  `Refusing to arm: harness "${harness}" belongs to workspace "${harnessWs}", but this session is scoped to workspace "${workspaceId}". ` +
                  'Every harness-scoped call this loop would make (coord:orient, scheduler:get_next) would be refused with harness_forbidden, so the ' +
                  'loop would wake on cadence, accomplish nothing, and eventually be auto-disarmed while your held work-items are reaped as dead. ' +
                  'Arm from a session scoped to that workspace (or an unscoped --all-workspaces session), or pass a harness that is in scope.',
              }),
            },
          ],
          isError: true,
        };
      }
    }

    // softText fields (P-002): never bounced on length — clamp to cap here.
    const wakePrompt = clampText(args.wakePrompt, 4000);

    // EI-20034001963934568: the loop goal is replayed as machine-injected `user`
    // text on every fire. A bare [owner:…] tag therefore launders an agent-authored
    // goal into owner-looking speech. Require a verifiable turn ref at this source;
    // the carry-surface lint already distinguishes real tags from documented
    // placeholders and same-line [turn:…] anchors. Refuse before any claim or
    // routine materialization so an invalid goal cannot create a doomed loop.
    const goalProvenance = lintCarrySurfaceProvenance(goal);
    const unverifiedOwnerTagMatches = goalProvenance.matches.filter(
      ({ kind, line }) => kind === 'manual-owner-tag' && BRACKETED_OWNER_TAG_RE.test(line),
    );
    if (unverifiedOwnerTagMatches.length > 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'unverified_goal_provenance',
              message:
                'Refusing to arm: the loop goal contains a bare [owner:…] tag without a verifiable [turn:…] anchor. ' +
                'Loop goals replay as machine-injected user text, not owner turns. Replace the tag with [self-imposed], ' +
                '[inferred], or [peer:…], or cite the actual human turn as [turn:<session>@<timestamp>] and verify its provenance before arming.',
              matches: unverifiedOwnerTagMatches,
            }),
          },
        ],
        isError: true,
      };
    }

    // anti-babysitting-monitor-enforcement P-003 — the monitor admission gate.
    // Every leg above is read-only scope/provenance resolution. Every mutation
    // below (the optional claim, materializeLoop, control-anchor write, and wake
    // registration) is downstream of this refusal boundary.
    // A monitor-policy retune that omitted mode reuses the prior admitted policy above.
    // New monitor arms and explicit monitor config changes still pass the full admission
    // and exact-await dedup gates.
    let admittedMonitorConfig: PersistedMonitorConfig | null = preparedMonitorConfig;
    if (requestedMode === 'monitor' && !preservingPriorMonitor) {
      const admission = await admitMonitorArm({
        ownerId,
        workspaceId,
        harness,
        monitor: args.monitor,
      });
      if (!admission.allowed) {
        return monitorRefusal(admission.code, admission.message, admission.details);
      }
      admittedMonitorConfig = admission.config;
      if (await hasLiveExactAwaitForSubscriberKey(ownerId, admission.config.predicateKey)) {
        const refusal = monitorPredicateDedupRefusal(admission.config.predicateKey, 'exact-await')!;
        return monitorRefusal(refusal.code, refusal.message, refusal.details);
      }
      if (explicitWorkItem && admission.config.authority.kind !== 'work-item') {
        return monitorRefusal(
          'monitor_work_item_authority_mismatch',
          `Omit top-level workItem ${explicitWorkItem.toUpperCase()} when monitor.authority.kind is ${admission.config.authority.kind}; only work-item authority may pass that same already-held item.`,
        );
      }
      if (
        explicitWorkItem &&
        admission.config.authority.kind === 'work-item' &&
        explicitWorkItem.toUpperCase() !== admission.config.authority.workItem
      ) {
        return monitorRefusal(
          'monitor_work_item_authority_mismatch',
          `workItem ${explicitWorkItem.toUpperCase()} differs from monitor authority ${admission.config.authority.workItem}.`,
        );
      }
    }

    // EI-19447204017443244 — MEASURE the caller's live push channels before the cap
    // message speaks about them. Gated to the one branch that consumes it (a declared
    // blocker with NO named event): every other arm keeps its exact prior round-trip
    // count, so an advisory message costs nothing on the common path.
    //
    // Best-effort, mirroring the prior-loop read below: this is advisory, so a failure
    // must not fail the arm. The catch yields `unknown` rather than `none` — see
    // LivePushChannels; degrading to "I checked and found nothing" would print a
    // fabricated measurement, which is the defect being fixed here.
    let livePush: LivePushChannels = { status: 'unknown' };
    if (args.blockedOn && !args.blockedOn.event) {
      try {
        const { totalCount, sample } = await listWakeAwaitsForSubscriber(ownerId);
        livePush =
          totalCount > 0
            ? { status: 'found', count: totalCount, sample: sample.slice(0, 2).map((a) => a.eventKey) }
            : { status: 'none' };
      } catch (e) {
        console.warn(
          `[loop:arm] live wake-await lookup failed (cap message will not claim either way): ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // EI-22323707896569406 — a named event is a PUSH CHANNEL CLAIM, not proof. Resolve
    // it through the shared event authority before allowing it to lift the backoff cap.
    // The resolver itself fails soft to `unknown`; this catch protects the arm if an
    // import/dispatch seam fails before the resolver can return its evidence.
    let eventReachability: ExternalConditionReachability | null = null;
    if (args.blockedOn?.event) {
      try {
        eventReachability = await readEventConditionReachability(args.blockedOn.event);
      } catch (e) {
        eventReachability = {
          verdict: 'unknown',
          basis: 'unmeasured',
          authoritative: false,
          evidence: `reachability resolver failed: ${e instanceof Error ? e.message : String(e)}`,
          checkedAt: new Date().toISOString(),
        };
        console.warn(
          `[loop:arm] blockedOn.event reachability lookup failed (arm still proceeds with cap): ${eventReachability.evidence}`,
        );
      }
    }

    // EI-19395290807657827 — resolve a blocker-motivated interval BEFORE it is threaded
    // into the kickoff / overwrite-note / materializeLoop, so every downstream consumer
    // sees the interval that is actually armed rather than the one that was requested.
    const backoff = resolveBlockedBackoff(intervalSecArg, args.blockedOn ?? null, livePush, eventReachability);
    const intervalSec = backoff.intervalSec;
    // EI-18792078711601844 — read the prior loop this arm is about to UPSERT over
    // EI-21424742792137469: an unspecified carry on a FRESH arm always defaults
    // WARM. Session/headless detection must not override the fleet/owner launch
    // policy. An unspecified carry on a RE-ARM of an already-ACTIVE loop PRESERVES that
    // loop's current carry (EI-18792078711601844) — a re-arm's whole point is to
    // retune ONE field (usually intervalSec), not to re-decide the lifecycle. An
    // explicit args.carry always wins either way. `carry` from here on is the
    // RESOLVED value, threaded into materializeLoop + the kickoff + response.
    const carryPreservedFromPrior = args.carry == null && Boolean(prior?.active);
    const carry = args.carry ?? (prior?.active ? prior.carry : (carryForScope ?? FRESH_LOOP_DEFAULT_CARRY));
    const resolvedMode = requestedMode;

    // WI-5557 TIER 1 — an unattended warm-carry WORK loop with neither dead-man guard set
    // (maxFires / maxDurationSec) has NOTHING bounding how long it re-wakes the SAME warm
    // session, so context grows every fire until it hits the ceiling and dies uncleanly
    // (repro: session fa10eeb7, 52 fires / 7.3h / 364 turns → death→cold-recycle→warm-regrow
    // cycle the owner called "should never happen"). This is purely additive — a response
    // field + note suffix, no behavior change — so it's safe to land without the TIER 2
    // engine-side hard net (which needs owner disclosure given its fleet-wide blast radius;
    // tracked separately). A 'monitor' loop is excluded: it's a leader/supervisor loop that
    // is, by its own contract, actively watched each wake, not left to silently regrow.
    const unboundedWarmLoopWarning: string | null =
      carry === 'warm' && resolvedMode === 'work' && !args.maxDurationSec && !args.maxFires
        ? 'This is an unattended warm-carry WORK loop with no maxFires/maxDurationSec bound — context carries and grows every fire with nothing to stop it, and an unbounded warm loop can hit the context ceiling and die uncleanly (WI-5557). Consider setting maxFires or maxDurationSec, or self-compacting periodically via session:request-compaction as context grows.'
        : null;

    // WI-2429 fix A — auto-claim the work-item this loop DRIVES, at arm time, so it is
    // HELD from wake 1. Then the per-item work_items:checkpoint death-resilience net
    // engages (a successor/reclaimer inherits the item + its checkpoint if the session
    // dies — the exact WI-2339 silent-halt risk), and the cold-wake prompt can name the
    // item concretely instead of the soft "if you hold a work-item" the cold-auto
    // experiment measured agents ignoring. An explicit `workItem` is honored for ANY
    // carry; goal auto-detect is scoped to COLD loops (the death-resilience scenario) so
    // warm-loop behaviour stays byte-identical unless the arming agent opts in. The claim
    // NEVER steals a live peer's item (claimWorkItem's compare-and-claim only takes an
    // unheld/self-held row), so a conflict/not-found is a non-fatal NOTE, never a failed
    // arm — arming already succeeded; this is best-effort on top. A cold goal's
    // auto-detected candidate also passes the active scheduler spec before this claim;
    // an authored per-cup plan lane must not be bypassed merely because the caller is
    // not a named fleet member (EI-21659493450381888).
    const explicit = explicitWorkItem;
    const drivenCandidate =
      resolvedMode === 'monitor'
        ? undefined
        : explicit
          ? explicit.toUpperCase()
          : carry === 'cold'
            ? autoDetectedWorkItemForScope
            : undefined;
    // Work-item monitor authority is already held (admission proved it), so
    // bind it to the wake prompt without re-running the claim mutation.
    // EI-22079408866636029: a cadence/dead-man retune commonly omits workItem.
    // Preserve the active loop's durable anchor in that case, rather than rebuilding
    // the response and kickoff with `null` and silently detaching the loop from its
    // death-resilience work-item claim.
    const priorWorkItem =
      resolvedMode === 'work' &&
      !workItemOverride &&
      !monitorAuthorityWorkItem &&
      prior?.active === true &&
      typeof prior.workItem === 'string' &&
      prior.workItem.trim()
        ? prior.workItem.trim().toUpperCase()
        : null;
    let claimedWorkItem: string | null =
      admittedMonitorConfig?.authority.kind === 'work-item' ? admittedMonitorConfig.authority.workItem : priorWorkItem;
    // EI-23156379126419084: the writer preserves an omitted workItem from its stored
    // payload, so a terminal prior anchor must be sent as an explicit null after this
    // lifecycle read. Otherwise a cadence retune can report the stale item as its
    // driver and cold recovery will resume work that already finished.
    let workItemBindingNeedsClear = workItemWasExplicitlyCleared;
    let workItemClaim:
      | { id: string; claimed: true }
      | { id: string; claimed: false; reason: string; holder?: string; hint?: string }
      | null = null;
    if (priorWorkItem) {
      try {
        const priorItem = await getWorkItem(priorWorkItem, harness);
        if (priorItem && ANY_FAMILY_TERMINAL_STATES.includes(String(priorItem.state))) {
          claimedWorkItem = null;
          workItemBindingNeedsClear = true;
          workItemClaim = { id: priorWorkItem, claimed: false, reason: 'terminal' };
        }
      } catch (e) {
        // This is a defensive lifecycle check. Preserve a non-terminal-looking anchor
        // when the read is unavailable rather than detaching a live loop on a transient
        // lookup failure; the next retune can retry the check.
        console.warn(
          `[loop:arm] prior work-item lifecycle read failed (keeping existing anchor): ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    if (drivenCandidate) {
      try {
        // EI-20123870155538062: the direct loop auto-claim is still a claim door. Route it
        // through the same fleet/scheduler admission used by work_items:claim before calling the
        // lower-level compare-and-claim primitive. Otherwise a member can bind an out-of-spec
        // item to its loop even though the authoritative by-id claim tool refuses it.
        // EI-21659493450381888 extends this to non-fleet callers with an authored per-cup spec.
        const { admitWorkItemForLoopTarget } = await import('../../scheduler/fleet-scope-admission');
        const schedulerSpecEnabled = await getFlag(FLAGS.SCHEDULER_SPEC_CLAIM, ownerId).catch(() => true);
        const admission = await admitWorkItemForLoopTarget({
          target: ownerId,
          workItemId: drivenCandidate,
          harness,
          workspaceId,
          enforceSchedulerSpec: schedulerSpecEnabled && !explicitWorkItem,
        });
        if (!admission.allowed) {
          // The loop itself is useful even when its optional death-resilience anchor is out of
          // scope; skip only the binding and surface the exact admission reason to the caller.
          workItemClaim = {
            id: drivenCandidate,
            claimed: false,
            reason: admission.code,
            hint: admission.reason,
          };
        } else {
          // EI-20223724711056304: a loop pin is not allowed to resurrect finished
          // work. The lower-level by-id claim path can return an idempotent-looking
          // row for a terminal item, so read lifecycle state BEFORE mutation and
          // keep both the routine binding and wake prompt free of the stale id.
          const beforeClaim = await getWorkItem(drivenCandidate, harness);
          if (beforeClaim && ANY_FAMILY_TERMINAL_STATES.includes(String(beforeClaim.state))) {
            workItemClaim = { id: drivenCandidate, claimed: false, reason: 'terminal' };
          } else if (beforeClaim && isClaimHoldParked(beforeClaim.payload)) {
            // A loop's by-id claim is intentionally allowed to bypass the generic
            // self-select `_claimHold` floor, but loop:arm is an automatic binding
            // path, not an operator's deliberate claim. In particular, synthetic
            // resource-governor receipts carry this hold and must remain owned by the
            // governor; never let cold goal detection or an explicit loop pin consume
            // that lease (EI-21681983105634595).
            workItemClaim = {
              id: drivenCandidate,
              claimed: false,
              reason: 'claim_hold',
              hint: 'work-item is claim-held for an existing system/governor lease; loop binding was skipped',
            };
          } else if (
            beforeClaim &&
            String(beforeClaim.state) === 'blocked' &&
            !isSelfOwnerRecord(beforeClaim.assignee ?? null, ownerId)
          ) {
            // EI-20304485841686120: the THIRD member of this guard chain, and it fails the
            // same way as the two above — a row that is non-terminal but that this member
            // cannot advance. `blocked` is a resolver-owned floor: scheduler:get_next
            // refuses to hand it out (it is not a requestable `states` value; blocked items
            // are leader-triage-only), so the member can neither progress it nor re-pull it.
            // It is still non-terminal, so getActiveClaimsForBee counts it against
            // maxConcurrentClaims — and under the default cap of 1 the member is then
            // starved from ALL work until it manually releases. That refusal is correct and
            // deliberately fires BEFORE lane evaluation (EI-12095), so the starvation reads
            // as "claim cap reached" with no hint that an unworkable auto-binding caused it.
            //
            // An EXPLICIT pin is the reachable path: enforceSchedulerSpec is
            // `!explicitWorkItem`, and admitWorkItemForLoopTarget returns early when it is
            // false ("an explicit solo pin is intentionally not narrowed"), so the spec's
            // `states` floor never screens a hand-passed blocked id.
            //
            // Scoped to items NOT already ours on purpose: if the member already holds it
            // the slot is spent either way, and skipping would drop a legitimate
            // death-resilience anchor for someone looping precisely to UNBLOCK it. As with
            // the branches above, only the binding is skipped — the loop still arms.
            workItemClaim = {
              id: drivenCandidate,
              claimed: false,
              reason: 'blocked',
              hint:
                'work-item is in `blocked` (a leader-triage-only floor the scheduler will not re-offer); ' +
                'binding it would consume this member’s concurrent-claim slot with work it cannot advance, so ' +
                'the loop armed without it. Claim it explicitly with work_items:claim if that is genuinely intended.',
            };
          } else {
            const wi = await claimWorkItem(drivenCandidate, ownerId, { harness });
            if (wi) {
              claimedWorkItem = drivenCandidate;
              workItemClaim = { id: drivenCandidate, claimed: true };
            } else {
              // claimWorkItem returns a bare null for three outcomes — re-read + classify
              // for an accurate, actionable note (mirrors work_items:claim's claimOne).
              const current = await getWorkItem(drivenCandidate, harness);
              const failure = classifyClaimFailure(current, ownerId);
              workItemClaim =
                failure.reason === 'conflict'
                  ? { id: drivenCandidate, claimed: false, reason: 'claim_conflict', holder: failure.holder }
                  : failure.reason === 'not_found'
                    ? { id: drivenCandidate, claimed: false, reason: 'not_found' }
                    : { id: drivenCandidate, claimed: false, reason: 'not_claimable' };
            }
          }
        }
      } catch (e) {
        workItemClaim = {
          id: drivenCandidate,
          claimed: false,
          reason: `error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    // EI-20256869903801099: an omitted wakePrompt means "keep the loop's existing
    // custom kickoff" when the row carries the explicit marker. Legacy rows have no
    // marker, so their kickoff is rebuilt from the default template instead of
    // guessing that arbitrary stored prose was custom. This distinction must be
    // resolved before the backoff premise is applied and then persisted with the row.
    const preservePriorCustomWakePrompt =
      wakePrompt == null && prior?.active === true && prior.customWakePrompt === true;
    const hasCustomWakePrompt = wakePrompt != null || preservePriorCustomWakePrompt;
    const baseKickoff =
      wakePrompt ??
      (preservePriorCustomWakePrompt
        ? prior!.kickoff
        : buildLoopWakePrompt({
            ownerId,
            intervalSec,
            harness,
            goal,
            carry,
            continuation: args.continuation ?? 'settle',
            mode: resolvedMode,
            // Only name the item in the wake prompt if we ACTUALLY hold it — a conflicted /
            // not-found candidate must not tell the agent "you hold X".
            workItem: claimedWorkItem,
          }));

    // EI-19395290807657827 — PREPEND the backoff premise to the kickoff. This is what makes
    // the fix work rather than merely advise: the arming agent goes to sleep and can never
    // re-read this tool's RESPONSE, but the kickoff is re-delivered on EVERY wake. Putting
    // the premise first means the next wake re-checks the specific condition the interval
    // was chosen under, instead of silently inheriting it for the rest of the loop's life.
    // Applies to a custom wakePrompt too — the trap is orthogonal to how the wake reads.
    const kickoff = backoff.wakePremise
      ? `⏸ BACKOFF PREMISE — RE-CHECK THIS BEFORE ANYTHING ELSE:\n${backoff.wakePremise}\n\n${baseKickoff}`
      : baseKickoff;

    // EI-18221784742583615 — arm-time overwrite guard. Using `prior` (read above, before
    // materializeLoop overwrites it) — if the re-arm materially changes an ACTIVE loop's
    // goal, surface the prior config for comparison so the arming agent sees what it is
    // replacing instead of clobbering a specialized loop blind (the stale/replayed-kickoff
    // scenario). Best-effort + purely advisory: a compute failure never fails the arm, and
    // the loop is still (re-)armed regardless — "surface, don't silently overwrite" per the
    // filed bug, not a hard refusal.
    let overwriteNote: LoopOverwriteNote | null = null;
    try {
      overwriteNote = computeLoopOverwriteNote(prior, {
        goal,
        intervalSec: intervalSec,
        kickoff,
        harnessSlug: harness,
      });
    } catch (e) {
      console.warn(
        `[loop:arm] overwrite-note compute failed (loop still armed): ${e instanceof Error ? e.message : e}`,
      );
    }

    // EI-21542193720279374 part (b) — a COLD loop with NO existing carry-note is a
    // guaranteed-blind wake: a cold wake rebuilds its entire context solely from the
    // carry-note (loop:checkpoint), so arming cold with nothing there to rebuild from
    // produces exactly the failure this item diagnosed even without a harness move (a
    // fresh cold arm before the first checkpoint, or a carry-note that was cleared /
    // evicted). Purely additive — mirrors the WI-5557 unboundedWarmLoopWarning pattern
    // exactly (response field + note suffix, no behavior change) rather than a hard
    // refusal: arm.ts never seeds an initial carry-note itself (confirmed via repo-wide
    // grep — the standard bootstrap is "arm cold, then loop:checkpoint" as a SEPARATE
    // later call), so refusing here would break that flow fleet-wide. Fail-soft, like
    // the reachability probe below: a read failure never blocks the arm, and
    // getLoopCarryNoteWithMeta itself already fails soft (readFailed:true) rather than
    // throwing, so the try/catch here only guards an unexpected import/call-shape error.
    let coldNoCarryNoteWarning: string | null = null;
    if (carry === 'cold') {
      try {
        const existing = await getLoopCarryNoteWithMeta({ harness, ownerId });
        if (!existing.readFailed && !existing.note) {
          coldNoCarryNoteWarning =
            'This loop is armed COLD with no existing carry-note for this harness/owner scope — a cold wake rebuilds solely from the carry-note, so the next wake will start BLIND with no prior context. Write one with loop:checkpoint before ending your turn.';
        }
      } catch (e) {
        console.warn(
          `[loop:arm] cold-carry-note check failed (loop still armed): ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // EI-21526226279199560 — persist the declared blocker STRUCTURALLY, alongside the
    // frozen premise already prepended to `kickoff` above. The premise is what the wake
    // re-READS; this record is what the wake can re-RESOLVE, which is the difference
    // between re-delivering a stale sentence and noticing the blocker died an hour ago.
    const blockedOnRecord: LoopBlockedOnRecord | null = args.blockedOn
      ? {
          reason: args.blockedOn.reason,
          kind: args.blockedOn.kind ?? null,
          ref: args.blockedOn.ref ?? null,
          event: args.blockedOn.event ?? null,
          since: resolveBlockedSince(
            {
              reason: args.blockedOn.reason,
              kind: args.blockedOn.kind ?? null,
              ref: args.blockedOn.ref ?? null,
            },
            prior?.blockedOn ?? null,
            new Date().toISOString(),
          ),
        }
      : null;

    const loop = await materializeLoop({
      workspaceId,
      harnessSlug: harness,
      ownerId,
      intervalSec: intervalSec,
      kickoff,
      ...(blockedOnRecord ? { blockedOn: blockedOnRecord } : {}),
      // EI-20072281215342526: persist the goal STRUCTURALLY, not only rendered into
      // `kickoff`. A carry-respawn never renders a kickoff, so this is the copy that
      // reaches a successor (via loop:status and the carry document).
      goal,
      costCapCents: args.costCapCents ?? null,
      maxFires: args.maxFires ?? null,
      maxDurationSec: args.maxDurationSec ?? null,
      carry,
      continuation: args.continuation ?? 'settle',
      mode: resolvedMode,
      ...(admittedMonitorConfig ? { monitor: admittedMonitorConfig } : {}),
      // Preserve the omission-vs-clear distinction through the writer: materializeLoop
      // intentionally preserves its stored anchor only for `undefined`, while `null`
      // clears it.
      ...(workItemBindingNeedsClear
        ? { workItem: null }
        : claimedWorkItem
          ? { workItem: claimedWorkItem }
          : {}),
      customWakePrompt: hasCustomWakePrompt,
    });
    const control = await refreshControlAnchorAfterMutation({
      ownerId,
      workspaceId,
      origin: 'agent',
      actorId: identity.ownerId,
      source: 'loop:arm',
    });

    // WI-655 — wake-reachability is INTRINSIC to arming a loop, not a separate step.
    // (1) ARM the standing inbox-wake watch right here, so a loop is wakeable the instant
    // it is armed — independent of the SessionStart re-arm a RESUMED/curl-driven session
    // never re-runs (the exact decoupling that black-holed fires as `no-session-now`).
    // (2) VERIFY it: probe which wake-executor channel a fire WOULD take, and if the
    // session can't receive a wake as a fresh turn, return a LOUD warning rather than a
    // silent success. Fail-soft — arming the loop already succeeded; this leg is the
    // honest reachability read on top.
    let reachability: WakeReachabilityVerdict | null = null;
    try {
      await armInboxWake({ ownerId, workspaceId, note: `loop-armed inbox-wake (${loop.name})` });
      reachability = await probeWakeReachability(ownerId);
    } catch (e) {
      console.warn(
        `[loop:arm] reachability arm/probe failed (loop still armed): ${e instanceof Error ? e.message : e}`,
      );
    }

    const reachabilityOut = reachability
      ? {
          reachable: reachability.reachable,
          channel: reachability.channel,
          durableWhileAlive: reachability.durableWhileAlive,
          summary: reachability.summary,
          ...(reachability.warning ? { warning: reachability.warning } : {}),
        }
      : null;

    const baseNote =
      reachability && !reachability.reachable
        ? `⚠ Armed, but NOT wake-reachable: ${reachability.warning ?? reachability.summary} The loop row exists, but fires will NOT reach you as a fresh turn until this is fixed (re-arm from a managed/console/psu-hosted session). loop:status shows live reachability; loop:end stops it.`
        : reachability && reachability.warning
          ? `Armed (wake path: ${reachability.channel}). ⚠ ${reachability.warning} End your turn — the engine re-wakes ~${intervalSec}s after each turn settles. Stop with loop:end.`
          : `Armed (wake path: ${reachability?.channel ?? 'unverified'}). End your turn — the engine will re-wake this session ~${intervalSec}s after each turn settles. Stop anytime with loop:end.`;

    // WI-2429 fix A — surface the auto-claim outcome so the arming agent sees it took (or
    // why it didn't). A conflict/not-found never fails the arm; it's an advisory tail.
    const claimNote = workItemClaim
      ? workItemClaim.claimed
        ? ` 📌 Auto-claimed work-item ${workItemClaim.id} for this loop — held from wake 1; refresh its work_items:checkpoint each wake (your death-resilience anchor: a successor inherits it if this session dies).`
        : workItemClaim.reason === 'claim_conflict'
          ? ` ⚠ Did NOT auto-claim ${workItemClaim.id} — already held by ${workItemClaim.holder}. Coordinate with them (coord:send); the loop is armed regardless.`
          : workItemClaim.reason.startsWith('fleet_')
            ? ` ⚠ Did NOT auto-claim ${workItemClaim.id} — the fleet admission gate refused this loop binding (${workItemClaim.reason}). ${workItemClaim.hint ?? 'Coordinate with the fleet leader before changing scope.'} The loop is armed regardless.`
            : ` ⚠ Did NOT auto-claim ${workItemClaim.id} (${workItemClaim.reason}); the loop is armed regardless — claim it yourself if this loop drives it.`
      : '';
    // EI-18221784742583615: put the overwrite comparison right after the base note so it
    // is the FIRST thing the arming agent reads — ahead of the claim/warm/cold tails.
    const overwriteNoteText = overwriteNote ? ` ⚠ ${overwriteNote.message}` : '';
    // EI-19395290807657827 — the backoff disclosure. Sits with the other advisory tails,
    // but says something the agent CANNOT infer from the echoed interval alone: whether it
    // was capped, and (when an event was named) that naming it is not the same as parking
    // on it. A silently-capped interval would be worse than no cap at all.
    const backoffNote = backoff.note ? ` ${backoff.note}` : '';

    // EI-21526226279199560 — the caller NAMED an agent in prose but passed no `ref`, so
    // the per-wake liveness check cannot resolve a subject and stays silent. Offered here
    // because this is the one moment it is actionable: the agent is declaring the blocker
    // right now and demonstrably knows the id. Purely advisory — the arm proceeds either
    // way, exactly like the D-098 nudge whose measured effect was 0% → 10.4% adoption.
    const suggestedRef = suggestBlockerRef(args.blockedOn);
    const blockerRefNudge = suggestedRef
      ? ` 💡 Your blocker names \`${suggestedRef}\` but passes no \`ref\`, so each wake can only re-read your own sentence — it cannot check whether that agent is still ALIVE. Re-arm with blockedOn: { reason, kind: 'agent', ref: '${suggestedRef}' } and every wake tells you the moment they die, instead of you discovering it hours later.`
      : '';
    const warningNote = unboundedWarmLoopWarning ? ` ⚠ ${unboundedWarmLoopWarning}` : '';
    // acceptance-runtime-plane P-003 — never throws, never alters the arm.
    const acceptancePlaneAdvisory = await acceptancePlaneAdvisoryForWait({ ownerId, goal });
    // EI-21542193720279374 part (b) — see the coldNoCarryNoteWarning computation above.
    const coldCarryNoteWarningText = coldNoCarryNoteWarning ? ` ⚠ ${coldNoCarryNoteWarning}` : '';
    // EI-18792078711601844: a RE-ARM that PRESERVED the prior loop's carry gets
    // an explicit disclosure, so an omitted carry is never mistaken for a fresh
    // default. Fresh arms are warm and need no exceptional lifecycle warning.
    const carryResolutionNote = carryPreservedFromPrior
      ? ` (carry '${carry}' PRESERVED from the loop's prior config — pass carry explicitly to change it.)`
      : '';
    // EI-19326580626849271 — invert the monitor-loop default toward PUSH.
    //
    // P-009 shipped fleet-transition events so a leader could react to pushes
    // instead of polling, and adoption was ~zero: 1 deliberate await in 48h
    // across 310 agents, while gate events (release:*, green-checkpoint:*) got
    // 66 across 11 agents. The mechanism was never the problem — the keys are
    // catalogued and events:await works. The problem is that nothing offers
    // them at the one moment a leader decides HOW to watch, and this tool's
    // own notWhen actively wrote events:await off as "one-off wakes".
    //
    // mode:'monitor' IS that moment, declared by the caller: a loop that
    // WATCHES rather than works. So name the push path here, with real keys.
    // Deliberately a runtime note rather than more guidance prose: it costs no
    // prompt weight, fires only for monitor loops, and arrives with the keys
    // already spelled out — static guidance is read before the decision, this
    // is read during it. The clock loop stays armed either way; this argues
    // for demoting it to a backstop, never refuses it.
    const monitorPushNote =
      resolvedMode === 'monitor'
        ? ' 📡 Monitor loop armed — but prefer PUSH wherever the thing you are watching already emits. A fleet leader can park on fleet:member-dead · fleet:claim-released · fleet:item-completed · fleet:context-critical via events:await { event, timeout_sec, on_timeout:"wake" }, which wakes you ON the transition instead of N times between transitions. Keep THIS loop as the slow backstop (a longer intervalSec) rather than the primary watcher. events:catalog lists the full set.'
        : '';
    const note =
      baseNote +
      overwriteNoteText +
      backoffNote +
      blockerRefNudge +
      claimNote +
      warningNote +
      coldCarryNoteWarningText +
      carryResolutionNote +
      monitorPushNote;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            loop: {
              name: loop.name,
              ownerId,
              ownerLabel,
              harness,
              intervalSec,
              // EI-19395290807657827 — report the REQUESTED interval alongside the armed
              // one whenever they differ, so a capped backoff is legible in the structured
              // result and not only in the prose note.
              requestedIntervalSec: backoff.clamped ? intervalSecArg : undefined,
              blockedOn: args.blockedOn
                ? {
                    reason: args.blockedOn.reason,
                    event: args.blockedOn.event ?? null,
                    intervalCapped: backoff.clamped,
                    ...(backoff.eventReachability
                      ? { eventReachability: backoff.eventReachability }
                      : {}),
                  }
                : null,
              goal,
              carry,
              continuation: args.continuation ?? 'settle',
              mode: resolvedMode,
              ...(admittedMonitorConfig ? { monitor: admittedMonitorConfig } : {}),
              costCapCents: args.costCapCents ?? null,
              // EI-6878: a re-arm of an ALREADY-armed loop called from WITHIN its own
              // in-flight turn returns the loop's row PARKED at the 'infinity' sentinel
              // (see routines-runtime.ts's upsertRoutine — parking must survive a re-arm
              // so the completion-rebase can still find it). Render that as the literal
              // string below rather than the raw sentinel's ISO date (+275760-09-13),
              // which reads to a caller as "this loop will never fire".
              firstFireAt: !loop.nextFireAt
                ? null
                : isParkedNextFire(loop.nextFireAt)
                  ? 'after-turn-settle'
                  : loop.nextFireAt.toISOString(),
              customWakePrompt: hasCustomWakePrompt,
              workItem: claimedWorkItem,
              controlGeneration: control?.generation ?? null,
            },
            workItemClaim,
            reachability: reachabilityOut,
            unboundedWarmLoopWarning,
            coldNoCarryNoteWarning,
            priorLoopOverwrite: overwriteNote,
            // acceptance-runtime-plane P-003: a loop whose goal waits on main/:3070/a deploy,
            // armed by an agent whose held live acceptance bars run elsewhere. Advisory only.
            ...(acceptancePlaneAdvisory ? { acceptancePlaneAdvisory } : {}),
            ...(mainWaitPlanReview ? { mainWaitPlanReview } : {}),
            note,
          }),
        },
      ],
    };
  },
});
