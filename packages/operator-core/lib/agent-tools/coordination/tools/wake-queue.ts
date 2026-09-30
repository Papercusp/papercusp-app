/**
 * coord:wake-queue — review a manual-mode agent's STAGED wakes (the pause/edit
 * gate's review surface, hive-agent-tabs-psu-tui-2026-06-09 P-009 / D-005).
 *
 *   list        — the agent's pending wakes, oldest-first (each row may carry a
 *                 `count` > 1: identical re-fires coalesce at staging, EI-312).
 *   release     — deliver ONE (as-is, or `edited` content) to the agent as its
 *                 next turn (emits the inbox-wake), then drops it from the queue.
 *   skip        — discard ONE without delivering.
 *   release_all — drain the WHOLE queue as ONE coalesced wake (the union of all
 *                 staged items, newest as headline — mirrors the live pump's
 *                 coalesceDeliveries), then clears it. One turn for N wakes.
 *   skip_all    — discard the whole queue without delivering.
 *
 * Wakes land here only when the agent's wake-mode is `manual` (the staging
 * happens in wakeRecipients, P-007) — so this is inert until that gate stages
 * something.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../roles';
import {
  listPendingWakes,
  listAllPendingWakes,
  releasePendingWake,
  clearPendingWakes,
  type PendingWake,
} from '../pending-wakes';
import { inboxWakeKey } from '../inbox-wake';
import { emitAwaitedEvent } from '../../../events/await/engine';

/** A staged wake's display label: its summary, ×count when re-fires coalesced. */
function wakeLabel(pw: PendingWake): string {
  const base = pw.summary ?? pw.source ?? `wake #${pw.id}`;
  return pw.count > 1 ? `${base} (×${pw.count})` : base;
}

/**
 * Fold a whole staged queue into ONE wake — the staging-side mirror of the live
 * pump's coalesceDeliveries (events/await/engine.ts): newest row is the headline,
 * summary/payload carry the union.
 */
function coalesceStagedWakes(pending: PendingWake[]): { summary: string; payload: unknown } {
  const headline = pending[pending.length - 1];
  if (pending.length === 1) {
    return { summary: wakeLabel(headline), payload: headline.payload };
  }
  const fires = pending.reduce((n, p) => n + p.count, 0);
  return {
    summary:
      `${pending.length} staged wake(s) released while you were paused` +
      (fires > pending.length ? ` (${fires} fires coalesced)` : '') +
      `: ${pending.map(wakeLabel).join(' · ')}`,
    payload: {
      coalesced: true,
      count: pending.length,
      wakes: pending.map((p) => ({
        id: p.id,
        summary: p.summary,
        payload: p.payload,
        source: p.source,
        count: p.count,
        created_at: p.createdAt,
        last_seen_at: p.lastSeenAt,
      })),
      latest: { summary: headline.summary, payload: headline.payload },
    },
  };
}

export default defineTool({
  name: 'coord:wake-queue',
  description:
    "Review a manual-mode agent's STAGED wakes: list them, release one (deliver as-is or edited as the agent's next turn), skip one (discard), or drain the whole queue — release_all delivers ONE coalesced wake for everything staged; skip_all discards everything. The pause/edit gate's review surface (hive-agent-tabs D-005 / P-009).",
  guidance: {
    when: "Reviewing a manual-mode agent's staged wakes from its pane — releasing the ones to deliver (optionally edited) and skipping the rest. Draining a backlog → release_all (one consolidated turn) or skip_all, never N individual releases.",
    notWhen: 'An auto-mode agent — its wakes fire immediately, nothing is staged. Changing the mode itself — that\'s coord:wake-mode.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The agent owner id whose staged wakes to act on. Omittable ONLY for list — an agent-less list returns EVERY agent\'s staged wakes (the fleet-wide wake board).',
      ),
    action: z
      .enum(['list', 'release', 'skip', 'release_all', 'skip_all'])
      .default('list')
      .describe(
        'list (default) | release (deliver one) | skip (discard one) | release_all (drain the queue as ONE coalesced wake) | skip_all (discard everything).',
      ),
    id: z
      .number()
      .int()
      .optional()
      .describe('The pending-wake id — required for release / skip.'),
    edited: z
      .string()
      .optional()
      .describe('Edited content to deliver instead of the staged summary (release / release_all).'),
  }),
  async handler(args) {
    if (args.action === 'list') {
      // Agent-less list = the fleet-wide board (every owner's staged wakes,
      // grouped by owner) — the roster can't see queues staged for agents
      // that have since gone stale, so this is the only complete read.
      const pending = args.agent ? await listPendingWakes(args.agent) : await listAllPendingWakes();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, pending }) }],
      };
    }
    if (args.agent == null) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, reason: 'agent-required', action: args.action }),
          },
        ],
      };
    }
    if (args.action === 'skip_all') {
      const skipped = await clearPendingWakes(args.agent);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, skipped }) }],
      };
    }
    if (args.action === 'release_all') {
      const pending = await listPendingWakes(args.agent);
      if (pending.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: true, released: 0, woken: 0 }) },
          ],
        };
      }
      const union = coalesceStagedWakes(pending);
      const headline = pending[pending.length - 1];
      const res = await emitAwaitedEvent({
        key: inboxWakeKey(args.agent),
        summary: args.edited ?? union.summary,
        payload: union.payload,
        source: headline.source ?? undefined,
        workspaceId: headline.workspaceId ?? undefined,
      });
      await clearPendingWakes(args.agent);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, released: pending.length, woken: res.woken }),
          },
        ],
      };
    }
    if (args.id == null) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, reason: 'id-required', action: args.action }),
          },
        ],
      };
    }
    if (args.action === 'skip') {
      // Scope the raw-id delete to THIS agent's own queue — `releasePendingWake`
      // deletes by bare id, so without this membership check a caller could skip
      // ANOTHER agent's staged wake by raw id (cross-agent isolation gap). Mirror
      // `release`'s membership match: a foreign / unknown id is `not-found`, never
      // a silent delete.
      const target = (await listPendingWakes(args.agent)).find((p) => p.id === args.id);
      if (!target) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'not-found', id: args.id }) },
          ],
        };
      }
      await releasePendingWake(args.id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, skipped: args.id }) }],
      };
    }
    // release: find the staged wake, deliver it (emit the inbox-wake — this bypasses
    // the manual gate because the owner has explicitly chosen to release), then drop it.
    const pw = (await listPendingWakes(args.agent)).find((p) => p.id === args.id);
    if (!pw) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'not-found', id: args.id }) },
        ],
      };
    }
    const res = await emitAwaitedEvent({
      key: inboxWakeKey(args.agent),
      summary: args.edited ?? wakeLabel(pw),
      payload: pw.payload,
      source: pw.source ?? undefined,
      workspaceId: pw.workspaceId ?? undefined,
    });
    await releasePendingWake(args.id);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, released: args.id, woken: res.woken }) },
      ],
    };
  },
});
