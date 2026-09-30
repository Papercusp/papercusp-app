/**
 * fleet:require-checkpoint — a leader-initiated FORCED checkpoint that RETURNS
 * whether it landed.
 *
 * P-012 of fleet-leadership-continuity-and-actuation-2026-08-01.
 *
 * THE GAP. Before standing a member down, killing it, reassigning its lane, or
 * advising it to compact, a leader needs one fact: *is this member's in-flight state
 * durable yet?* Today the leader can only ASK — `coord:send { wake:'required' }` and
 * read `woken:1`. That proves a session woke, nothing more. The leader then acts on
 * hope. When the hope is wrong the loss is silent and total: the member is killed
 * mid-thought and whatever it had not written is simply gone, discovered later as a
 * successor re-deriving work that was already done.
 *
 * P-002 removes the COMMON race (the flush gate refuses a self-compaction with dirty
 * state). This covers the GENERAL case, which P-002 structurally cannot: the boundary
 * is being imposed from OUTSIDE, by the leader, on a session that is not itself
 * choosing to stop. Nothing in the member's own turn is going to run.
 *
 * THE SHAPE. This is deliberately NOT an ack channel — same stance as P-013, and for
 * the same reason: a reply is an assertion by the party under instruction, which is
 * precisely the party whose compliance is in question. "Will do" followed by a kill
 * reads as compliance on every ack-based surface. So the verdict here is DERIVED from
 * the ledger that records checkpoints (`harness_shared.carry_notes`, scope
 * `workitem:<harness>:<id>`) via P-013's `resolveDirectiveEffect`. Zero new probe
 * logic: the same pure resolver answers both questions this tool asks, just measured
 * against two different instants —
 *
 *   baseline   sentAtMs = now − freshSec  → "is there ALREADY a checkpoint this fresh?"
 *   did-it-land sentAtMs = directive time → "was one written AFTER I asked?"
 *
 * — which is why `pre-existing` can never be miscounted as compliance here either.
 *
 * FOUR HONEST DELIVERY OUTCOMES, not a boolean. `woken: 0` does NOT mean dead — a
 * member actively taking a turn is not asleep on its wake key, and a loop-armed member
 * between fires is dormant, not gone. Collapsing those into "undeliverable" would make
 * this tool cry wolf; collapsing them into "fine" would make it lie. So the miss path
 * reuses `reportIdleRecipients` — the SAME classifier `coord:send` uses — which splits
 * genuinely-not-running from dormant-with-a-scheduled-fire, and reports `degraded`
 * when the roster read failed and it honestly cannot tell.
 *
 * WHAT THE LEADER READS. `itemStateSafe` is true ONLY when every required item is
 * `already-fresh`, `already-terminal`, or `landed` — never for
 * `pending`, `staged`, `undeliverable`, or `unprovable`. The one thing this tool must
 * never do is let a leader read "safe" and then destroy unsaved work, so every
 * not-proven path states what is still unknown and `nextAction` names the concrete
 * lever. Its scope is deliberately narrow and SAID so: work-item checkpoints.
 * Session-level carry (`loop:checkpoint`) is a different ledger and is not claimed
 * here.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { groupByAgent, listFleetAssignments } from '../../fleet/assignments';
import { sendMessage } from '../coordination/messages';
import { wakeRecipients, reportIdleRecipients, type DormantScheduledInfo } from '../coordination/inbox-wake';
import {
  fetchDirectiveActuations,
  type DirectiveActuation,
  type DirectiveEffectSpec,
} from '../coordination/directive-effect';
import { hardText, softText, clampText, LIMITS } from '../limits';

/** Default freshness window: a checkpoint written within this many seconds already
 *  makes the member's item state durable, so requiring another one would burn a
 *  member turn to re-write what is already on disk. */
export const DEFAULT_FRESH_SEC = 180;
/** Default: fire the directive and report the probe, don't block the leader's turn. */
export const DEFAULT_WAIT_SEC = 0;
export const MAX_WAIT_SEC = 300;
/** The dispatch budget must outlive the maximum ledger-polling wait plus a small margin. */
export const REQUIRE_CHECKPOINT_TIMEOUT_SEC = MAX_WAIT_SEC + 30;
/** How often the wait loop re-probes the ledger. */
export const POLL_INTERVAL_MS = 2_000;

export type CheckpointVerdict =
  | 'already-fresh'
  | 'already-terminal'
  | 'landed'
  | 'pending'
  | 'staged'
  | 'undeliverable'
  | 'unprovable';

/** How the directive reached (or failed to reach) the member. Derived once for the
 *  member, then applied to each item's verdict. */
export type DeliveryOutcome =
  | 'woken'
  | 'running'
  | 'dormant-scheduled'
  | 'staged'
  | 'not-running'
  | 'indeterminate';

export interface CheckpointItemOutcome {
  itemId: string;
  verdict: CheckpointVerdict;
  /** One line naming what was observed — and, when unproven, what would prove it. */
  evidence: string;
  /** ISO of the observed durable evidence timestamp, when one is recorded. */
  checkpointAt: string | null;
}

/**
 * PURE: resolve `member` against the roster, accepting a short ownerId PREFIX the way
 * coord:send's `resolveBestEffortAgainstRoster` does — a leader reading a truncated id
 * off a brief must not get a wrong answer for it.
 *
 * Returns null for BOTH "no match" and "ambiguous prefix". Guessing between two
 * candidates would answer a safety question about the wrong agent, which is strictly
 * worse than refusing: the caller is about to destroy state on this verdict.
 */
export function resolveMemberGroup<T extends { agentId: string }>(groups: readonly T[], member: string): T | null {
  const exact = groups.find((g) => g.agentId === member);
  if (exact) return exact;
  const prefixed = groups.filter((g) => g.agentId.startsWith(member));
  return prefixed.length === 1 ? prefixed[0] : null;
}

/**
 * PURE: classify how the directive landed, from the wake fan's counts plus the idle
 * probe. Split out so the "woken:0 is not death" rule is directly testable and a later
 * edit cannot quietly re-collapse it.
 *
 * `degraded` means the roster read failed: we genuinely cannot tell running from gone,
 * so the answer is `indeterminate` — never `not-running`, which would send a leader to
 * respawn a healthy member.
 */
export function classifyDelivery(input: {
  woken: number;
  staged: number;
  idle: readonly string[];
  dormantScheduled: readonly DormantScheduledInfo[];
  degraded: boolean;
  member: string;
}): DeliveryOutcome {
  if (input.staged > 0) return 'staged';
  if (input.woken > 0) return 'woken';
  if (input.degraded) return 'indeterminate';
  if (input.idle.includes(input.member)) return 'not-running';
  if (input.dormantScheduled.some((d) => d.ownerId === input.member)) return 'dormant-scheduled';
  // Not asleep, not idle, not dormant ⇒ a live session mid-turn. The inject is
  // durable and it sees the directive on its current/next turn.
  return 'running';
}

/** PURE: the one line explaining a delivery outcome, so the wording is testable. */
export function deliveryEvidence(outcome: DeliveryOutcome, member: string, dormant?: DormantScheduledInfo): string {
  switch (outcome) {
    case 'woken':
      return `directive delivered and ${member} was WOKEN to act on it`;
    case 'running':
      return `${member} is mid-turn (not asleep), so the directive was injected and is seen on its current/next turn`;
    case 'dormant-scheduled':
      return dormant?.parked
        ? `${member} has a loop turn IN FLIGHT right now — the directive is picked up on that turn`
        : `${member} is dormant between loop fires; the directive is picked up at its next fire${dormant?.nextFireAt ? ` (${dormant.nextFireAt})` : ''}`;
    case 'staged':
      return `${member} is in MANUAL wake-mode — the directive was STAGED, not delivered; nothing will act on it until its wake-mode is flipped or it is resumed`;
    case 'not-running':
      return `NO live session is watching ${member}'s inbox and no scheduled loop fire will pick it up — it is genuinely not running, so the directive black-holes`;
    case 'indeterminate':
      return `the liveness probe DEGRADED (roster read failed), so whether ${member} can act on the directive is genuinely unknown`;
  }
}

/**
 * PURE: fold one item's ledger actuation + the delivery outcome into the verdict.
 *
 * Ordering matters and is deliberate: a checkpoint that actually LANDED, or a durable
 * terminal completion that makes another checkpoint impossible, outranks every delivery
 * complaint. A member can be classified `not-running` a moment after it wrote the
 * checkpoint and exited — the state is durable, which is the only question asked, so
 * that must read `landed`, not `undeliverable`.
 */
export function foldItemVerdict(
  actuation: DirectiveActuation,
  delivery: DeliveryOutcome,
  member: string,
  dormant?: DormantScheduledInfo,
): CheckpointItemOutcome {
  const itemId = actuation.spec.itemId;
  const checkpointAt = actuation.observedAtMs ? new Date(actuation.observedAtMs).toISOString() : null;
  if (actuation.alternativeProof === 'terminal-completion') {
    return {
      itemId,
      verdict: 'already-terminal',
      evidence: actuation.evidence,
      checkpointAt,
    };
  }
  if (actuation.verdict === 'satisfied') {
    return { itemId, verdict: 'landed', evidence: actuation.evidence, checkpointAt };
  }
  if (actuation.verdict === 'unknown') {
    return { itemId, verdict: 'unprovable', evidence: actuation.evidence, checkpointAt };
  }
  const why = deliveryEvidence(delivery, member, dormant);
  if (delivery === 'staged') {
    return { itemId, verdict: 'staged', evidence: `no checkpoint yet for ${itemId} — ${why}`, checkpointAt };
  }
  if (delivery === 'not-running') {
    return { itemId, verdict: 'undeliverable', evidence: `no checkpoint yet for ${itemId} — ${why}`, checkpointAt };
  }
  if (delivery === 'indeterminate') {
    return { itemId, verdict: 'unprovable', evidence: `no checkpoint yet for ${itemId} — ${why}`, checkpointAt };
  }
  return { itemId, verdict: 'pending', evidence: `no checkpoint yet for ${itemId} — ${why}`, checkpointAt };
}

/** The verdicts that PROVE the item's state is durable. Nothing else counts. */
const SAFE_VERDICTS: ReadonlySet<CheckpointVerdict> = new Set<CheckpointVerdict>([
  'already-fresh',
  'already-terminal',
  'landed',
]);

export interface RequireCheckpointSummary {
  itemStateSafe: boolean;
  nextAction: string | null;
  summary: string;
}

/**
 * PURE: the leader-facing bottom line.
 *
 * `itemStateSafe` is an AND over proofs, never a majority or a best-effort. One
 * unproven item is enough to make standing the member down lossy, so it is enough to
 * make the answer false.
 */
export function summarizeRequireCheckpoint(outcomes: readonly CheckpointItemOutcome[]): RequireCheckpointSummary {
  if (outcomes.length === 0) {
    return {
      itemStateSafe: true,
      nextAction: null,
      summary:
        'This member holds no active work-item claims, so there is no item state to checkpoint. NOTE: session-level carry (loop:checkpoint) is a different ledger and was NOT checked.',
    };
  }
  const unsafe = outcomes.filter((o) => !SAFE_VERDICTS.has(o.verdict));
  if (unsafe.length === 0) {
    const landed = outcomes.filter((o) => o.verdict === 'landed').length;
    const terminal = outcomes.filter((o) => o.verdict === 'already-terminal').length;
    const fresh = outcomes.length - landed - terminal;
    return {
      itemStateSafe: true,
      nextAction: null,
      summary:
        `All ${outcomes.length} item(s) have durable item state (${landed} checkpoint(s) written on this directive, ${fresh} already fresh, ` +
        `${terminal} terminal completion(s) already durable). ` +
        'Safe to stand down / reassign / advise compaction, as far as WORK-ITEM state goes — session-level carry (loop:checkpoint) is a separate ledger and was not checked.',
    };
  }
  const byVerdict = (v: CheckpointVerdict) => unsafe.filter((o) => o.verdict === v).map((o) => o.itemId);
  const undeliverable = byVerdict('undeliverable');
  const staged = byVerdict('staged');
  const pending = byVerdict('pending');
  const unprovable = byVerdict('unprovable');
  let nextAction: string;
  if (undeliverable.length > 0) {
    nextAction =
      `DO NOT stand this member down or advise compaction — ${undeliverable.join(', ')} has unsaved state and the member is NOT RUNNING, ` +
      'so nothing will ever write it. Its in-flight state is only recoverable by resuming that session ' +
      '(capability:launch-agent resume), or accept the loss deliberately and reclaim the item (work_items:request_release).';
  } else if (staged.length > 0) {
    nextAction =
      `The directive for ${staged.join(', ')} is STAGED, not delivered (manual wake-mode). Flip the member to auto wake-mode or resume it, ` +
      'then re-run this tool — until then the checkpoint will not happen.';
  } else if (pending.length > 0) {
    nextAction =
      `Delivered but not yet written for ${pending.join(', ')}. Re-run with { waitSec } to block until it lands, or re-check before acting. ` +
      'The member has the directive; it has not carried it out YET.';
  } else {
    nextAction =
      `Cannot prove the checkpoint state of ${unprovable.join(', ')} — see each item's evidence for what would prove it. ` +
      'Treat as UNSAFE until proven; do not destroy state on an unprovable verdict.';
  }
  return {
    itemStateSafe: false,
    nextAction,
    summary: `${unsafe.length} of ${outcomes.length} item(s) do NOT have a proven durable checkpoint.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(data: unknown) {
  return { data };
}

export default defineTool({
  name: 'fleet:require-checkpoint',
  profile: 'engineer',
  description:
    "Force a fleet member to checkpoint its in-flight state and RETURN whether it landed — the pre-check before " +
    "standing a member down, killing it, reassigning its lane, or advising compaction. Skips the wake when a " +
    "checkpoint is already fresh (freshSec). The verdict is DERIVED from the checkpoint ledger (woken:1 is delivery, " +
    "not compliance): itemStateSafe is true ONLY when every item is already-fresh, already-terminal, or landed, " +
    "with per-item verdicts (already-fresh|already-terminal|landed|pending|staged|undeliverable|unprovable), " +
    "evidence, and a nextAction. { waitSec } blocks " +
    "until it lands. Scope: work-item checkpoints only — session carry (loop:checkpoint) is a separate ledger.",
  guidance: {
    when:
      "Before any leader action that destroys or interrupts a member's in-flight state — stand-down, fleet:kill, " +
      "lane reassignment, advising compaction — and when deciding whether reclaiming a stalled member's item would lose work.",
    notWhen:
      "The member is choosing its own boundary (its flush gate already refuses a dirty self-compaction). Reading " +
      "current checkpoints without requiring new ones — work_items:get. Handing work over rather than saving it — " +
      "coord:handoff / work_items:request_release.",
    chaining:
      "fleet:require-checkpoint { member, itemId } → itemStateSafe:true → stand down / kill / reassign; false → " +
      "follow nextAction (resume, flip wake-mode, or re-run with waitSec) BEFORE destroying state. Verdicts also " +
      "surface on fleet:leader-brief members[].directiveActuation.",
    seeAlso: [
      'work_items:checkpoint (what the MEMBER runs — this asks them to)',
      'fleet:leader-brief (whole-fleet health, incl. directives actuation)',
      "coord:send { expectEffect } (the general derived-actuation channel this specializes)",
      'work_items:request_release (reclaiming an item rather than saving its state)',
    ],
  },
  capability: 'coord:write',
  // waitSec can block for MAX_WAIT_SEC; leave margin for the final probe and response.
  timeoutSec: REQUIRE_CHECKPOINT_TIMEOUT_SEC,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    member: hardText(LIMITS.IDENT).describe('ownerId of the fleet member whose state must be made durable.'),
    itemId: hardText(LIMITS.IDENT)
      .optional()
      .describe('The work-item to checkpoint. Omit to require a checkpoint on EVERY active work-item claim they hold.'),
    harness: z.string().max(80).optional(),
    workspace: z.string().max(120).optional(),
    reason: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('Why the checkpoint is required — rides the directive so the member knows what is about to happen.'),
    freshSec: z
      .number()
      .int()
      .min(0)
      .max(86_400)
      .optional()
      .describe(
        `A checkpoint newer than this many seconds already counts as durable — no wake is sent for it (default ${DEFAULT_FRESH_SEC}). Pass 0 to force a fresh checkpoint regardless.`,
      ),
    waitSec: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_SEC)
      .optional()
      .describe(
        `Block up to this long re-probing the ledger until the checkpoint lands (default ${DEFAULT_WAIT_SEC} = fire and report immediately, max ${MAX_WAIT_SEC}).`,
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null };
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, identity.workspaceId ?? null);
    const harnessHint = args.harness ?? (c.harnessSlug && c.harnessSlug !== '*' ? c.harnessSlug : undefined);
    const freshSec = args.freshSec ?? DEFAULT_FRESH_SEC;
    const waitSec = args.waitSec ?? DEFAULT_WAIT_SEC;

    // ── 1. Which items must be durable? ──────────────────────────────────────
    let specs: DirectiveEffectSpec[];
    if (args.itemId) {
      specs = [{ kind: 'checkpoint', itemId: args.itemId, ...(harnessHint ? { harness: harnessHint } : {}) }];
    } else {
      const rows = await listFleetAssignments({ workspaceId, harness: args.harness, activeOnly: true });
      let group = resolveMemberGroup(groupByAgent(rows), args.member);

      // `harness_slug` is intentionally NULL on presence rows: identity/fleet
      // membership is workspace-scoped, while claims are harness-scoped. An
      // un-targeted harness-filtered assignment read therefore cannot see a
      // live member who currently holds no claim (the exact cohort this
      // safety primitive must protect). Re-run the lookup with the member
      // targeted so listFleetAssignments preserves that member's presence row.
      // If the caller supplied a short prefix, resolve it against the complete
      // workspace roster first, then repeat the targeted, harness-scoped read.
      if (!group && args.harness) {
        const targetedRows = await listFleetAssignments({
          workspaceId,
          agent: args.member,
          harness: args.harness,
          activeOnly: true,
        });
        group = resolveMemberGroup(groupByAgent(targetedRows), args.member);
      }
      if (!group && args.harness) {
        const rosterRows = await listFleetAssignments({ workspaceId, activeOnly: true });
        const rosterGroup = resolveMemberGroup(groupByAgent(rosterRows), args.member);
        if (rosterGroup) {
          const targetedRows = await listFleetAssignments({
            workspaceId,
            agent: rosterGroup.agentId,
            harness: args.harness,
            activeOnly: true,
          });
          group = resolveMemberGroup(groupByAgent(targetedRows), rosterGroup.agentId);
        }
      }
      // A member we cannot RESOLVE is not a member with nothing to save. Collapsing
      // those two into "no claims ⇒ safe" would emit the one output this tool must
      // never produce: a false `itemStateSafe: true` — here caused by nothing worse
      // than a typo or a short ownerId prefix, and cashed out as a stand-down that
      // silently discards live work. Refuse instead of reassuring.
      if (!group) {
        return json({
          ok: false,
          error: 'member_not_found',
          member: args.member,
          hint:
            `No agent matching '${args.member}' holds assignments in this workspace, so whether it has unsaved state ` +
            'is UNKNOWN — this is NOT a safe verdict. Check the ownerId (coord:presence / fleet:assignments), or pass ' +
            '{ itemId } explicitly to require a checkpoint on a specific item regardless of the roster.',
        });
      }
      specs = (group.claims ?? [])
        .filter((cl) => cl.type === 'work-item' && cl.active && cl.id)
        .map((cl) => ({
          kind: 'checkpoint' as const,
          itemId: cl.id as string,
          ...(cl.harnessSlug ? { harness: cl.harnessSlug } : {}),
        }));
      if (specs.length === 0) {
        const empty = summarizeRequireCheckpoint([]);
        return json({
          ok: true,
          member: args.member,
          items: [],
          ...empty,
          directiveSent: false,
        });
      }
    }

    // ── 2. Baseline: is a fresh-enough checkpoint ALREADY on disk? ────────────
    // Reuses P-013's resolver with sentAtMs = now − freshSec, so "fresh enough"
    // and "landed after my directive" are answered by ONE audited rule.
    const nowMs = Date.now();
    const freshnessFloorMs = nowMs - freshSec * 1000;
    const baseline = await fetchDirectiveActuations(
      specs.map((s) => ({ ...s, sentAtMs: freshnessFloorMs })),
      { workspaceId },
    );
    const alreadyFresh: CheckpointItemOutcome[] = [];
    const needed: DirectiveEffectSpec[] = [];
    for (let i = 0; i < specs.length; i++) {
      const a = baseline[i];
      if (a && (a.verdict === 'satisfied' || a.alternativeProof === 'terminal-completion')) {
        const terminal = a.alternativeProof === 'terminal-completion';
        alreadyFresh.push({
          itemId: specs[i].itemId,
          verdict: terminal ? 'already-terminal' : 'already-fresh',
          evidence: terminal
            ? `${a.evidence} — no directive sent.`
            : `checkpoint is already within the ${freshSec}s freshness window (${a.evidence}) — no directive sent.`,
          checkpointAt: a.observedAtMs ? new Date(a.observedAtMs).toISOString() : null,
        });
      } else {
        needed.push(specs[i]);
      }
    }
    if (needed.length === 0) {
      const fold = summarizeRequireCheckpoint(alreadyFresh);
      return json({
        ok: true,
        member: args.member,
        items: alreadyFresh,
        ...fold,
        directiveSent: false,
      });
    }

    // ── 3. Send the directive — one stamped envelope per item ────────────────
    // One envelope per item because `expectEffect` is one-expectation-per-envelope
    // by P-013's design; batching them into a single message would under-report
    // every item but the first on fleet:leader-brief. A SINGLE wake follows all
    // sends, so N items still cost the member exactly one interruption.
    const reason = clampText(args.reason, LIMITS.ANNOTATION) ?? 'your leader is about to stand down / reassign this lane';
    const directiveSentMs = Date.now();
    for (const spec of needed) {
      await sendMessage(identity, {
        to: [args.member],
        summary: `CHECKPOINT REQUIRED on ${spec.itemId} — ${reason}`,
        body:
          `Write your in-flight state NOW: work_items:checkpoint { id: '${spec.itemId}', checkpoint: '<what you have done, what is left, the next concrete action>' }.\n\n` +
          'Your leader is verifying this from the checkpoint LEDGER, not from a reply — do the write; an acknowledgement does not count. ' +
          'Anything not written may be lost when this lane is interrupted.',
        kind: 'message',
        harnessSlug: spec.harness ?? harnessHint ?? null,
        extra: {
          expectEffect: {
            kind: 'checkpoint',
            itemId: spec.itemId,
            ...(spec.harness ? { harness: spec.harness } : {}),
          },
        },
      });
    }

    const fan = await wakeRecipients([args.member], {
      summary: `checkpoint required on ${needed.map((s) => s.itemId).join(', ')}`,
      source: 'fleet:require-checkpoint',
      workspaceId,
    });

    // ── 4. How did it land? (woken:0 is NOT death — see classifyDelivery) ─────
    let idle: string[] = [];
    let dormantScheduled: DormantScheduledInfo[] = [];
    let degraded = false;
    if (fan.woken === 0 && fan.staged === 0) {
      try {
        const report = await reportIdleRecipients([args.member], { workspaceId });
        idle = report.idle;
        dormantScheduled = report.dormantScheduled ?? [];
        degraded = report.degraded;
      } catch {
        degraded = true;
      }
    }
    const delivery = classifyDelivery({
      woken: fan.woken,
      staged: fan.staged,
      idle,
      dormantScheduled,
      degraded,
      member: args.member,
    });
    const dormant = dormantScheduled.find((d) => d.ownerId === args.member);

    // ── 5. Did it land? Optionally wait for it. ───────────────────────────────
    const probe = async (): Promise<DirectiveActuation[]> =>
      fetchDirectiveActuations(
        needed.map((s) => ({ ...s, sentAtMs: directiveSentMs })),
        { workspaceId },
      );
    let actuations = await probe();
    if (waitSec > 0) {
      const deadline = Date.now() + waitSec * 1000;
      while (
        actuations.some((a) => a.verdict !== 'satisfied' && a.alternativeProof !== 'terminal-completion') &&
        Date.now() + POLL_INTERVAL_MS <= deadline
      ) {
        await sleep(POLL_INTERVAL_MS);
        actuations = await probe();
      }
    }

    const requiredOutcomes = actuations.map((a) => foldItemVerdict(a, delivery, args.member, dormant));
    const items = [...alreadyFresh, ...requiredOutcomes];
    const fold = summarizeRequireCheckpoint(items);

    return json({
      ok: true,
      member: args.member,
      items,
      ...fold,
      directiveSent: true,
      directiveSentAt: new Date(directiveSentMs).toISOString(),
      delivery,
      deliveryEvidence: deliveryEvidence(delivery, args.member, dormant),
      waitedSec: waitSec,
      ...(fan.stagedTargets.length > 0 ? { stagedTargets: fan.stagedTargets } : {}),
    });
  },
});
