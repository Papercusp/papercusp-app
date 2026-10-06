/**
 * The lift condition for a refused work-item dependency (WI-10005197, WI-10005192 ratchet).
 *
 * Deliberately its OWN import-free module: both the edge writer (`work-item-ref-blocker-edges.ts`)
 * and the legacy-migration summary in `set_blocker.ts` state the same refusal, and the pure
 * builder must stay loadable without dragging the work-items / DBOS graph in with it — a test
 * that mocks the edge writer would otherwise also mock the builder away.
 */
import type { RefusalContract } from '../../capability-envelope/identity-refusal-contract';

/**
 * `dependent` is the work-item that would have waited; `blockers` names the referent(s) the
 * write could not accept (null when the refusal is about the dependent itself).
 */
export function workItemRefDependencyRefusal(dependent: string, blockers: string | null): RefusalContract {
  return {
    observed: { dependent, blockers },
    liftsWhen:
      'the dependent and every named blocker resolve to existing work-items, no blocker is the dependent ' +
      'itself, and each `blocks` edge is admissible (acyclic, and accepted by the link guard) — `error` ' +
      'names which check failed. Retrying the identical request cannot lift it: correct the ids, name a ' +
      'different blocker, or remove the edge that closes the cycle. No dependency was written beyond any ' +
      'edge `error` lists as already written',
    whoCanMakeItTrue: ['self', 'another-agent'],
  };
}
