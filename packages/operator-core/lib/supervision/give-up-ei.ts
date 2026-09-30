/**
 * give-up-ei — durable EI escalation for a supervision give-up (EI-19966318801100410).
 *
 * The failed-unit reconciler (`unit-reconciler.ts`) gives up restarting a unit after
 * `GIVE_UP_THRESHOLD` restarts inside `GIVE_UP_WINDOW_MS` and broadcasts a `*` /
 * `expects:'none'` escalation — which every recipient is correctly told to skip unless it
 * bears on their task, so the broadcast alone leaves the give-up UNOWNED. Measured
 * 2026-08-09: `papercup-staging-api` (:3170) sat DOWN ~6min after a give-up, recovered only
 * because an agent working an unrelated lane happened to look.
 *
 * This files a durable `engineer_issues` row (an EI) on give-up, so the down unit enters the
 * claim queue (`work_items:claimable` / `scheduler:get_next`) instead of depending on someone
 * reading a broadcast that named nobody, and auto-resolves the EI once the reconciler observes
 * the unit recovered.
 *
 * EI-9030a shared machinery: `createEpisodicEscalator` (`../escalation/episodic-ei.ts`) — this
 * module is only the give-up binding (topic, title, body, resolve note), same shape as
 * `sync/hyperbee/replication-stall-ei.ts` and `memory/bench/precision-alert-ei.ts`.
 */

import { createEpisodicEscalator, type EpisodicEiDeps } from '../escalation/episodic-ei';

export const SUPERVISION_GIVE_UP_TOPIC = 'supervision-give-up';

/**
 * One give-up episode. `causeSuffix` is the SAME diagnostic suffix text
 * (`unit-reconciler.ts`'s `failureCauseSuffix()` — either `" Cause: ..."` or
 * `" Cause unavailable; ..."`) already computed for the coord broadcast, so the EI body never
 * re-derives (or disagrees with) it.
 */
export interface SupervisionGiveUpEpisode {
  unit: string;
  restartsInWindow: number;
  causeSuffix: string;
}

/** The (unit) identity `resolveSupervisionGiveUpEi` needs to find the EI a recovered episode
 *  should close — the same field `supervisionGiveUpEiTitle` keys on. */
export interface RecoveredSupervisionEpisode {
  unit: string;
}

/** Stable, dedup-able title for one unit's give-up episode — keyed on the unit only (not the
 *  restart count or cause), so a unit that flaps through several give-ups before anyone
 *  triages it stays a SINGLE open EI rather than accumulating one per episode. */
export function supervisionGiveUpEiTitle(x: { unit: string }): string {
  return `[supervision] \`${x.unit}\` crash-looped — reconciler GAVE UP (needs investigation)`;
}

/** Resolver identity stamped on auto-resolved give-up EIs. */
export const RECOVERY_OWNER = 'system:supervision-reconciler';

/** DI seam so the dedup+file logic unit-tests without PG. */
export type SupervisionGiveUpEiDeps = EpisodicEiDeps<'critical'>;

/** The EI body for a to-file give-up episode. */
function buildGiveUpBody(episode: SupervisionGiveUpEpisode): string {
  return (
    `supervision-reconciler gave up restarting \`${episode.unit}\` after ` +
    `${episode.restartsInWindow} restarts within its give-up window — this reads as a durable ` +
    `code fault, not a transient, so the reconciler has STOPPED auto-restarting it.` +
    `${episode.causeSuffix}\n\n` +
    `Triage: \`systemctl --user status ${episode.unit}\` + its journal ` +
    `(\`journalctl --user -u ${episode.unit}\`).\n` +
    `- If the cause looks TRANSIENT (e.g. a shared-tree mid-refactor window mid-bundle/build ` +
    `step — EI-19966318801100410's own instance), re-run the failing step by hand to confirm it ` +
    `reproduces; if it does not, \`systemctl --user reset-failed ${episode.unit} && systemctl ` +
    `--user restart ${episode.unit}\` clears it and this EI should be closed as a false alarm.\n` +
    `- If it DOES reproduce, this is a real regression — fix it, then confirm the unit stays up ` +
    `through at least one full restart cycle before closing.\n\n` +
    `Filed automatically because a give-up broadcast alone (\`*\`, expects:'none') leaves the ` +
    `down unit unaddressed indefinitely — nobody owns an unaddressed broadcast. This EI ` +
    `auto-resolves once the reconciler next observes \`${episode.unit}\` recovered.`
  );
}

const escalator = createEpisodicEscalator<SupervisionGiveUpEpisode, RecoveredSupervisionEpisode, 'critical'>({
  topic: SUPERVISION_GIVE_UP_TOPIC,
  stableTitle: supervisionGiveUpEiTitle,
  buildBody: buildGiveUpBody,
  resolveNote: (recovery) => `auto-resolved: \`${recovery.unit}\` recovered`,
  severity: 'critical',
  createdBy: 'system:supervision-reconciler',
  foundDuring: 'supervision-reconcile',
  recoveryOwner: RECOVERY_OWNER,
  // The factory's own default (`['federation']`) is tailored to its first caller
  // (replication-stall-ei.ts) and does not fit a systemd supervision give-up — override it,
  // same as precision-alert-ei.ts's ['memory', 'observability'].
  extraTopics: ['supervision'],
});

/** Test seam. */
export function _resetSupervisionGiveUpEiForTests(): void {
  escalator._resetForTests();
}

/**
 * File a durable EI for a give-up episode, deduplicating against an already-open EI for the
 * same unit. Returns the EI id when filed, null when deduped or on failure (best-effort — the
 * caller never lets this block or fail the give-up broadcast itself).
 */
export function fileSupervisionGiveUpEi(
  episode: SupervisionGiveUpEpisode,
  deps?: SupervisionGiveUpEiDeps,
): Promise<string | null> {
  return escalator.file(episode, deps);
}

/**
 * Auto-resolve every open give-up EI for this unit once the reconciler observes it recovered
 * (`decideReconcile`'s 'recovered' transition — down -> healthy). No-ops (returns `[]`) when no
 * open EI matches — the normal case (either no give-up ever happened for this unit, or an
 * earlier recovery already resolved it). Best-effort; resolves each match independently so one
 * failure never strands its siblings.
 */
export function resolveSupervisionGiveUpEi(
  recovery: RecoveredSupervisionEpisode,
  deps?: SupervisionGiveUpEiDeps,
): Promise<string[]> {
  return escalator.resolve(recovery, deps);
}
