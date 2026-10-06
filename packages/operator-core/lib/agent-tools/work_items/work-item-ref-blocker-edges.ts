/**
 * WI-10005020 (P-002 / R-14, R-15) — record a work-item dependency as its one canonical
 * representation, a `work_item_deps` `blocks` edge, instead of an `externalBlockers` row.
 *
 * `work_items:set_blocker` routes a ref that names only work-items (bare ids or
 * `work-item:done:<id>` keys, see `pureWorkItemDependencyReferents`) here, and the
 * one-shot legacy migration below uses the same seam, so a dependency written by either
 * path is the same edge `work_items:link { rel:'blocks' }` writes: src = blocker,
 * dst = blocked. Reused, not re-derived: `resolveWorkItemRef`, the acyclicity guard and
 * `linkWorkItem` are exactly what the link tool calls.
 */
import type { ObjectRef } from '@papercusp/coordination/capabilities';
import { linkWorkItem, resolveWorkItemRef } from '../../work-items';
import { guardFeatureBlockEdgeAcyclic } from '../../dbos/feature-blockers-edges';
import type { RefusalContract } from '../../capability-envelope/identity-refusal-contract';
import { workItemRefDependencyRefusal } from './work-item-ref-dependency-refusal';

export interface WorkItemRefEdge {
  /** The referent that must finish first (edge source). */
  blocker: string;
  /** The dependent work-item (edge destination). */
  blocked: ObjectRef;
}

export type WorkItemRefEdgeResult =
  | { ok: true; edges: WorkItemRefEdge[] }
  | { ok: false; code: 'work_item_ref_dependency_refused'; error: string; refusal: RefusalContract };

function refused(error: string, dependent: string, blockers: string | null): WorkItemRefEdgeResult {
  return {
    ok: false,
    code: 'work_item_ref_dependency_refused',
    error,
    refusal: workItemRefDependencyRefusal(dependent, blockers),
  };
}

/**
 * Validate every referent BEFORE writing any edge, so a refused referent never leaves a
 * partial dependency set behind. A referent may live in another harness, so the lookup
 * falls back to a workspace-wide resolve when the dependent's harness does not hold it.
 */
export async function linkWorkItemRefDependencies(input: {
  dependentId: string;
  harness?: string;
  referents: string[];
  by: string;
}): Promise<WorkItemRefEdgeResult> {
  const blocked = await resolveWorkItemRef(input.dependentId, input.harness);
  if (!blocked) {
    return refused(
      `work_item '${input.dependentId}' could not be resolved as an edge endpoint.`,
      input.dependentId,
      null,
    );
  }

  const planned: Array<{ referent: string; harness?: string }> = [];
  for (const referent of input.referents) {
    if (referent.toUpperCase() === input.dependentId.toUpperCase()) {
      return refused(
        `work_item '${input.dependentId}' cannot depend on itself; no dependency was written.`,
        input.dependentId,
        referent,
      );
    }
    let harness = input.harness;
    let src = await resolveWorkItemRef(referent, harness);
    if (!src && harness) {
      harness = undefined;
      src = await resolveWorkItemRef(referent);
    }
    if (!src) {
      return refused(
        `blocker work_item '${referent}' was not found, so '${input.dependentId}' cannot depend on it. ` +
          'No dependency was written; name an existing work-item, or an external condition that is not a work-item.',
        input.dependentId,
        referent,
      );
    }
    const cycle = await guardFeatureBlockEdgeAcyclic(src.ref, blocked.ref);
    if (cycle) return refused(`${cycle} No dependency was written.`, input.dependentId, referent);
    planned.push({ referent, harness });
  }

  const edges: WorkItemRefEdge[] = [];
  for (const { referent, harness } of planned) {
    const res = await linkWorkItem(referent, blocked, 'blocks', { harness, by: input.by });
    if ('error' in res) {
      return refused(
        `blocks edge ${referent} → ${input.dependentId} was not written: ${res.error}` +
          (edges.length ? ` (already written: ${edges.map((e) => e.blocker).join(', ')})` : ''),
        input.dependentId,
        referent,
      );
    }
    edges.push({ blocker: referent, blocked });
  }
  return { ok: true, edges };
}
