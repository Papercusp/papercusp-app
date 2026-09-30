/**
 * plan-expansion.ts — the pure core of work_items:expand (plan-implementation-
 * framework-2026-06-15 P-005, "deferred-expansion nodes"; flag papercusp-deferred-expansion).
 *
 * A deferred-expansion node is a shallow "expand-here" placeholder that, ON ARRIVAL,
 * emits child work_items — the record starts shallow and self-elaborates (the dynamism
 * guard: decide the decomposition at the moment of best context, not up front). This
 * module is the decideable core — pure, unit-tested — that turns a parent node + proposed
 * child specs into validated child-creation inputs + a disposition; the tool (./expand.ts)
 * wraps it with the durable writes (createWorkItem + commentWorkItem) behind the flag.
 *
 * Propose/dispose (mirrors P-004): the authoritative steerer (Queen/operator) DISPOSES
 * (the children are created); an executing bee PROPOSES (recorded; the steerer ratifies).
 * Each child carries `payload.expanded_from = parentId` — the durable parentage stamp
 * (same pattern as the plan_item stamp), so the hierarchy is queryable with no migration.
 */

export interface ExpansionChildSpec {
  title: string;
  summary?: string;
  files?: string[];
  brief?: string;
}

export interface ExpansionInput {
  parentId: string;
  parentHarness: string | null;
  children: readonly ExpansionChildSpec[];
  by: string;
  /** Authoritative caller (steerer) ⇒ children created; a bee ⇒ proposed. */
  authoritative: boolean;
  maxChildren?: number;
  /**
   * Lower-cased titles already expanded from this SAME parent in a PRIOR call
   * (WI-1400 cross-call idempotency). Present only when the caller wants that dedup
   * enforced — the tool omits it under `force:true` (a deliberate re-decomposition
   * that legitimately wants the same title again).
   */
  existingChildTitles?: ReadonlySet<string>;
}

export interface PlannedChild {
  kind: 'task';
  title: string;
  summary?: string;
  harness: string | null;
  parent: string;
  payload: Record<string, unknown>;
}

export interface ExpansionPlan {
  disposition: 'disposed' | 'proposed';
  children: PlannedChild[];
  dropped: { title: string; reason: string }[];
}

const DEFAULT_MAX_CHILDREN = 12;

/** Turn a parent + proposed child specs into validated, bounded, deduped child inputs. Pure. */
export function planExpansion(input: ExpansionInput): ExpansionPlan {
  const max = input.maxChildren ?? DEFAULT_MAX_CHILDREN;
  const children: PlannedChild[] = [];
  const dropped: { title: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const spec of input.children) {
    const title = (spec.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) {
      dropped.push({ title: spec.title ?? '', reason: 'empty title' });
      continue;
    }
    const key = title.toLowerCase();
    if (seen.has(key)) {
      dropped.push({ title, reason: 'duplicate title' });
      continue;
    }
    if (input.existingChildTitles?.has(key)) {
      dropped.push({
        title,
        reason: 'already expanded from this parent in a prior call — pass force:true to re-expand anyway',
      });
      continue;
    }
    if (children.length >= max) {
      dropped.push({ title, reason: `over the ${max}-child cap` });
      continue;
    }
    seen.add(key);
    const files = (spec.files ?? []).filter((f) => typeof f === 'string' && f.trim().length > 0);
    children.push({
      kind: 'task',
      title,
      summary: spec.summary?.trim() || undefined,
      harness: input.parentHarness,
      parent: input.parentId,
      payload: {
        expanded_from: input.parentId,
        ...(files.length ? { files } : {}),
        ...(spec.brief?.trim() ? { brief: spec.brief.trim() } : {}),
      },
    });
  }
  return {
    disposition: input.authoritative ? 'disposed' : 'proposed',
    children,
    dropped,
  };
}

/** A node is a deferred-expansion marker when its payload flags it (`expand`/`expand_here`). */
export function isExpandNode(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return p.expand === true || p.expand_here === true;
}

/** Render the expansion as a greppable structured record line for the parent's thread. */
export function renderExpansion(plan: ExpansionPlan): string {
  const verb = plan.disposition === 'disposed' ? 'expanded' : 'proposed expansion';
  const titles = plan.children.map((c) => c.title).join(', ');
  const dropNote = plan.dropped.length ? ` [dropped ${plan.dropped.length}]` : '';
  return `⟐ expand (${plan.disposition}) — ${verb} into ${plan.children.length} child node(s)${dropNote}: ${titles}`;
}
