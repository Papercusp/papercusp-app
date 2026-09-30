/**
 * paused-unit-ei — durable EI escalation for a PERSISTENT administrative pause
 * (EI-20003974512096022 fix 1).
 *
 * The reconciler already detects an administratively disabled/masked supervised
 * unit correctly. What it did with that detection was BROADCAST it — and a
 * broadcast is not addressable after delivery, appears in no backlog, cannot be
 * claimed, and has no owner, so "everyone saw it" and "nobody owns it" are the
 * same state. Measured: `papercup-live-federation-gate.timer` — a release-blocker
 * gate — sat disabled for 2 days across 16 identical broadcasts and not one
 * produced an action, while `RELEASE-READINESS.md` went on citing an 8-day-old
 * green as its evidentiary spine.
 *
 * So past `PAUSE_ESCALATION_MS` the pause stops being an FYI and becomes a
 * durable `engineer_issues` row: it enters the claim queue
 * (`work_items:claimable` / `scheduler:get_next`) where it can be owned, and
 * auto-resolves once the reconciler observes the unit un-paused.
 *
 * Idempotent on the UNIT NAME (`stableTitle`), which is what makes this "file
 * once, not 16 times". `standingCooldownMs` closes the second hole: open-only
 * dedup stops matching the moment some other subsystem retires the EI (hygiene
 * dup-close, a human resolving it), and the very next tick of a STILL-paused
 * unit would otherwise mint a fresh duplicate — WI-5762's measured failure mode
 * (57 duplicates for one standing condition in 7 days). A standing pause is
 * exactly that shape, so it opts in.
 *
 * Same shared machinery, same wrapper shape, as `give-up-ei.ts` — this module is
 * only the paused-unit binding (topic, title, body, resolve note).
 */

import { createEpisodicEscalator, type EpisodicEiDeps } from '../escalation/episodic-ei';
import { formatPauseDuration } from './pause-clock';

export const SUPERVISION_PAUSED_TOPIC = 'supervision-paused';

/** The literal prefix every title this escalator mints starts with. Feeding it
 *  to the factory makes every population read `topic-tagged ∪ title-prefixed`
 *  (WI-37499) — without it, a row whose topic edge failed to write is invisible
 *  to dedup, resolve AND the cooldown gate simultaneously, which is precisely
 *  how duplicates accumulate unseen. */
const TITLE_PREFIX = '[supervision-paused] ';

/** One persistent-pause episode. */
export interface SupervisionPausedEpisode {
  unit: string;
  /** How long the unit had been paused when we filed, in ms. */
  pausedForMs: number;
  /** Epoch ms the pause clock first observed it — stated in the body so a
   *  triager can correlate against the journal without re-deriving it. */
  pausedSince: number;
  /**
   * EI-20302762698704679: WHY (and by whom) the pause was annotated via
   * `supervision:annotate-pause`, if it ever was. Null/undefined means genuinely never
   * annotated — `buildPausedBody` treats that absence itself as the anomaly to report,
   * since a pause with no recorded reason/owner is what escalates into the void.
   */
  reason?: string | null;
  by?: string | null;
  reviewBy?: string | null;
}

/** The (unit) identity `resolveSupervisionPausedEi` needs to find the EI a
 *  resumed unit should close — the same field `supervisionPausedEiTitle` keys on. */
export interface ResumedSupervisionEpisode {
  unit: string;
}

/** Stable, dedup-able title for one unit's pause episode — keyed on the unit
 *  ONLY (not the duration), so a pause that ages from 4h to 3 days stays a
 *  SINGLE open EI that grows more urgent rather than a new row per tier. */
export function supervisionPausedEiTitle(x: { unit: string }): string {
  return `${TITLE_PREFIX}\`${x.unit}\` has been administratively disabled/masked for hours — supervised unit dark with no owner`;
}

/** Resolver identity stamped on auto-resolved paused EIs. */
export const RESUME_OWNER = 'system:supervision-reconciler';

/** DI seam so the dedup+file logic unit-tests without PG. */
export type SupervisionPausedEiDeps = EpisodicEiDeps<'major'>;

function buildPausedBody(episode: SupervisionPausedEpisode): string {
  const dur = formatPauseDuration(episode.pausedForMs);
  // EI-20302762698704679: this IS the anomaly the bug report asks to surface — lead with it. A
  // pause with a recorded reason/owner is not itself a defect; a pause with NEITHER is the actual
  // failure mode (supervision escalating into the void with nobody to ask).
  const reasonLine = episode.reason
    ? `**Reason on record:** ${episode.reason}${episode.by ? ` (annotated by ${episode.by})` : ''}${
        episode.reviewBy ? `, review by ${episode.reviewBy}` : ''
      }.\n\n`
    : `**⚠ NO REASON WAS RECORDED for this pause.** Nobody has said, via \`supervision:annotate-pause\`, ` +
      `why \`${episode.unit}\` was disabled or who did it — which is the primary anomaly this EI ` +
      `exists to report, not just the pause itself. If you know why it's paused, annotate it now.\n\n`;
  return (
    reasonLine +
    `\`${episode.unit}\` is a SUPERVISED unit (it is in \`SUPERVISED_PROCESSES\`, i.e. something ` +
    `judged critical enough to auto-restart) and it has been administratively ` +
    `disabled or masked for ${dur}, since ${new Date(episode.pausedSince).toISOString()}.\n\n` +
    `The reconciler is deliberately NOT fighting the pause — a \`disabled\`/\`masked\` unit file ` +
    `state means a human or agent explicitly told systemd not to run this, and overriding that ` +
    `would be worse than the outage. This EI is not a request to re-enable it. It exists because ` +
    `nothing in the ledger currently knows the unit is dark.\n\n` +
    `**Triage — answer one question: is this pause still intended?**\n` +
    `- **Yes, still intended.** Say so on this EI (who paused it, why, and what would end the ` +
    `pause) and close it. The record is the point; a pause with a written reason and an owner is ` +
    `not a defect.\n` +
    `- **No / nobody knows.** Then this is the real failure mode — re-enable it ` +
    `(\`systemctl --user enable --now ${episode.unit}\`) and confirm it comes back healthy.\n\n` +
    `⚠ Do NOT re-enable a unit whose pause you cannot account for WITHOUT checking for a standing ` +
    `owner instruction first — a pause ordered by the owner is a wall, not a bug, and re-arming it ` +
    `is a decision that belongs to them. Check \`coord:walls\` and \`facts:list\` for a wall naming ` +
    `this unit before touching it.\n\n` +
    `Filed automatically because a broadcast alone (\`*\`, expects:'none') leaves a dark supervised ` +
    `unit unowned indefinitely. This EI auto-resolves once the reconciler observes ` +
    `\`${episode.unit}\` no longer paused.`
  );
}

const escalator = createEpisodicEscalator<SupervisionPausedEpisode, ResumedSupervisionEpisode, 'major'>({
  topic: SUPERVISION_PAUSED_TOPIC,
  stableTitle: supervisionPausedEiTitle,
  buildBody: buildPausedBody,
  resolveNote: (resumed) => `auto-resolved: \`${resumed.unit}\` is no longer administratively paused`,
  // 'major', not the give-up path's 'critical': the unit is down ON PURPOSE and
  // the reconciler is respecting that. What is broken is the BOOKKEEPING (dark
  // and unowned), which is exactly a major, not a page-someone-now critical.
  severity: 'major',
  createdBy: 'system:supervision-reconciler',
  foundDuring: 'supervision-reconcile',
  recoveryOwner: RESUME_OWNER,
  extraTopics: ['supervision'],
  titlePrefix: TITLE_PREFIX,
  // A standing pause outlives any single EI's lifecycle — see the module note.
  standingCooldownMs: 24 * 60 * 60 * 1000,
});

/** Test seam. */
export function _resetSupervisionPausedEiForTests(): void {
  escalator._resetForTests();
}

/**
 * File a durable EI for a persistent-pause episode, deduplicating against an
 * already-open EI for the same unit. Returns the EI id when filed, null when
 * deduped or on failure (best-effort — never blocks or fails the tick).
 */
export function fileSupervisionPausedEi(
  episode: SupervisionPausedEpisode,
  deps?: SupervisionPausedEiDeps,
): Promise<string | null> {
  return escalator.file(episode, deps);
}

/**
 * Auto-resolve every open pause EI for this unit once the reconciler observes it
 * un-paused. No-ops (returns `[]`) when none match — the normal case.
 */
export function resolveSupervisionPausedEi(
  resumed: ResumedSupervisionEpisode,
  deps?: SupervisionPausedEiDeps,
): Promise<string[]> {
  return escalator.resolve(resumed, deps);
}
