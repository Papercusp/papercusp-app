/**
 * lifecycle-rules.ts — the auto-emit reaction rules for the predictable coord
 * categories (coord-lifecycle-automation-2026-06-04 D-003, P1–P3).
 *
 * Each rule turns a lifecycle TOOL event into a `coord:emit` so the agent stops
 * hand-writing the predictable coord:send. They are authored HERE (the central
 * Events-file form) rather than as `emits:` on the trigger tools because those
 * triggers (work_items:claim/create, coord:declare-intent) are owned by other
 * plans — this keeps the coupling one-directional (we react to their stable tool
 * contract; we don't edit their files). The COMPLETION rule, by contrast, is an
 * `emits:` on work_items:complete itself (that tool is ours + the emission is
 * intrinsic to it) — see ../agent-tools/work_items/complete.ts.
 *
 * All forms feed the SAME engine via `registerReactionRule` — there is no
 * parallel dispatch path (the D-002 invariant). Importing this module registers
 * the rules; the rules fire `coord:emit` through normal, audited dispatch.
 *
 * THE PROJECTION INVARIANT (state-not-chat-fleet-state-2026-06-05 D-003): every
 * message these rules emit is a PURE, one-directional PROJECTION of a state
 * write that already happened (the claim row, the presence upsert, the work-item
 * insert — `onlyOnSuccess` guarantees the table write preceded the message).
 * The TABLE is the record; the message is a human-readable nudge. Consumers must
 * NEVER reconstruct fleet state by replaying these messages — query the
 * `harness_shared.fleet_assignment` view (`fleet:assignments` / `coord:presence`)
 * for state, or subscribe the `fleet_assignment` PG NOTIFY change-feed
 * (`lib/fleet-assignment-bus.ts`) for change-awareness. Combined with Brief 28's
 * audience scoping, the message channel carries only notification + the
 * genuinely unpredictable.
 *
 * Category coverage (D-003 table):
 *   completion (25%) → emits: on work_items:complete (D-004)
 *   claim/start (5%) → THIS file, on work_items:claim
 *   intent (part of 29%) → THIS file, on coord:declare-intent
 *   finding/health (2%) → THIS file, on work_items:create[kind=bug]
 *   restart/resource (12%) → ALREADY auto-broadcast by guardResource (dev:restart
 *                            + resource locks) — no rule needed; see ./README notes
 *   ack (7%) → coord:ack is already the typed op
 *   handoff → coord:handoff + the events-file defer→pane rule (su-2a7b4)
 *   window (part of 29%) → the Gray intention-lock auto-broadcast belongs to
 *                          locks-correctness-hardening D-005; renderWindow + the
 *                          'window' category are ready for it (typed coord:emit).
 */

import { registerReactionRule } from '../events';
import { renderClaim, renderIntent, renderFinding } from './render';
import { workItemObjectRef } from '../work-items';
import { objectSelector } from '../agent-tools/coordination/audience';

interface WorkItemLike {
  id?: string;
  title?: string;
  assignee?: string | null;
  /** Carried so the lifecycle event can be scoped to the work-item's watchers
   *  (coord-emit-subscription-scoping-2026-06-05); present on the real
   *  work_items:claim / work_items:create result. */
  family?: 'feature' | 'issue';
  harness?: string | null;
}

/**
 * Scope a work-item lifecycle event (claim / finding) to that work-item's
 * watchers — its coord-object subscribers + tagged-topic subscribers, expanded
 * by sendMessage. Empty if the item shape is unknown; we never fall back to '*'
 * (coord-emit-subscription-scoping D-001/D-004).
 */
function workItemAudience(wi: WorkItemLike): string[] {
  if (!wi.family || !wi.id) return [];
  return [objectSelector(workItemObjectRef({ family: wi.family, harness: wi.harness ?? null, id: wi.id }))];
}

/** Scope an intent to peers on the same plan and/or editing the same files. */
function intentAudience(planSlug: string | undefined, files: string[] | undefined): string[] {
  const sels: string[] = [];
  if (planSlug) sels.push(`@plan:${planSlug}`);
  for (const f of files ?? []) sels.push(`@file:${f}`);
  return sels;
}

/** CLAIM (D-003, 5%) — a work_item claim auto-emits "Taking X". */
registerReactionRule({
  id: 'lifecycle:claim',
  on: 'work_items:claim',
  when: (e) => Boolean((e.result?.data as { workItem?: unknown } | undefined)?.workItem),
  fire: 'coord:emit',
  args: (e) => {
    const wi = (e.result.data as { workItem: WorkItemLike }).workItem;
    const { summary } = renderClaim({
      workItem: wi.title ?? wi.id ?? 'work-item',
      agent: wi.assignee ?? undefined,
    });
    return { category: 'claim', summary, to: workItemAudience(wi) };
  },
  onlyOnSuccess: true,
  source: 'lifecycle-rules',
});

/**
 * INTENT (D-003, part of 29%) — declaring intent auto-emits "now working on X"
 * to the inbox (push), replacing the hand-written "heads-up, I'm on X" coord:send.
 * Deduped on (agent, intent) so re-declaring the same intent (the prompt has
 * agents declare at session start) does not re-broadcast.
 */
registerReactionRule({
  id: 'lifecycle:intent',
  on: 'coord:declare-intent',
  when: (e) => Boolean((e.args as { intent?: string } | undefined)?.intent),
  fire: 'coord:emit',
  args: (e) => {
    const a = e.args as {
      intent: string;
      current_files?: string[];
      current_plan_slug?: string;
      items?: string[];
      declared_goal_refs?: string[];
    };
    const { summary, body } = renderIntent({
      intent: a.intent,
      files: a.current_files,
      planSlug: a.current_plan_slug,
      agent: e.ctx.uiClientId ?? undefined,
    });
    return {
      category: 'intent',
      summary,
      ...(body ? { body } : {}),
      ...(a.current_plan_slug ? { plan_slug: a.current_plan_slug } : {}),
      ...(a.items && a.items.length > 0 ? { declared_plan_items: a.items } : {}),
      ...(a.declared_goal_refs ? { declared_goal_refs: a.declared_goal_refs } : {}),
      to: intentAudience(a.current_plan_slug, a.current_files),
    };
  },
  dedupKey: (e) =>
    `${e.ctx.uiClientId ?? ''}:${(e.args as { intent?: string } | undefined)?.intent ?? ''}`,
  onlyOnSuccess: true,
  source: 'lifecycle-rules',
});

/**
 * FINDING / health (D-003, 2%) — filing a bug work-item auto-emits the finding,
 * so a discovered problem stops living only in prose.
 */
registerReactionRule({
  id: 'lifecycle:finding',
  on: 'work_items:create',
  when: (e) => {
    const a = e.args as { kind?: string } | undefined;
    return a?.kind === 'bug' && Boolean((e.result?.data as { workItem?: unknown } | undefined)?.workItem);
  },
  fire: 'coord:emit',
  args: (e) => {
    const a = e.args as { title?: string; summary?: string; severity?: string };
    const wi = (e.result.data as { workItem: WorkItemLike }).workItem;
    const { summary, body } = renderFinding({
      title: a.title ?? wi.title ?? 'finding',
      severity: a.severity,
      detail: a.summary,
      workItemId: wi.id,
      agent: e.ctx.uiClientId ?? undefined,
    });
    // Scope the bug finding to its object subscribers + tagged-topic subscribers.
    return { category: 'finding', summary, ...(body ? { body } : {}), to: workItemAudience(wi) };
  },
  onlyOnSuccess: true,
  source: 'lifecycle-rules',
});
