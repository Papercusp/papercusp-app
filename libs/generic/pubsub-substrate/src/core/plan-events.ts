/**
 * plan-events.ts — plan-event types + the pure read filter. PURE.
 *
 * agent-coordination-architecture-v2 §8. The append + monthly-rotation
 * I/O lives behind the CoordEventLog seam; this is the filter+sort over
 * the loaded lines.
 */

import { type CoordEnvelope, compareByTsThenId } from './envelope';

/**
 * The plan-event kinds an actual `plans:*` verb emits. Exhaustive over
 * emitters — every member has a call site.
 */
export type PlanEventType =
  | 'created'
  | 'now_updated'
  | 'decision_added'
  | 'decision_ratified'
  | 'item_added'
  | 'item_status_changed'
  | 'status_changed'
  | 'promoted'
  | 'agent_launched'
  | 'plan_audited'
  /** A typed property write (goals:set-property / plans:set-property,
   *  work-on-everything-goal-2026-08-23 P-023). `plan_slug` carries the
   *  OWNING SUBJECT's key — a plan slug or a goal id — deliberately riding
   *  this one rail (D-005 §2: no parallel channel); `detail` carries the
   *  rendered delta line (`worklist: +"docs sweeps" −"perf"`). */
  | 'property_changed'
  /** A goal-package contract update applied to a live/stub goal instance
   *  (goals:apply-package-update, work-on-everything-goal-2026-08-23 P-018).
   *  Same D-005 §2 one-rail convention as property_changed: `plan_slug`
   *  carries the GOAL ID; `before`/`after` carry the package versions;
   *  `detail` names the mode + fields applied. */
  | 'package_updated';

export interface ReadPlanEventsOpts {
  since_ts?: string;
  planSlugs?: string[];
  events?: PlanEventType[];
}

/**
 * Filter loaded plan-event lines: keep `plan_event` kinds matching the
 * since/slug/event filters. Sorted ascending by (ts, msg_id).
 */
export function filterPlanEvents(
  lines: CoordEnvelope[],
  opts: ReadPlanEventsOpts = {},
): CoordEnvelope[] {
  const sinceMs = opts.since_ts ? new Date(opts.since_ts).getTime() : 0;
  const slugFilter = opts.planSlugs ? new Set(opts.planSlugs) : null;
  const eventFilter = opts.events
    ? new Set<string>(opts.events as readonly string[])
    : null;
  const out: CoordEnvelope[] = [];
  for (const l of lines) {
    if (l.kind !== 'plan_event') continue;
    if (sinceMs && new Date(l.ts).getTime() <= sinceMs) continue;
    const slug = typeof l.plan_slug === 'string' ? l.plan_slug : null;
    if (slugFilter && (!slug || !slugFilter.has(slug))) continue;
    const ev = typeof l.event === 'string' ? l.event : null;
    if (eventFilter && (!ev || !eventFilter.has(ev))) continue;
    out.push(l);
  }
  return out.sort(compareByTsThenId);
}
