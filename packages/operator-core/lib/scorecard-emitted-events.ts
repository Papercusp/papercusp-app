/**
 * scorecard-emitted-events — bridge "a rubric just got graded" to the await primitive
 * (EI-21434202765745827).
 *
 * WHY THIS EXISTS. The plan-completion contract REQUIRES that a non-implementer grade an
 * implementer's plan: the implementer may not grade their own work. So "wait for another
 * agent to file a scorecard" is not an edge case — it is the designed happy path of every
 * plan ship. Until this module there was no key for it. An implementer finishing a plan
 * had nothing to `events:await`, so the only way to notice the grade was to re-poll
 * `scorecards:list` on a timer, and `loop:arm { blockedOn }` correctly capped such a loop
 * at 15 minutes precisely because no clearing event could be named.
 *
 * With this, the implementer parks instead of polling:
 *
 *   events:await { event: "scorecard:emitted:<my-acceptance-rubric-ref>" }
 *
 * and is re-invoked when a card lands. The rubricRef is IN the key (a required param), so
 * an implementer waiting on their own rubric wakes only for that rubric.
 *
 * WAKING ON SOMEONE ELSE'S CARD. The payload carries `createdBy`, so an implementer who
 * wants only an INDEPENDENT grade — the case the completion contract actually cares about
 * — can narrow with a payload_filter on that field rather than waking on their own
 * acceptance re-emit. Deliberately a filterable payload field, not a second key: the
 * emitter cannot know who "independent" means for a given awaiter.
 *
 * TRANSITION-ONLY FOR FREE. The emit is wired at the single point where a card is actually
 * FILED (`scorecards:emit`, gated on `result.created`), so a re-read, a refused emit, or a
 * validation failure fires nothing. Every filed card passes through that one chokepoint,
 * which is what keeps this a ~1-line emit rather than a derived detector.
 *
 * SCOPE. The original rubric-scoped key remains the precise public wait. P-005 of
 * shared-agent-obligations-and-briefs adds `plan:acceptance:<slug>` alongside it for
 * the platform-armed obligation episode: the shared provider knows the plan before
 * a rubric necessarily exists, and needs one stable plan-level material-change key.
 * Both are hints only; every waking consumer re-runs the canonical gate.
 *
 * Fire-and-forget and fail-soft: a failed emit NEVER breaks the scorecard write. The card is
 * the durable truth; the event is only the push notification for it.
 */

import { emitAwaitedEvent } from './events/await/engine';
import { planAcceptanceChangedKey } from './agent-obligations';

/** The awaitable key for "a scorecard was filed against this rubric". */
export function scorecardEmittedKey(rubricRef: string): string {
  return `scorecard:emitted:${rubricRef}`;
}

/** What a waking awaiter receives — shaped so `payload_filter` can express the real
 *  questions (was this MY card? was it an acceptance verdict? what did it grade?). */
export interface ScorecardEmittedPayload {
  /** The filed card's work-item id. */
  issueId: string;
  rubricRef: string;
  /** 'acceptance' | 'standard' | null when unresolved. */
  rubricKind: string | null;
  /** What the card graded, e.g. 'plan' + the plan slug. */
  subjectKind: string | null;
  subjectRef: string | null;
  /** Emitter ownerId — filter on this to wake only for a card that is not your own. */
  createdBy: string | null;
  /** True when this card carries the rubric author's acceptance verdict (the SECOND
   *  emit in the acceptance flow), false for the independent grader's card. */
  hasAcceptance: boolean;
}

/**
 * Expected fail-soft noise for a best-effort fire-and-forget emit (never warn, or
 * vitest-fail-on-console flakes rig tests): a partial test schema ("… does not exist"), or
 * the async query outliving its Postgres pool (CONNECTION_ENDED/DESTROYED). Else warn.
 */
function failSoft(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[scorecard-emitted-events] emit failed: ${msg}`);
}

/** Injectable seam for tests. */
export interface ScorecardEmittedEventsDeps {
  emit?: typeof emitAwaitedEvent;
}

/**
 * Fire `scorecard:emitted:<rubricRef>` and, for a plan subject, the shared
 * `plan:acceptance:<slug>` change key. Awaiter-only (no `to` push). Never throws —
 * a failed emit must not fail the scorecard write that already succeeded.
 */
export async function emitScorecardEmitted(
  payload: ScorecardEmittedPayload,
  opts: { workspaceId?: string } & ScorecardEmittedEventsDeps = {},
): Promise<void> {
  const emit = opts.emit ?? emitAwaitedEvent;
  const subject = payload.subjectRef ? ` on ${payload.subjectRef}` : '';
  const verdict = payload.hasAcceptance ? ' (carries the acceptance verdict)' : '';
  const events = [
    {
      key: scorecardEmittedKey(payload.rubricRef),
      payload,
      summary: `scorecard ${payload.issueId} filed against ${payload.rubricRef}${subject} by ${payload.createdBy ?? 'unknown'}${verdict}`,
      source: payload.createdBy ?? 'scorecards:emit',
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    },
    ...(payload.subjectKind === 'plan' && payload.subjectRef
      ? [
          {
            key: planAcceptanceChangedKey(payload.subjectRef),
            payload,
            summary: `plan acceptance evidence changed: scorecard ${payload.issueId} filed against ${payload.rubricRef}`,
            source: payload.createdBy ?? 'scorecards:emit',
            ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
          },
        ]
      : []),
  ];
  // Each notification is fail-soft independently: losing the rubric-specific
  // hint must not prevent the plan-level obligation wake (or vice versa).
  for (const event of events) {
    try {
      await emit(event);
    } catch (e) {
      failSoft(e);
    }
  }
}
