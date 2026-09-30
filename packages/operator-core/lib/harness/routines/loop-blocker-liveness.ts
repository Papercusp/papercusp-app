/**
 * loop-blocker-liveness.ts — EI-21526226279199560.
 *
 * THE BUG. An agent blocked on a peer keeps waiting long after that peer stops
 * progressing, reporting "nothing actionable" each wake — correctly and cheaply — while
 * the wait itself has become invalid. Measured instance: su-fef75d27 held a freeze
 * imposed by su-d6ae254f; that peer went `suspect` ~11:41Z and `ended` ~13:50Z, and the
 * hold continued until the OWNER asked a direct question at ~14:20Z. ~2.5h of dead
 * waiting across 6 clean wakes.
 *
 * WHY MORE PROSE WOULD NOT HAVE FIXED IT — and this is the whole design constraint.
 * The su playbook ALREADY carries the correct rule ("A WAIT IS ONLY OK WHILE THE
 * BLOCKER IS VISIBLY PROGRESSING ... OWN THE UNBLOCK"). It was in the agent's prompt the
 * entire 2.5 hours. It did not fire for three structural reasons, none of which another
 * paragraph can repair:
 *   1. It triggers on a NON-EVENT. Every other rule hangs off an action (before you
 *      edit, claim; before you report a number, read the writer). "Keep waiting" is the
 *      ABSENCE of an action, so nothing prompts the check.
 *   2. "Visibly progressing" had NO CLOCK. With no declared deadline no individual wake
 *      feels like the one to act on — each is only 30-60min more than the last, and the
 *      previous five all ended safely.
 *   3. EFFICIENCY HID IT. The agent optimised its probe to 440 chars and was pleased. A
 *      cheap, correct-looking probe returning the same answer every hour reads as
 *      CONFIRMATION that nothing is wrong.
 * So the fix cannot be a better instruction; it has to put the fact in front of the
 * agent unasked. This module turns the non-event into an event.
 *
 * ⚠ LIVENESS IS NOT CLEARANCE — the distinction this module is built on.
 * `blocked-on-status.ts` resolves a coord `blockedOn` at read time and deliberately
 * emits NO verdict for kind 'agent' (only 'work-item' and 'event'), because "an agent's
 * progress has no single ledger row that settles 'cleared', and a guessed verdict is
 * worse than none" (D-003). That refusal is CORRECT and is preserved here: this module
 * never says a blocker cleared. It answers a different and strictly answerable
 * question — "is the agent I am waiting on still ALIVE?" — for which there IS exactly
 * one shared oracle, `sessionState`, the same verdict behind coord:presence,
 * fleet:status and the send-miss report. Stamp liveness; never infer clearance.
 *
 * ⚠ NEVER ANNOUNCE WHAT WAS NOT MEASURED. An unresolved subject (`sessionState: null`,
 * the oracle's explicit unknown) produces NO line rather than a reassuring or an
 * alarming one — the same rail `loop-goal-staleness` and `loop-goal-fact-divergence`
 * carry. Only a positive reading speaks.
 *
 * Pure + clock-free: the liveness verdict and the current time arrive as data, so every
 * branch is exhaustively testable with no PG and no wall clock.
 */

/** The blocker a loop declared, as persisted on `payload_template.blockedOn`. */
export interface LoopBlockedOnRecord {
  /** Prose, always present — what the agent said it was waiting for. */
  reason: string;
  /**
   * What KIND of thing the blocker is. Mirrors coord's `blockedOn.kind` (D-003) so the
   * two surfaces describe a blocker the same way rather than drifting into two
   * vocabularies for one concept.
   */
  kind?: 'agent' | 'work-item' | 'event' | 'process' | 'owner' | 'other' | null;
  /** The blocker's identity — an ownerId for kind 'agent'. Prose is not diffable; a ref is. */
  ref?: string | null;
  /** The events:catalog key that fires when this blocker clears, if one was named. */
  event?: string | null;
  /** ISO timestamp the block was declared — the CLOCK's origin. */
  since?: string | null;
}

/**
 * Is this the SAME blocker the loop was already waiting on?
 *
 * Identity is the ref when there is one (`kind:'agent'` + ownerId is diffable; that is
 * the whole point of D-003's ref), and the normalised reason otherwise, because a
 * ref-less blocker has nothing else to be identified by.
 */
function isSameBlocker(a: LoopBlockedOnRecord, b: LoopBlockedOnRecord): boolean {
  const aRef = a.ref?.trim();
  const bRef = b.ref?.trim();
  if (aRef && bRef) return a.kind === b.kind && aRef === bRef;
  if (aRef || bRef) return false;
  return a.reason.trim().toLowerCase() === b.reason.trim().toLowerCase();
}

/**
 * The clock's origin — and the one decision that determines whether the elapsed-wait
 * branch EVER fires.
 *
 * An AUTO loop re-arms constantly (to retune the interval, to re-state the goal), and a
 * blocked agent re-arms while still blocked on the very same thing. So if each arm
 * stamped `since = now`, the measured wait would reset to ~0 on every wake and
 * `wait-exceeded-clock` would be unreachable code — a feature that ships, looks
 * implemented, and never once speaks. Carrying the origin forward across a re-arm of the
 * SAME blocker is what makes the clock measure the CONTINUOUS wait rather than the gap
 * between two arms.
 *
 * It resets when the blocker genuinely changes, which is correct: that is a new wait.
 *
 * Deliberately not the caller's job. Asking the agent to pass its own `since` would make
 * the clock depend on the same discipline this whole module exists because agents do not
 * reliably exercise — and an agent that forgot would silently disable its own alarm.
 */
export function resolveBlockedSince(
  next: LoopBlockedOnRecord,
  prior: LoopBlockedOnRecord | null | undefined,
  nowIso: string,
): string {
  if (!prior || typeof prior.reason !== 'string') return nowIso;
  if (!isSameBlocker(next, prior)) return nowIso;
  const carried = prior.since?.trim();
  if (!carried || !Number.isFinite(Date.parse(carried))) return nowIso;
  return carried;
}

/**
 * The agent id a caller NAMED IN PROSE while passing no `ref` — or null.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT DOCUMENTATION. The liveness branch above can only
 * fire for a blocker carrying `kind:'agent'` + `ref`, so a `kind` nobody passes makes the
 * headline case unreachable — the same "field nobody populates" trap this whole change
 * exists to close, reintroduced one level down. It is not hypothetical: of 1,014
 * `blockedOn` declarations in 14 days (measured 2026-09-05), 127 already NAME a session
 * id in their reason text while passing no ref at all. Those agents know exactly who they
 * are waiting on; they simply have no idea the structured field would buy them anything.
 *
 * D-098 is the precedent, and it is a measured one: `blockedOn` itself sat at ZERO uses
 * until it was surfaced at the moment it was actionable, and now runs at 10.4% of arms.
 * So this follows those constraints exactly — advisory, no rejection, no behaviour
 * change, fail-open — and fires only when the caller has already demonstrated they know
 * the id, which is what keeps it rare enough to be read rather than becoming scenery.
 */
export function suggestBlockerRef(
  blockedOn: { reason?: string; ref?: string | null } | null | undefined,
): string | null {
  if (!blockedOn || typeof blockedOn.reason !== 'string') return null;
  if (blockedOn.ref?.trim()) return null; // already structured — nothing to suggest
  const m = /\b((?:su|cup|bee)-[0-9a-f]{6,}(?:-[0-9a-f]+)*)/i.exec(blockedOn.reason);
  return m ? m[1] : null;
}

/** The blocker's liveness as returned by THE oracle (`resolveSessionStates`). */
export interface BlockerLiveness {
  /**
   * The oracle's verdict, or null when it could not be measured. Null is an explicit
   * unknown, never "fine" — it yields no stamp.
   */
  sessionState: 'live' | 'parked' | 'draining' | 'suspect' | 'ended' | 'recorded' | null;
  /** Milliseconds since the blocker last took a turn, when known. */
  lastActiveMsAgo?: number | null;
}

/**
 * How long a wait on a still-alive blocker may run before it is worth surfacing.
 *
 * ⚠ THIS IS A JUDGEMENT, NOT A MEASUREMENT — stated plainly because the sibling
 * detector in this directory (`loop-goal-fact-divergence`) carries a genuinely measured
 * firing rate, and an unmeasured constant sitting next to a measured one would read as
 * though it had the same standing. It does not. It CANNOT be measured today: zero loops
 * currently persist a `blockedOn` record at all (0 of 4651 in this workspace, measured
 * 2026-09-05), which is the very gap this change closes, so there is no population to
 * measure a rate against yet.
 *
 * Chosen relative to the harm: the measured incident ran 2.5h, and a blocker-motivated
 * interval is itself capped at 15min without a proven clearing event, so an hour is
 * several wakes deep — clearly past "just started" and well short of the observed
 * damage. ONCE loops carry blockers, measure the real firing rate the way the divergence
 * detector's was measured and retune this from data, deleting this paragraph when you do.
 */
export const BLOCKER_WAIT_SURFACE_MS = 60 * 60 * 1000;

export interface BlockerLivenessVerdict {
  /** The wake annotation, or null when there is nothing honest to say. */
  note: string | null;
  /**
   * Why it spoke, for tests and for callers that want to log the trigger without
   * re-parsing prose. Null exactly when `note` is null.
   */
  trigger: 'blocker-dead' | 'blocker-suspect' | 'wait-exceeded-clock' | null;
}

const SILENT: BlockerLivenessVerdict = { note: null, trigger: null };

/** Render a duration the way a reader reasons about a wait: "2h 39m", "14m". */
export function formatWaitDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return 'under a minute';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * The annotation.
 *
 * SILENT UNLESS THERE IS SOMETHING ACTIONABLE. A reassurance on every healthy wake would
 * be scenery within a day, and scenery is exactly what the generic "wait only while
 * progressing" caution already became — that is the failure this module exists to
 * correct, so reproducing it here would be self-defeating. It speaks in three cases:
 * the blocker is DEAD, the blocker is SUSPECT, or the wait has outrun the clock while
 * the blocker is merely alive-but-not-necessarily-progressing.
 *
 * Note the asymmetry between the first two cases and the third: a dead or suspect
 * blocker is stamped IMMEDIATELY, with no elapsed-time gate, because the wait is already
 * invalid and every further wake is pure loss. Waiting an hour to say so would rebuild
 * the delay this is meant to remove.
 */
export function assessBlockerLiveness(
  blockedOn: LoopBlockedOnRecord | null | undefined,
  liveness: BlockerLiveness | null | undefined,
  nowMs: number,
): BlockerLivenessVerdict {
  if (!blockedOn || typeof blockedOn.reason !== 'string' || !blockedOn.reason.trim()) {
    return SILENT;
  }

  const waitedMs = parseSince(blockedOn.since, nowMs);
  const waited = waitedMs == null ? null : formatWaitDuration(waitedMs);
  const state = liveness?.sessionState ?? null;

  // kind:'agent' is the only kind whose liveness this resolves. A work-item or event
  // blocker has its OWN clearance mechanism (blocked-on-status.ts); a process, owner or
  // 'other' blocker has no oracle at all, and inventing one is the fabrication D-003
  // banned. Those kinds still get the elapsed-clock branch below, which needs no oracle.
  const isAgent = blockedOn.kind === 'agent' && !!blockedOn.ref;
  const who = blockedOn.ref ? `${blockedOn.ref}` : 'the blocker';

  if (isAgent && (state === 'ended' || state === 'recorded')) {
    return {
      trigger: 'blocker-dead',
      note:
        `⚠⚠ THE AGENT YOU ARE BLOCKED ON IS DEAD — ${who} has sessionState='${state}'` +
        `${lastActiveClause(liveness)}, and you have been waiting${waited ? ` ${waited}` : ''} on: ` +
        `"${blockedOn.reason.trim()}". THIS WAIT IS ALREADY INVALID; it will not clear on its own and ` +
        `no further wake will change that. Waking it is pointless (a dead session cannot be woken — ` +
        `it needs a RELAUNCH, not a wake). OWN THE UNBLOCK NOW: take the work over yourself, ` +
        `redirect to a live driver (coord:presence → sessionState:'live'), or escalate WITH this ` +
        `finding. Then re-arm without blockedOn and RESTORE your normal cadence.`,
    };
  }

  if (isAgent && state === 'suspect') {
    return {
      trigger: 'blocker-suspect',
      note:
        `⚠ THE AGENT YOU ARE BLOCKED ON MAY BE GONE — ${who} has sessionState='suspect'` +
        `${lastActiveClause(liveness)}; you have been waiting${waited ? ` ${waited}` : ''} on: ` +
        `"${blockedOn.reason.trim()}". 'suspect' is the state that precedes 'ended', so treat this as ` +
        `the LAST wake on which waiting is still defensible. Verify progress directly — has their ` +
        `claim moved, has their code landed — rather than waiting one more interval to see. If it ` +
        `has not moved, the blocker is STRANDED and clearing it is now YOUR responsibility.`,
    };
  }

  if (waitedMs != null && waitedMs >= BLOCKER_WAIT_SURFACE_MS) {
    return {
      trigger: 'wait-exceeded-clock',
      note:
        `⏱ YOU HAVE BEEN BLOCKED ${waited} — on: "${blockedOn.reason.trim()}"` +
        `${state ? ` (${who}: sessionState='${state}'${lastActiveClause(liveness)})` : ''}. ` +
        `This line is the CLOCK a wait otherwise has no way to keep: each wake feels only slightly ` +
        `longer than the last, so no single one ever feels like the one to act on. Decide DELIBERATELY ` +
        `now rather than by default: is the blocker demonstrably ADVANCING (its owner alive AND ` +
        `committing, its state changing)? If yes, keep waiting. If you cannot show that it moved, the ` +
        `wait is no longer justified — own the unblock, or do other unblocked work instead of ` +
        `re-confirming the same answer next wake.`,
    };
  }

  return SILENT;
}

/** `since` → elapsed ms, or null when absent/unparseable (never a fabricated zero). */
function parseSince(since: string | null | undefined, nowMs: number): number | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  const delta = nowMs - t;
  return delta >= 0 ? delta : null;
}

/** ", last active 2h 39m ago" — omitted entirely when unknown, never guessed. */
function lastActiveClause(liveness: BlockerLiveness | null | undefined): string {
  const ms = liveness?.lastActiveMsAgo;
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  return `, last active ${formatWaitDuration(ms)} ago`;
}
