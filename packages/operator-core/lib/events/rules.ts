/**
 * The Events file — the single inspectable list of first-party reaction rules
 * (event-reaction-system D-002). All built-in "when X, fire Y" wiring lives
 * HERE, in one place, not scattered across handlers. Importing this module
 * registers them.
 *
 * (Two other authoring forms feed the SAME registry: `emits:` co-location sugar
 * on a tool — coord-lifecycle-automation D-002 — and plugin/blueprint rules —
 * D-012. This file is for contextual cross-tool reactions that don't belong to
 * any single tool's contract.)
 */

import { registerReactionRule } from './registry';
import { formatHandoff, type HandoffArgs } from './format-handoff';
import { registerCacheTagEcaRule } from './cache-eca-rule';
import { registerAccountDefaultMarkerRule } from '../deployment/account-default-marker-rule';
import { buildKey } from './await/catalog';
import { GATE_REJUDGE_ADMITTED_REPAIR_ACTION } from './builtin-actions';
// oddsmith-domain reaction: a completed bet-analysis item → one decision-ledger
// disposition (the signals/recent-auto-decisions feed). Self-registers on import.
// (Cleaner long-term home: an oddsmith PluginReactionRule — see on-papercusp plan P3.)
import '../decision-ledger/bet-signal-rule';

/**
 * D-008 — the motivating rule: defer → render on the agent's pane.
 *
 * When an agent defers work by opening a `coord:handoff`, auto-render the
 * deferral on that agent's own pane via the activity bridge — so the agent
 * spends ZERO tokens listing its deferrals; the system reacts.
 *
 * (The plan's illustrative pseudo-code fired `ui:dispatch` with `pane:ctx.agent`
 * + `formatHandoff`. Those don't exist as written — `ui:dispatch` targets
 * browser tabs, there is no `ctx.agent`, and `coord:handoff` has no `item`
 * field. The real "render on the agent's pane, zero tokens" mechanism is
 * `activity:report` keyed by `ctx.uiClientId`, which the pui fleet view
 * SSE-renders in that agent's activity lane. Same intent, working tools.)
 */
registerReactionRule({
  id: 'defer-renders-on-pane',
  on: 'coord:handoff',
  // Fire on OPEN handoffs only (they carry a summary), not accepts
  // (accept_msg_id), and only when we know whose pane to render on.
  when: (e) => {
    const a = e.args as { summary?: string; accept_msg_id?: string } | undefined;
    return Boolean(a?.summary) && !a?.accept_msg_id && Boolean(e.ctx.uiClientId);
  },
  fire: 'activity:report',
  args: (e) => {
    const a = e.args as HandoffArgs;
    return {
      owner: e.ctx.uiClientId,
      kind: 'lifecycle',
      summary: formatHandoff(a),
      session_id: e.ctx.spawnId ?? undefined,
      harness_slug: e.ctx.harnessSlug ?? undefined,
    };
  },
  onlyOnSuccess: true,
  source: 'events-file',
});

/**
 * caching-layer-tag-eca-2026-06-22 P-004 — the keystone: a `<table>.changed` event
 * from the change stream bumps the affected cache tags. Registered via its own
 * module so the (sync-cached) flag gate + the deterministic tag scheme live next to
 * the built-in `cache.bumpTags` action. Flag-gated (CACHE_TAG_ECA, default ON).
 */
registerCacheTagEcaRule();

/**
 * EI-19944784972017743 — a change to the owner's account override re-publishes THIS
 * process's `PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE` marker, so a sibling long-lived host
 * (bg-host) stops routing its in-process anthropic-direct calls at `~/.claude` after
 * the owner nominates a default pool account. Rides the change stream the override
 * table already emits, rather than re-polling PG from every host on a timer.
 */
registerAccountDefaultMarkerRule();

interface ConfirmedRepairAdmission {
  candidate: string;
  repairHead: string;
  installSlug: string;
}

/** Extract only the one successful write shape that is allowed to wake repair verification. */
function confirmedRepairAdmission(e: import('./types').ToolInvocationEvent): ConfirmedRepairAdmission | null {
  const args = e.args as { op?: unknown; confirm?: unknown } | undefined;
  if ((args?.op !== 'admit' && args?.op !== 'converge') || args.confirm !== true) return null;
  const data = e.result.data as
    | {
        ok?: unknown;
        admitted?: unknown;
        persisted?: unknown;
        target?: { installSlug?: unknown };
        repairQueue?: { candidate?: unknown; repairHead?: unknown };
        movedRepairHead?: { to?: unknown };
      }
    | undefined;
  const candidate = data?.repairQueue?.candidate;
  const repairHead = data?.movedRepairHead?.to ?? data?.repairQueue?.repairHead;
  const installSlug = data?.target?.installSlug;
  if (
    data?.ok !== true ||
    data.admitted !== true ||
    data.persisted !== true ||
    typeof candidate !== 'string' ||
    typeof repairHead !== 'string' ||
    typeof installSlug !== 'string'
  ) {
    return null;
  }
  return { candidate, repairHead, installSlug };
}

/** P-001/R-1: the catalogued, awaitable observation of a persisted admission. */
registerReactionRule({
  id: 'gate:repair-admitted:event',
  on: 'release:repair-queue',
  when: (e) => confirmedRepairAdmission(e) !== null,
  fire: 'events:emit',
  args: (e) => {
    const admission = confirmedRepairAdmission(e)!;
    return {
      event: buildKey('repair-admitted', { candidate: admission.candidate }),
      summary:
        `Frozen repair ${admission.candidate.slice(0, 8)} admitted head ` +
        `${admission.repairHead.slice(0, 8)}; immediate re-judge requested`,
      payload: admission,
    };
  },
  dedupKey: (e) => {
    const admission = confirmedRepairAdmission(e);
    return admission ? `${admission.candidate}:${admission.repairHead}` : '';
  },
  onlyOnSuccess: true,
  source: 'events-file',
});

/** P-001/R-1: pull the existing routine due now. Default durable mode survives host restart. */
registerReactionRule({
  id: 'gate:repair-admitted:rejudge',
  on: 'release:repair-queue',
  when: (e) => confirmedRepairAdmission(e) !== null,
  fire: GATE_REJUDGE_ADMITTED_REPAIR_ACTION,
  args: (e) => ({ ...confirmedRepairAdmission(e)! }),
  dedupKey: (e) => {
    const admission = confirmedRepairAdmission(e);
    return admission ? `${admission.candidate}:${admission.repairHead}` : '';
  },
  onlyOnSuccess: true,
  source: 'events-file',
});

/**
 * WI-5271 — critical-severity work-item alert, event-driven (replaces the leaking
 * `critical-severity-alert-2026-07-06` 15-min poll+diff scheduled plan).
 *
 * Owner ask (2026-07-06, verbatim): "I want to be alerted whenever a new
 * critical-severity work item appears in this harness." The original
 * implementation was a scheduled poll+diff PLAN because no creation event
 * existed yet — `events/await/catalog.ts`'s `work-item-created` family was later
 * built specifically to replace it (see that file's `replacesPoll` note) but the
 * plan was never actually migrated off, so it kept minting a new permanent
 * `harness_plans` row every 15 minutes forever (945+ and growing when found).
 *
 * This rule is the real migration: react directly to `work_items:create`
 * (the same trigger tool `defaultPotEventSubscriptions()` reacts to for the
 * Mug's own demand-wake — same pattern, different fire target) instead of
 * polling, and fire `coord:escalate` at `advisory` severity (an FYI, not a
 * blocker/question — the owner wants awareness, not a decision) so it lands on
 * the same "open escalations" surface the owner already watches. `conditionKey`
 * is the created item's own id, so a fan-out re-fire (a bulk create) can never
 * double-alert on the same item.
 */
registerReactionRule({
  id: 'critical-work-item-alert',
  on: 'work_items:create',
  when: (e) => {
    const d = e.result.data as
      | { ok?: boolean; workItem?: { id?: string; title?: string; severity?: string; harness?: string | null } }
      | undefined;
    return d?.ok === true && d?.workItem?.severity === 'critical';
  },
  fire: 'coord:escalate',
  args: (e) => {
    const d = e.result.data as { workItem: { id: string; title: string; harness?: string | null } };
    const wi = d.workItem;
    return {
      severity: 'advisory',
      summary: `New CRITICAL work item filed: ${wi.id} — ${wi.title}`,
      body: `harness: ${wi.harness ?? '(unset)'}\nid: ${wi.id}`,
      conditionKey: `critical-wi-alert:${wi.id}`,
    };
  },
  onlyOnSuccess: true,
  source: 'events-file',
});
