/**
 * Tell somebody when a reaction fails (P-030 clause b).
 *
 * The plan item assumed a failed fire already "lands in the fire log … but
 * NOBODY IS TOLD". Measured, the premise was wrong in a worse direction: nobody
 * is told because NOTHING IS WRITTEN. `markReactionFailed` had no caller, the
 * durable executor DELETES its claim row on dispatch failure so a retry can
 * re-fire, and the live in-process route — the default, since
 * `durableReactionsEnabled()` is false without `PAPERCUSP_DBOS_REACTIONS=1` —
 * never touched `event_reactions` at all. A failed reaction was one
 * `console.warn` in a process nobody tails.
 *
 * So this is two things, in order:
 *   1. RECORD it (`recordReactionFailure`) — the durable evidence that did not exist;
 *   2. SURFACE it — alert the owner naming the rule, its contributor, and the
 *      capability it needs.
 *
 * Both are best-effort and never throw: a reaction has already failed, and
 * failing to report that must not become a second, louder failure.
 */

import { reactionContributor, type ReactionFailure } from '@papercusp/event-reaction';
import { countRecentReactionFailures, recordBudgetDenial, recordReactionFailure } from './reaction-dedup';
import type { ToolInvocationEvent } from './types';

/** How long one rule stays quiet after an alert, so a hot-looping rule cannot spam. */
export const REACTION_FAILURE_ALERT_WINDOW_MINUTES = 60;

/** What KIND of failure this was — decides whether an owner can act on it. */
export type ReactionFailureKind =
  /** The rule fired a tool its capability scope does not permit — the wearer lacks it. */
  | 'capability'
  /** A `class:<ref>#<verb>` fire had no provider binding in the firing pot. */
  | 'unresolved-provider'
  /** The fire target is not a registered tool at all. */
  | 'unknown-tool'
  /** Anything else — a real dispatch error from the tool itself. */
  | 'other';

export interface ReactionFailureClassification {
  kind: ReactionFailureKind;
  /**
   * The capability the rule NEEDS, when that is the problem. Taken from
   * `rule.capability` — the scope the reaction ran under — not parsed out of the
   * error text, which is the dispatcher's prose and not a contract.
   */
  capability?: string;
}

/**
 * Classify a failure from the dispatcher's error text plus the rule's own scope.
 *
 * Only the CODE prefix is matched (`dispatch-reaction.ts` formats a refusal as
 * `"<code>: <message>"`); the message half is free prose and is never matched on.
 */
export function classifyReactionFailure(
  error: string,
  rule: { capability?: string },
): ReactionFailureClassification {
  const code = error.includes(':') ? error.slice(0, error.indexOf(':')).trim() : '';
  if (code === 'missing_capability' || code === 'capability_denied') {
    return rule.capability ? { kind: 'capability', capability: rule.capability } : { kind: 'capability' };
  }
  // The class-fire resolver's own refusals (dispatch-reaction.ts `resolveClassFire`)
  // are plain sentences, not coded — they are identified by their subject.
  if (/\bno (?:pot binding|provider binding|pot)\b/.test(error) || error.startsWith('resolving "')) {
    return { kind: 'unresolved-provider' };
  }
  if (error.startsWith('unknown reaction tool ') || error.includes('is not a registered tool')) {
    return { kind: 'unknown-tool' };
  }
  return { kind: 'other' };
}

/** The owner-facing sentence for one failed reaction. Pure, so it is directly testable. */
export function formatReactionFailureAlert(opts: {
  ruleId: string;
  fire: string;
  contributor?: string | null;
  classification: ReactionFailureClassification;
  error: string;
  windowMinutes: number;
}): string {
  const by = opts.contributor ? ` (contributed by ${opts.contributor})` : '';
  const head = `⚠️ Reaction rule "${opts.ruleId}"${by} could not fire "${opts.fire}"`;
  const quiet = `Further failures of this rule are suppressed for ${opts.windowMinutes}m.`;
  switch (opts.classification.kind) {
    case 'capability':
      return (
        `${head}: it needs capability "${opts.classification.capability ?? '(unscoped)'}", which the identity ` +
        `wearing it does not hold. Grant that capability or uninstall the rule. ${quiet}`
      );
    case 'unresolved-provider':
      return `${head}: no provider in this pot binds that capability class. ${opts.error} ${quiet}`;
    case 'unknown-tool':
      return `${head}: ${opts.error} — the rule targets a tool that does not exist. ${quiet}`;
    default:
      return `${head}: ${opts.error} ${quiet}`;
  }
}

/**
 * Whether a failure of this kind is worth waking the owner for.
 *
 * A capability denial, a missing provider binding and a nonexistent tool are all
 * INSTALL-TIME mistakes an owner can fix, and they repeat forever until someone
 * does. An ordinary dispatch error is the tool's own runtime failure — recorded,
 * not alerted, or every transient blip becomes a notification.
 */
export function shouldAlertOwner(kind: ReactionFailureKind): boolean {
  return kind === 'capability' || kind === 'unresolved-provider' || kind === 'unknown-tool';
}

/**
 * Record a reaction failure durably and, when it is actionable and not already
 * alerted this window, tell the owner.
 *
 * Never throws.
 */
export async function surfaceReactionFailure(
  failure: ReactionFailure<ToolInvocationEvent, string>,
  deps?: {
    record?: typeof recordReactionFailure;
    recordDenial?: typeof recordBudgetDenial;
    countRecent?: typeof countRecentReactionFailures;
    alert?: (workspaceId: string, summary: string) => Promise<void>;
    log?: (msg: string) => void;
  },
): Promise<void> {
  const log = deps?.log ?? ((msg: string) => console.warn(`[events] ${msg}`));
  const record = deps?.record ?? recordReactionFailure;
  const recordDenial = deps?.recordDenial ?? recordBudgetDenial;
  const countRecent = deps?.countRecent ?? countRecentReactionFailures;
  const alert = deps?.alert ?? alertOwner;

  const workspaceId = failure.event.ctx.workspaceId ?? failure.event.ctx.principal?.workspaceId ?? null;
  if (!workspaceId) {
    // Without a workspace there is no ledger row to write and no owner to wake.
    log(`reaction ${failure.rule.id} failed with no workspace to attribute it to: ${failure.error}`);
    return;
  }

  // The SAME key the engine budgets on: null for a first-party rule, whose
  // `source` is only a provenance label (WI-10005204). The ledger's partial
  // contributor index and its "first-party NULL bucket" both assume this.
  const contributor = reactionContributor(failure.rule);

  // A budget denial is NOT a dispatch failure, and every step below assumes it
  // is: it would record `status='failed'`, classify the budget's own prose as
  // `'other'` (so nobody is told), and — worst — feed the denial back into the
  // fire count the budget reads. Branch before any of that happens.
  if (failure.stage === 'budget') {
    await surfaceBudgetDenial(failure, { workspaceId, contributor, recordDenial, countRecent, alert, log });
    return;
  }

  try {
    await record({
      dedupId: failure.dedupId,
      workspaceId,
      ruleId: failure.rule.id,
      fire: failure.fire,
      error: failure.error,
      triggerTool: failure.event.tool ?? null,
      causeRootRunId: failure.cause.rootRunId ?? null,
      depth: failure.cause.depth,
      contributor,
    });
  } catch (e) {
    log(`recording reaction failure for ${failure.rule.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    // Keep going: an un-recorded failure is still worth alerting on.
  }

  const classification = classifyReactionFailure(failure.error, failure.rule);
  if (!shouldAlertOwner(classification.kind)) return;

  try {
    // Debounce against the LEDGER, not an in-process cache — a rule that fails on
    // every tool call must alert once, not thousands of times, and must stay quiet
    // across the restarts that would reset any in-memory window.
    const prior = await countRecent({
      workspaceId,
      ruleId: failure.rule.id,
      contributor,
      windowMinutes: REACTION_FAILURE_ALERT_WINDOW_MINUTES,
      excludeDedupId: failure.dedupId,
    });
    if (prior > 0) return;

    await alert(
      workspaceId,
      formatReactionFailureAlert({
        ruleId: failure.rule.id,
        fire: failure.fire,
        contributor,
        classification,
        error: failure.error,
        windowMinutes: REACTION_FAILURE_ALERT_WINDOW_MINUTES,
      }),
    );
  } catch (e) {
    log(`alerting owner about reaction ${failure.rule.id} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The owner-facing sentence for a budget denial. Pure, so it is directly testable. */
export function formatBudgetDenialAlert(opts: {
  ruleId: string;
  fire: string;
  contributor?: string | null;
  reason: string;
  windowMinutes: number;
}): string {
  const by = opts.contributor ? ` (contributed by ${opts.contributor})` : '';
  return (
    `⚠️ Reaction rule "${opts.ruleId}"${by} was NOT fired at "${opts.fire}": ${opts.reason}. ` +
    `Reactions from this contributor are being dropped until its rate falls back under the budget. ` +
    `Uninstall or narrow the rule if this is not expected. ` +
    `Further denials for this rule are suppressed for ${opts.windowMinutes}m.`
  );
}

/**
 * Record and surface a reaction the fire budget refused (P-030 c).
 *
 * A denial is ALWAYS owner-actionable — unlike a dispatch error there is no
 * transient-blip case, because crossing the budget means a contributor has been
 * firing steadily for a whole window — so it skips `classifyReactionFailure` /
 * `shouldAlertOwner` entirely and goes straight to the debounced alert.
 *
 * Both halves are best-effort and never throw: the reaction has already been
 * dropped, and failing to report that must not become a second failure.
 */
async function surfaceBudgetDenial(
  failure: ReactionFailure<ToolInvocationEvent, string>,
  ctx: {
    workspaceId: string;
    contributor: string | null;
    recordDenial: typeof recordBudgetDenial;
    countRecent: typeof countRecentReactionFailures;
    alert: (workspaceId: string, summary: string) => Promise<void>;
    log: (msg: string) => void;
  },
): Promise<void> {
  try {
    await ctx.recordDenial({
      dedupId: failure.dedupId,
      workspaceId: ctx.workspaceId,
      ruleId: failure.rule.id,
      fire: failure.fire,
      reason: failure.error,
      triggerTool: failure.event.tool ?? null,
      causeRootRunId: failure.cause.rootRunId ?? null,
      depth: failure.cause.depth,
      contributor: ctx.contributor,
    });
  } catch (e) {
    ctx.log(`recording budget denial for ${failure.rule.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    // Keep going: an un-recorded denial is still worth alerting on.
  }

  try {
    // Debounce against PRIOR DENIALS, not prior failures — see
    // `countRecentReactionFailures`'s `status` note. A contributor over budget
    // is denied on every subsequent fire, so without this the alert would be as
    // loud as the runaway it is reporting.
    const prior = await ctx.countRecent({
      workspaceId: ctx.workspaceId,
      ruleId: failure.rule.id,
      contributor: ctx.contributor,
      windowMinutes: REACTION_FAILURE_ALERT_WINDOW_MINUTES,
      excludeDedupId: failure.dedupId,
      status: 'budget_denied',
    });
    if (prior > 0) return;

    await ctx.alert(
      ctx.workspaceId,
      formatBudgetDenialAlert({
        ruleId: failure.rule.id,
        fire: failure.fire,
        contributor: ctx.contributor,
        reason: failure.error,
        windowMinutes: REACTION_FAILURE_ALERT_WINDOW_MINUTES,
      }),
    );
  } catch (e) {
    ctx.log(`alerting owner about budget denial for ${failure.rule.id} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Wake the pinned brain owner — the same route the pot watchdog uses for a silent outage. */
async function alertOwner(workspaceId: string, summary: string): Promise<void> {
  const { resolveBrainOwner } = await import('../harness/routines/wake-brain-action');
  const owner = await resolveBrainOwner(workspaceId).catch(() => null);
  if (!owner) return;
  const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
  await wakeRecipients([owner], { summary, source: 'event-reaction-failure', workspaceId });
}
