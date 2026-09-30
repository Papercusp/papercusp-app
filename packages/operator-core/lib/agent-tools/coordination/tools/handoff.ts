/**
 * coord:handoff — record a work transition between agents.
 *
 * Writes a per-event file at coord/handoffs/<msg_id>.json. Acceptance
 * is a sibling file written by the receiver (also via coord:handoff
 * with an `accept_msg_id` arg) or auto-emitted when the receiver
 * calls plans:set-now on the same plan (a planned future bolt-on).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { openHandoff, acceptHandoff } from '../handoffs';
import { resolveBestEffortAgainstRoster } from '../recipient-resolve';
import { wakeRecipients, reportIdleRecipients, type DormantScheduledInfo } from '../inbox-wake';
import { describeMissedRecipients, type MissedRecipientLiveness } from '../recipient-liveness';
import { COORD_ROLES } from '../roles';
import type { HydratableRef } from '../ref-hydrate';
import { renderHydratedRefs } from '../ref-hydrate';
import { hydrateRefs, makePlanItemResolver } from '../ref-hydrate-resolve';
import { runFlushGate } from '../../../enforcement-gate-io';
import { trackDetached } from '../../../detached-imports';

const OPEN_HANDOFF_REQUIRED =
  'open-handoff requires to[], summary; plan_slug is optional for ad-hoc handoffs';

/**
 * WI-4165: inline the named plan-items' own bodies into a handoff's `body`
 * before it is written (deref-at-delivery, ref-hydrate.ts — the same
 * mechanism coord:dispatch uses). Fail-soft BY CONTRACT: any resolve hiccup
 * degrades to the plain body, never blocks the handoff. Exported for its
 * unit test; not otherwise part of the public surface.
 */
export async function hydrateHandoffItemBodies(
  args: { plan_slug?: string; items?: string[]; body?: string; harness?: string },
  deps: { hydrateRefs?: typeof hydrateRefs } = {},
): Promise<{ body: string | undefined; itemsHydrated: number }> {
  if (!args.plan_slug || !args.items || args.items.length === 0) {
    return { body: args.body, itemsHydrated: 0 };
  }
  const hydrate = deps.hydrateRefs ?? hydrateRefs;
  try {
    const refs: HydratableRef[] = args.items.map((item) => ({
      kind: 'plan-item' as const,
      slug: args.plan_slug as string,
      item,
    }));
    const hydrated = await hydrate(refs, {
      resolvers: { 'plan-item': makePlanItemResolver(args.harness) },
    });
    const itemsHydrated = hydrated.filter((h) => h.ok).length;
    const block = renderHydratedRefs(hydrated);
    return { body: block ? [args.body, block].filter(Boolean).join('\n\n') : args.body, itemsHydrated };
  } catch {
    return { body: args.body, itemsHydrated: 0 };
  }
}

export default defineTool({
  name: 'coord:handoff',
  description:
    'Record a work transition. Either OPEN a new handoff to other agents (provide `to[]` and `summary`; optionally `plan_slug` and `items` (P-NNN ids of `plan_slug`) to inline each item\'s own body into the delivered note, WI-4165) OR ACCEPT an existing one by passing `accept_msg_id` alone.',
  guidance: {
    when: 'Wrapping up your piece of a plan and naming who picks up next — or accepting a handoff someone made to you.',
    notWhen: 'A routine status update — use coord:send. A blocking decision — use coord:escalate.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    accept_msg_id: z
      .string()
      .optional()
      .describe('Pass to accept an existing handoff; takes precedence over the open-handoff fields.'),
    to: z.array(z.string().min(1)).optional(),
    plan_slug: z.string().optional(),
    summary: z.string().optional(),
    body: z.string().optional(),
    next_action: z.string().optional(),
    files_modified: z.array(z.string()).optional(),
    commit: z.string().optional(),
    items: z
      .array(z.string().max(20))
      .max(40)
      .optional()
      .describe('WI-4165: plan-item ids (P-NNN) of `plan_slug` handed off with this note — each one\'s own body is inlined into the delivered `body`, bounded, so the receiver reads WHAT to pick up without re-fetching the plan.'),
    note: z.string().optional().describe('Free-form note when accepting.'),
  }).superRefine((args, ctx) => {
    // Match the handler's existing truthiness and accept precedence. In
    // particular, accepting does not require any open-handoff fields.
    if (!args.accept_msg_id && (!args.to || !args.summary)) {
      ctx.addIssue({ code: 'custom', message: OPEN_HANDOFF_REQUIRED });
    }
  }).meta({
    'x-papercusp-call-constraint':
      `unless accept_msg_id is nonempty (accept takes precedence): ${OPEN_HANDOFF_REQUIRED}`,
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    if (args.accept_msg_id) {
      const rec = await acceptHandoff(identity, args.accept_msg_id, args.note);
      if (!rec) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'not_found',
                detail: `no handoff with msg_id=${args.accept_msg_id}`,
              }),
            },
          ],
          isError: true,
        };
      }
      // await-event-primitive-2026-06-05 P-015: a sleeping offerer wakes on
      // `handoff:accepted:<msg_id>`; the accept message already covers notify.
      void trackDetached(import('../../../events/await/engine'))
        .then(({ emitAwaitedEvent }) =>
          emitAwaitedEvent({
            key: `handoff:accepted:${args.accept_msg_id}`,
            summary: `handoff ${args.accept_msg_id} accepted by ${identity.ownerId}`,
            payload: { msg_id: args.accept_msg_id, acceptor: identity.ownerId },
            source: identity.ownerId,
          }),
        )
        .catch(() => {});
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: true, accepted: rec }) },
        ],
      };
    }
    if (!args.to || !args.summary) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'missing_fields',
              detail: OPEN_HANDOFF_REQUIRED,
            }),
          },
        ],
        isError: true,
      };
    }
    // P-016 enforcement gate: a handoff hands the receiver whatever the OFFERER
    // flushed — unflushed held-item state (or an armed loop with no carry-note)
    // means the receiver picks up blind. Same refuse-once-then-mechanical-fallback
    // ladder as compaction; bounded + fail-OPEN, so it never blocks a handoff
    // outright. Loads the offerer's carry brief itself (not otherwise read here).
    const gateNowMs = Date.now();
    const gate = await runFlushGate({
      boundary: 'handoff',
      ownerId: identity.ownerId,
      workspaceId: identity.workspaceId ?? '*',
      sessionId: identity.ownerId,
      sinceIso: new Date(gateNowMs - 30 * 60_000).toISOString(),
      nowMs: gateNowMs,
    });
    if (gate.verdict === 'refuse') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'flush-required',
              tripwires: gate.tripwires,
              note: gate.refusalText,
            }),
          },
        ],
        isError: true,
      };
    }
    // owner-2026-06-17: resolve short ownerId prefixes to full ids so the handoff
    // records + reaches the right agent. Best-effort + fail-soft.
    const handoffTo = await resolveBestEffortAgainstRoster(args.to, identity.workspaceId);
    // WI-1375: stamp the harness scope so a cross-machine handoff FEDERATES to the
    // recipient's machine (openHandoff → coord_event_log.harness_slug → capture
    // trigger). A concrete harness only — '*'/empty = operator/SU/oracle wildcard ⇒
    // workspace-local (leave unset), mirroring coord:escalate's resolution.
    const ctxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const harnessSlug =
      typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : undefined;
    // WI-4165: inline each named item's own body (deref-at-delivery) before writing
    // the handoff record — fail-soft, degrades to the plain args.body on any hiccup.
    const { body: hydratedBody, itemsHydrated } = await hydrateHandoffItemBodies({
      plan_slug: args.plan_slug,
      items: args.items,
      body: args.body,
      harness: harnessSlug,
    });
    const rec = await openHandoff(identity, {
      to: handoffTo,
      plan_slug: args.plan_slug,
      summary: args.summary,
      body: hydratedBody,
      next_action: args.next_action,
      files_modified: args.files_modified,
      commit: args.commit,
      ...(harnessSlug ? { harness_slug: harnessSlug } : {}),
    });

    // coord-dispatch-reliability P-003 (wake-on-open): opening a handoff previously
    // only INJECTED to the recipient's inbox — an IDLE recipient never woke, never
    // accepted, and so the offerer's own accept-wake (`handoff:accepted:<id>`) never
    // fired → a silent stall. Now we WAKE the resolved recipient(s) so a sleeping
    // addressee gets a turn to accept, starting the accept→wake-offerer chain.
    //   - SINGLE-TARGET, never a broadcast: wakeRecipients fires one inbox-wake key
    //     per concrete ownerId and skips the SAME NON_WAKEABLE/selector targets the
    //     coord:send wake fan skips ('*'/'human'/empty/@selectors) — no thunder-herd.
    //   - FAIL-SOFT: the handoff is ALREADY durably recorded above; a wake-fan hiccup
    //     must NEVER fail the open (the recipient still sees it on their next natural
    //     turn). Any error here degrades to "no liveness reported".
    //   - LIVENESS surfaced (parallel to P-001's coord:send notWoken): the offerer
    //     learns whether anyone was actually re-invoked, so a handoff that woke
    //     nobody (recipient_absent) is a loud miss they can react to, not a silent one.
    let wake:
      | {
          targets: string[];
          woken: number;
          staged?: number;
          recipient_absent?: boolean;
          /** FF#2: missed addressees with NO live session watching their inbox — genuinely
           *  dead, the handoff black-holes until they're relaunched (mirrors coord:send WI-574). */
          recipient_dead?: string[];
          /** WI-5994: missed addressees that are NOT dead — each has an armed loop
           *  with a known next fire (or a turn in flight now), so the offer will be
           *  seen then, never grounds to treat the handoff as failed. */
          recipient_dormant_scheduled?: DormantScheduledInfo[];
          /** FF#3: each missed addressee's FRESH session state at the open moment. */
          recipient_liveness?: MissedRecipientLiveness[];
          note?: string;
        }
      | undefined;
    try {
      const fan = await wakeRecipients(handoffTo, {
        summary: args.summary,
        source: identity.ownerId,
        workspaceId: identity.workspaceId ?? undefined,
      });
      wake = { targets: fan.targets, woken: fan.woken };
      if (fan.staged > 0) wake.staged = fan.staged;
      // A handoff aimed at concrete, wakeable addressee(s) that woke nobody AND
      // staged nobody is a loud miss (mirrors coord:send wake:'required'): the
      // handoff injected to their inbox, but no session was re-invoked to accept it.
      if (fan.targets.length > 0 && fan.woken === 0 && fan.staged === 0) {
        wake.recipient_absent = true;
        // FF#2/FF#3: classify the dead ones + force their fresh session state into the
        // result, so a handoff to a long-ended agent isn't read as "offered, all good".
        let dead: string[] = [];
        let dormantScheduled: DormantScheduledInfo[] = [];
        try {
          const report = await reportIdleRecipients(fan.targets, { workspaceId: identity.workspaceId ?? undefined });
          dead = report.idle;
          dormantScheduled = report.dormantScheduled ?? [];
        } catch {
          /* fail-soft */
        }
        if (dead.length > 0) wake.recipient_dead = dead;
        if (dormantScheduled.length > 0) wake.recipient_dormant_scheduled = dormantScheduled;
        try {
          const liveness = await describeMissedRecipients(fan.targets, {
            workspaceId: identity.workspaceId,
          });
          if (liveness.length > 0) wake.recipient_liveness = liveness;
        } catch {
          /* fail-soft */
        }
        // WI-5994: `dead` and `dormantScheduled` are disjoint — a dormant-scheduled
        // addressee is NOT "not running"; its next loop fire will see the offer with
        // no relaunch needed. Only genuinely-dead recipients get the black-hole note.
        wake.note =
          (dead.length > 0
            ? `handoff opened, but NO live session is watching the inbox of: ${dead.join(', ')} — they are not running, so this offer black-holes until they are relaunched (NOT "seen on their next turn"). `
            : dormantScheduled.length > 0
              ? `handoff opened; ${dormantScheduled
                  .map((d) => (d.parked ? `${d.ownerId} (mid-turn right now)` : `${d.ownerId} (next fire ${d.nextFireAt})`))
                  .join(', ')} ` +
                'are DORMANT BETWEEN LOOP FIRES, not dead — the offer is DEFERRED to their next scheduled fire, not lost. '
              : `handoff opened, but no awake/watching session was re-invoked for: ${fan.targets.join(', ')} — it is in their inbox (seen on their next natural turn). `) +
          'A handoff is NOT a pickup: it is pending until accepted (accepted:false below). If this work must ' +
          "be picked up now, re-dispatch to a LIVE agent (coord:presence → wakeable:true) or coord:send wake:'required'. " +
          '(A 30m re-ping backstop will nudge you if it stays un-acked; a 12h sweep auto-expires it.)';
      }
    } catch (e) {
      // The open already succeeded; a wake failure is non-fatal. Report nothing.
      console.warn(
        `[coord:handoff] wake-on-open for ${rec.msg_id} failed (handoff still recorded): ${e instanceof Error ? e.message : e}`,
      );
    }

    return {
      content: [
        {
          type: 'text' as const,
          // FF#2 — a freshly-opened handoff is NEVER "done": it is PENDING acceptance.
          // accepted:false makes that explicit in the result so the offerer can't read a
          // successful OPEN as a successful TRANSFER; the accept→wake-back + reconcile sweep
          // close the loop. Mirrors the "verify pickup, don't assume" discipline.
          text: JSON.stringify({
            ok: true,
            msg_id: rec.msg_id,
            ts: rec.ts,
            accepted: false,
            pending_acceptance: true,
            ...(itemsHydrated > 0 ? { itemsHydrated } : {}),
            ...(gate.verdict === 'mechanical-fallback' && gate.fallback
              ? { mechanicalFallback: gate.fallback }
              : {}),
            ...(wake ? { wake } : {}),
          }),
        },
      ],
    };
  },
});
