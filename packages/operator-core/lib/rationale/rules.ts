/**
 * Rationale-projection event-maintenance rules
 * (docs-and-memory-as-projections-2026-06-05 D-003).
 *
 * The projection is kept fresh by the SHIPPED event engine, not by an LLM-per-change
 * re-summary (the token-cost trap D-003 warns against). These rules turn the
 * structural mutations that change the "why" — a decision added, a source tagged to
 * a topic, a work-item's state changed — into a `rationale:reproject` that re-derives
 * just that source and diffs it into the index. Idempotent: a redundant fire is a
 * no-op (the projector is deterministic, the diff converges).
 *
 * Authored HERE in the central Events-file form (like coord-lifecycle's
 * lifecycle-rules) rather than as `emits:` on the triggers, because the triggers
 * (plans:add-decision, topics:tag, work_items:*) are owned by other plans — we react
 * to their stable tool contract; we don't edit their files. Importing this module
 * registers the rules.
 */

import { registerReactionRule } from '../events';

/** DECISION added → re-project that plan's decisions under its topics. */
registerReactionRule({
  id: 'rationale:plan-decision',
  on: 'plans:add-decision',
  when: (e) => Boolean((e.args as { slug?: string } | undefined)?.slug),
  fire: 'rationale:reproject',
  args: (e) => {
    const a = e.args as { slug: string; harness?: string };
    return { kind: 'plan', id: a.slug, ...(a.harness ? { harness: a.harness } : {}) };
  },
  onlyOnSuccess: true,
  source: 'rationale-rules',
});

/**
 * Object TAGGED to a topic → re-project that source (its rationale now belongs to
 * the new topic; an untag drops it). Covers plans + work-items via the generic
 * topics:tag tool.
 */
registerReactionRule({
  id: 'rationale:topic-tag',
  on: 'topics:tag',
  when: (e) => {
    const a = e.args as { object_kind?: string; object_ref?: string } | undefined;
    return Boolean(a?.object_kind) && Boolean(a?.object_ref);
  },
  fire: 'rationale:reproject',
  args: (e) => {
    const a = e.args as { object_kind: string; object_ref: string };
    return { kind: 'tagged', objectKind: a.object_kind, objectRef: a.object_ref };
  },
  onlyOnSuccess: true,
  source: 'rationale-rules',
});

/** Work-item TAGGED via the work-items surface → re-project that work-item. */
registerReactionRule({
  id: 'rationale:work-item-tag',
  on: 'work_items:tag',
  when: (e) => Boolean((e.args as { id?: string } | undefined)?.id),
  fire: 'rationale:reproject',
  args: (e) => {
    const a = e.args as { id: string; harness?: string };
    return { kind: 'work_item', id: a.id, ...(a.harness ? { harness: a.harness } : {}) };
  },
  onlyOnSuccess: true,
  source: 'rationale-rules',
});

/**
 * Work-item STATE changed → re-project it so an already-tagged item's projected
 * `state` stays fresh (no-op for untagged items — the projector returns []).
 */
registerReactionRule({
  id: 'rationale:work-item-state',
  on: ['work_items:set_state', 'work_items:complete'],
  when: (e) => Boolean((e.args as { id?: string } | undefined)?.id),
  fire: 'rationale:reproject',
  args: (e) => {
    const a = e.args as { id: string; harness?: string };
    return { kind: 'work_item', id: a.id, ...(a.harness ? { harness: a.harness } : {}) };
  },
  onlyOnSuccess: true,
  source: 'rationale-rules',
});
