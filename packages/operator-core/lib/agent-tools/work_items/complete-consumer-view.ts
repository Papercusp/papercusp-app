/**
 * Consumer attestation for a landed `work_items:complete` close (WI-10005199,
 * generalizing EI-23770243810745552).
 *
 * `work_items:complete` computes a `completionAuthority` in-process and hands it to the
 * state writer. The authority a CONSUMER reads — `work_items:get`, burn-down counters, the
 * leader's completion-integrity audit — is the one on the row re-read AFTER the write, and
 * migration 972's BEFORE trigger `harness_shared.downgrade_unproven_committed_close()` can
 * rewrite `committed` to `proposed` in that very write (and only RAISEs a WARNING that
 * reaches the Postgres log and nobody else). So `ok:true` on a close has only proven the
 * write landed; it does not prove the consumer reads the authority the call computed.
 *
 * `reconcileStampedAuthority` (work-item-completion-authority.ts) already measures that
 * disagreement as `divergedFromComputed`, and `complete.ts` reports the PERSISTED value as
 * `completionAuthority`. What was missing is the standard structured block, so a close
 * whose consumer-visible authority differs from what the call computed says so in the one
 * shape every attested write uses (`consumerView`), rather than only through remedy prose
 * keyed to one downgrade cause. This is exception-only: agreement returns `undefined`, so
 * an ordinary close's response is unchanged.
 *
 * ── WHAT IS DELIBERATELY NOT ATTESTED: STATE ──────────────────────────────────────────
 * The writer's `appliedState` is `workItem.state` on the very row this call re-read
 * (`setWorkItemStateWithAliasInfo`: `const appliedState = workItem ? workItem.state : null`),
 * so comparing the two would be a tautology — a guard that cannot fail. A close that did
 * not land its terminal state is already loud and `ok:false` (`stateWriteFailed` /
 * `closeFailed` → `stateFailure`). Attesting authority only keeps this block falsifiable.
 *
 * Leaf on purpose: runtime imports only the shared consumer-view primitive (the authority
 * type is erased), so `complete.ts` — already 5.7k lines — gains a call site, not a graph.
 */
import { buildConsumerView, type ConsumerView } from '../../consumer-view';
import type { CompletionAuthorityFrom } from '../../work-item-completion-authority';

/** The path a consumer reads for a close's authority — the post-write re-read, NOT the in-process value. */
export const COMPLETION_CONSUMER_READ_PATH =
  'work_items:get → issue view row re-read after the write (completionAuthority, after the migration-972 floor trigger)';

export interface CompletionConsumerObservation {
  /** `null` = the row carries no authority (a writer that stamps none) AND none was computed. */
  completionAuthority: CompletionAuthorityFrom;
}

/**
 * Compare the authority this call COMPUTED with the one a consumer reads back.
 *
 * `stamped` is the same predicate `reconcileStampedAuthority` receives (a terminal state was
 * reached with no state error): an unstamped call wrote no authority, so there is nothing to
 * attest. `stampedAuthority` is that function's output (`persisted ?? computed`), passed in
 * rather than re-derived so the two cannot drift.
 */
export function attestCompletionConsumerView(input: {
  stamped: boolean;
  computedAuthority: CompletionAuthorityFrom;
  stampedAuthority: CompletionAuthorityFrom;
}): { consumerView: ConsumerView<CompletionConsumerObservation> } | undefined {
  if (!input.stamped) return undefined;
  const consumerView = buildConsumerView<CompletionConsumerObservation>({
    readPath: COMPLETION_CONSUMER_READ_PATH,
    written: { completionAuthority: input.computedAuthority },
    consumed: { completionAuthority: input.stampedAuthority },
  });
  return consumerView.divergedFromWrite ? { consumerView } : undefined;
}
