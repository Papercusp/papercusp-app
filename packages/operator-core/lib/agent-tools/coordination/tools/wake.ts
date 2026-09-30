/**
 * coord:wake — the discoverable "wake a parked agent NOW" verb
 * (fleet-dispatch-wake-clarity-2026-06-22 P-006).
 *
 * Before this, waking a parked agent meant reverse-engineering `events:emit` on the
 * `coord:inbox-wake:<ownerId>` key — and coordinators kept reaching for `coord:wake` /
 * `coord:nudge` / `fleet:wake` and getting a 404. This is the alias that closes that
 * gap: a BARE wake (re-invoke the target's turn so it re-orients) with an OPTIONAL
 * one-line nudge, NO durable inbox row required.
 *
 * Distinct from its siblings:
 *   - coord:dispatch — assign a LANE + deliver a note + queue a wake (the rich
 *     "hand off work" primitive). Use it when you are giving the agent something to do;
 *     verify pickup separately from a fresh checkpoint or activity timestamp.
 *   - coord:send {wake:'required'} — deliver a contextual MESSAGE and wake.
 *   - coord:wake — JUST wake (the target re-orients on its own claimed lane). Use it when
 *     the work is already assigned (plan_items:assign / a prior dispatch) and you only need
 *     the agent to start a turn and pick it up.
 *
 * Composes the shipped wake substrate (`wakeRecipients` fires the per-owner inbox-wake key;
 * `reportIdleRecipients` classifies a miss) — it builds NO second wake pump, and reports a
 * miss as one of TWO distinct kinds, never folded together (WI-5994): `ended` (genuinely dead,
 * no scheduled fire) is a LOUD relaunch signal, never a silent woken:0; `dormant-scheduled`
 * (an armed loop with a known future nextFireAt) reports its delivery ETA instead — the
 * message is DEFERRED, not lost, so a caller must not relaunch/reassign on that alone.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { wakeRecipients, reportIdleRecipients } from '../inbox-wake';
import { resolveRecipients, isSelectorOrWildcard } from '../recipient-resolve';
import { softText, clampText, LIMITS } from '../../limits';

export default defineTool({
  name: 'coord:wake',
  description:
    "Wake a PARKED agent NOW so it starts a turn and re-orients on its already-claimed lane — the discoverable alias for the events:emit coord:inbox-wake:<id> key (which agents kept 404ing on as coord:wake/coord:nudge). Single-target (never '*'). Optional `note` is a one-line nudge; omit for a bare wake. To ALSO hand off a lane, use coord:dispatch; to deliver a contextual message, coord:send {wake:'required'}.",
  guidance: {
    when: 'The work is ALREADY assigned to the target (plan_items:assign or a prior dispatch) and you just need it to start a turn and pick it up — a re-orient nudge. Pick a `parked` target (coord:presence → sessionState:parked).',
    notWhen: 'You are assigning a NEW lane — use coord:dispatch (assign+deliver+queue). You have a contextual message to deliver — use coord:send {wake:\'required\'}. The target is `ended` (coord:presence) — it needs a relaunch/resume, not a wake.',
    chaining: 'coord:presence (find a parked target) → coord:wake { to } → check `queued`/`warning`, then verify pickup from a fresh checkpoint or activity timestamp. A queued wake is not proof that a turn executed.',
    returns:
      '{ ok, to, queued, woken:0, pickupConfirmed:false, recipient_dead?, recipient_dormant_scheduled?, recipient_alive_not_wakeable?, warning? }. `queued` counts matched durable wake deliveries; it does NOT prove a turn executed. `woken` stays 0 until an execution-confirming handshake exists. Verify pickup from a fresh checkpoint/activity timestamp. A queue miss still reports WHICH kind: `recipient_dead` (genuinely `ended`, no scheduled fire) is a LOUD miss; `recipient_dormant_scheduled` means deferred; `recipient_alive_not_wakeable` means alive without a watcher.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    to: z
      .string()
      .min(1)
      .describe('The target agent — its ownerId or the short handle from [coord+N]/coord:presence. Single-target only (never "*").'),
    note: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('Optional one-line reason the target sees on waking (e.g. "your lane is ready — pick it up"). Omit for a bare wake. Auto-truncated to 2000 chars if longer.'),
  }),
  result: z
    .object({
      ok: z.boolean(),
      to: z.string(),
      queued: z.number().int().nonnegative(),
      woken: z.number().int().nonnegative(),
      pickupConfirmed: z.boolean(),
      recipient_dead: z.unknown().optional(),
      recipient_dormant_scheduled: z.unknown().optional(),
      recipient_alive_not_wakeable: z.unknown().optional(),
      warning: z.string().optional(),
      staged: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = identity.workspaceId ?? undefined;

    // Never wake a wildcard/human/selector — coord:wake is single-target by contract.
    if (isSelectorOrWildcard(args.to)) {
      const payload = {
        ok: false,
        to: args.to,
        queued: 0,
        woken: 0,
        pickupConfirmed: false,
        error: 'not_a_single_target',
        message: 'coord:wake is single-target — it cannot wake "*"/"human"/an audience selector (that would thunder-herd the fleet). Name one agent.',
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    }

    // Resolve a short handle/prefix to the full ownerId so the exact inbox-wake key
    // matches (a short prefix would fire a key nobody watches). A miss is a loud error.
    let to = args.to;
    try {
      const r = await resolveRecipients([args.to], workspaceId);
      if (r.unknown.length || r.ambiguous.length) {
        const payload = {
          ok: false,
          to: args.to,
          queued: 0,
          woken: 0,
          pickupConfirmed: false,
          error: 'unknown_recipient',
          message: 'coord:wake addressed an agent not in the roster — nothing was woken. Use the short handle from [coord+N]/coord:presence, the su- prefix, or the full ownerId.',
          ...(r.unknown.length ? { unknown_recipients: r.unknown } : {}),
          ...(r.ambiguous.length ? { ambiguous_recipients: r.ambiguous } : {}),
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }
      to = r.resolved[0] ?? args.to;
    } catch {
      // fail-soft: a roster hiccup degrades to the raw id (the wake key may still match).
    }

    // Fire the target's inbox-wake key (reuse the shipped fan — no second pump).
    const fan = await wakeRecipients([to], {
      summary: clampText(args.note, LIMITS.ANNOTATION) ?? 'coord:wake — re-orient and continue your lane',
      source: identity.ownerId,
      workspaceId,
    });
    // emitAwaitedEvent returns the number of matching wake deliveries QUEUED,
    // before the detached pump runs. It cannot confirm that a turn executed.
    // Keep that truth explicit instead of exposing a false pickup signal.
    const queued = fan.woken;
    const woken = 0;

    // A wake that woke nobody: classify whether the target is genuinely dead (no live
    // session watching its key) so the miss is a LOUD relaunch signal, not a silent 0.
    // WI-5994: `reportIdleRecipients` already excludes a target with an armed loop and
    // a known future fire from `idle` — such a target is dormant BETWEEN loop fires,
    // not dead, and must never be told "needs a RELAUNCH".
    let recipient_dead: string[] | undefined;
    let recipient_dormant_scheduled: import('../inbox-wake').DormantScheduledInfo[] | undefined;
    let recipient_alive_not_wakeable: string[] | undefined;
    let warning: string | undefined;
    if (queued === 0 && fan.staged === 0) {
      try {
        const report = await reportIdleRecipients([to], { workspaceId });
        if (report.idle.length > 0) {
          recipient_dead = report.idle;
          warning =
            `coord:wake reached no live session for ${to} — it is NOT running (sessionState=ended), so the ` +
            'wake black-holes. This target needs a RELAUNCH/resume, not a wake (coord:presence → wakeable:true ' +
            'for a valid target).';
        } else if ((report.dormantScheduled ?? []).length > 0) {
          recipient_dormant_scheduled = report.dormantScheduled;
          const d = report.dormantScheduled[0];
          warning =
            `coord:wake reached no live session for ${to}, but it is DORMANT BETWEEN LOOP FIRES, not dead — ` +
            (d.parked
              ? 'a turn is in flight right now; it will see this on its current/next cycle.'
              : `its next scheduled fire is ${d.nextFireAt}. Delivery is DEFERRED, not lost — no relaunch needed.`);
        } else if ((report.aliveNotWakeable ?? []).length > 0) {
          // EI-19937974676482462: the shared liveness oracle (the same one
          // fleet:assignments reads) confirms this target is alive per the
          // session log — it just has no active coord:inbox-wake await right
          // now (e.g. a cup mid-turn that never registered one). Do NOT claim
          // sessionState=ended / NOT running here — that would be false, and
          // is exactly the disagreement this fixes.
          recipient_alive_not_wakeable = report.aliveNotWakeable;
          warning =
            `coord:wake reached no live wake-watcher for ${to}, but it is ALIVE per the session log (NOT dead) — ` +
            'it has no active coord:inbox-wake await right now (e.g. mid-turn, or has not registered one yet). ' +
            'Do NOT relaunch on this alone; retry the wake shortly or hand off via a durable surface ' +
            '(work_items:checkpoint) instead.';
        } else {
          warning =
            `coord:wake woke nobody for ${to} (it may be live-but-paused or mid-turn). Confirm it is running ` +
            '(coord:presence) before assuming it picked up.';
        }
      } catch {
        /* fail-soft: keep woken:0 without a dead classification */
      }
    }

    // EI-23106309488513586: this tool advertises an object-rooted `result` schema,
    // which strict MCP clients receive as `outputSchema`. Returning only a JSON
    // content block lets the wake execute but leaves `structuredContent` absent;
    // those clients then reject the response with -32602 even though the mutation
    // already queued. Keep the human-readable JSON text and the wire-equal object
    // together on the successful path, as the sibling coordination tools do.
    const payload = {
      ok: true,
      to,
      queued,
      woken,
      pickupConfirmed: false,
      ...(fan.staged > 0 ? { staged: fan.staged } : {}),
      ...(recipient_dead ? { recipient_dead } : {}),
      ...(recipient_dormant_scheduled ? { recipient_dormant_scheduled } : {}),
      ...(recipient_alive_not_wakeable ? { recipient_alive_not_wakeable } : {}),
      ...(warning
        ? { warning }
        : queued > 0
          ? {
              warning:
                `coord:wake queued ${queued} durable wake delivery for ${to}, but pickup is NOT confirmed — ` +
                'verify a fresh work-item checkpoint or activity timestamp before treating the target as running.',
            }
          : {}),
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
});
