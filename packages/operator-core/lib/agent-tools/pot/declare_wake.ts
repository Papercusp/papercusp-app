/**
 * pot:declare-wake — the Pot operator declares its own next wake before ending
 * a turn (autoloop-hive-operator-rebuild-2026-06-05 P0, D-002). REPLACE
 * semantics like coord:declare-intent: each call describes the WHOLE wake —
 * a time (`at` | `inSeconds`), event subscriptions (`events`), both, or
 * nothing (`mode:'none'`/all omitted). Omitted parts are cleared.
 *
 * The time wake is durable (a one-shot `pot-wake` routine row fired by the
 * DBOS routinesTick → system:blueprint-run → the pot launch blueprint); event
 * wakes are persisted subscriptions projected into live event-reaction rules
 * that fire `pot:wake`. A wake floor clamps the time (≥ now+floor) so a
 * confused operator can't spin.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import type { DataCondition } from '@papercusp/rules';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  clearPotTimeWake,
  declarePotTimeWake,
  potWakeFloorSec,
  resolvePotHomeSlug,
  setPotCarryNote,
  setPotEventSubscriptions,
  type PotEventSubscription,
} from '../../pot/wake';
import {
  evaluateWakeFrontierGuard,
  listUnplacedPotFrontier,
  listNonTerminalPlacements,
} from '../../pot/wake-frontier-guard';
import {
  withDefaultPotWakeSubscriptions,
  defaultPotEventSubscriptions,
  readCreateWakeSuppressPlans,
} from '../../pot/wake-defaults';
import { getPotStarted } from '../../pot/started';
import { refuseIfMugKettleRetired } from '../_mug-kettle-gate';
import { getOwnerSteering, isPausedNow } from '../../owner-steering';
import { softText, clampText, LIMITS } from '../limits';
import { looksLikeUnverifiedOwnerClaim, UNVERIFIED_OWNER_CLAIM_GUIDANCE } from '../../pot/owner-claim-guard';

const subscriptionSchema = z.object({
  on: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe(
    'Trigger tool name(s) to wake on, e.g. "coord:escalate".',
  ),
  when: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Optional declarative condition (a @papercusp/rules DataCondition over {args,result,ctx}).'),
  note: softText(LIMITS.ANNOTATION).optional().describe('Why you subscribed — shown in pot:status. Auto-truncated to 2000 chars if longer.'),
});

export default defineTool({
  name: 'pot:declare-wake',
  profile: 'engineer',
  description:
    "Declare the pot operator's next wake (REPLACE semantics — omitted parts are cleared): a time (`at` ISO / `inSeconds`), event subscriptions (`events: [{on, when?, note?}]`), both, or nothing (`mode:'none'`). The time is clamped to a wake floor; event wakes fire pot:wake when the subscribed tool-event matches.",
  guidance: {
    when: 'You are the pot/operator ending a turn — ALWAYS declare your next wake (a time, events, or explicitly none). Also when the user asks to schedule or re-schedule the operator.',
    notWhen: 'To fire the pot right now — that is pot:wake.',
    chaining: 'pot:status to inspect the current declaration; pot:wake for an immediate manual fire.',
    seeAlso: [
      'pot:status (inspect the current wake declaration)',
      'pot:wake (fire an immediate manual wake instead of scheduling)',
    ],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      at: z.string().datetime({ offset: true }).optional().describe('Absolute wake time (ISO 8601).'),
      inSeconds: z.number().positive().max(60 * 60 * 24 * 30).optional().describe('Relative wake time in seconds from now.'),
      events: z.array(subscriptionSchema).max(20).optional().describe('Event-wake subscriptions (replaces the current set; omit to clear).'),
      mode: z.literal('none').optional().describe("Explicit 'nothing' — sleep until the user or a manual pot:wake."),
      harness: z.string().max(120).optional().describe('Home harness slug the wake fires against (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
      kickoff: softText(LIMITS.ANNOTATION).optional().describe('Kickoff text the woken operator reads (why this wake exists). Auto-truncated to 2000 chars if longer.'),
      remember: z
        .string()
        .optional()
        .describe(
          "Your CARRY-NOTE for next wake — what future-you needs to continue (in-flight intention, a tentative conclusion, a revisit-trigger). REPLACE-semantics: omit to carry nothing (next wake re-derives from the floor). Do NOT restate the deterministic floor (frontier/cups/inbox — that's recomputed) or dump the transcript; longer notes cost uncached tail tokens every wake, so carry only what matters.",
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          'Override the frontier guard (EI-309): declare an event-only/none wake even though the home harness has unplaced todo work items. Only set this when you deliberately intend to leave them unplaced.',
        ),
    })
    .refine((a) => !(a.at != null && a.inSeconds != null), { message: 'pass either at or inSeconds, not both' })
    .refine((a) => !(a.mode === 'none' && (a.at != null || a.inSeconds != null || (a.events?.length ?? 0) > 0)), {
      message: "mode:'none' cannot be combined with a time or events",
    }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    if (!installSlug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_home_harness',
              message: 'Pass `harness` (or set PAPERCUSP_POT_HOME_SLUG) — the wake routine is harness-scoped.',
            }),
          },
        ],
      };
    }
    // EI-18742016294354354: refuse a note/kickoff/carry-note that reads as a claim
    // the owner already made a decision ("the owner answered X", "approved by the
    // owner"). This tool has no provenance mechanism (unlike coord:send{relayOf} or
    // facts:assert{sourceRef}) — such a claim would outlive the session that knew it
    // was speculative and render as bare fact at the next wake. Pure text check, no
    // side effects yet, so it runs before any DB read/mutation below.
    const claimCandidates: Array<[string, string | undefined]> = [
      ...(args.events ?? []).map((s, i): [string, string | undefined] => [`events[${i}].note`, s.note]),
      ['kickoff', args.kickoff],
      ['remember', args.remember],
    ];
    for (const [field, text] of claimCandidates) {
      if (looksLikeUnverifiedOwnerClaim(text)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'unverified_owner_claim',
                field,
                message: UNVERIFIED_OWNER_CLAIM_GUIDANCE,
              }),
            },
          ],
        };
      }
    }

    const { sql } = getOrgPg();

    // D-048 ruled this TIER ("You are the pot/operator ending a turn — ALWAYS
    // declare your next wake" = the Mug's own loop primitive), and D-049 is why
    // this refusal is placed HERE, immediately ABOVE the started check.
    //
    // THIS IS NOT A SECOND, DRIFTABLE GATE. Verified 2026-08-10: the tier is
    // ALREADY refused below, transitively — pot/started.ts:117 opens
    // getPotStarted with `if (!(await mugKettleSystemEnabled())) return false`,
    // so under retirement the next branch already refuses before any write.
    // Both readings resolve the SAME flag through the SAME function, so they
    // cannot disagree in the ALLOW direction: flag ON ⇒ this returns null AND
    // getPotStarted reads the real row. They are strictly nested, not parallel,
    // which is what makes this safe where a genuinely independent second gate
    // would not be.
    //
    // WHAT IT FIXES is the DIAGNOSIS, and that was a real defect: the
    // `hive_paused` refusal below tells the caller "pot:start resumes autonomous
    // wakes" — but pot:start is gated by D-017 and refuses too, so a retired
    // tier sent the caller to a dead route with no mention of the flag. The
    // gate helper's own contract is a LOUD refusal the caller can act on
    // "without reading this plan"; `hive_paused` failed that. Ordering matters:
    // pause and retirement are different states and must not report as one.
    const retired = await refuseIfMugKettleRetired(
      "declare the Mug's next wake",
      'The Mug loop no longer wakes. Use an su session and loop:arm / loop:checkpoint for the engine loop.',
    );
    if (retired) return retired;

    // WI-2012 (owner directive 2026-07-03): no started hives ⇒ the mug STAYS paused.
    // pot:pause clears the pending time wake, but an IN-FLIGHT mug turn used to
    // re-arm it right back through this tool — the self-perpetuating wake loop that
    // kept a "paused" mug burning orient/survey churn for hours. When the mug
    // loop is not started, refuse to arm anything; pot:start is the resume (it sets
    // started=true BEFORE arming, so this gate can never strand resumption).
    if (!(await getPotStarted(workspaceId, installSlug))) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'hive_paused',
              message:
                'The pot wake loop is PAUSED (hive_started=false) — not arming a wake. End your turn cleanly; pot:start resumes autonomous wakes.',
            }),
          },
        ],
      };
    }

    const wantsTime = args.at != null || args.inSeconds != null;

    // EI-309 frontier guard + P-030 drive-to-empty: refuse a no-time-component wake
    // (event-only / none) while the Mug still has work a no-time wake would
    // strand — unplaced todo work in the home harness, OR non-terminal placements
    // she must drive to completion. Runs BEFORE any mutation so a refused
    // declaration doesn't partially apply. Flag-gated; force overrides.
    if (!wantsTime && !args.force && (await getFlag(FLAGS.POT_WAKE_FRONTIER_GUARD, 'system'))) {
      // mug-steering-panel B-03: when the owner has PAUSED new work (owner-steering
      // C-1), the Mug is legitimately leaving the unplaced frontier alone — suppress
      // the frontier leg so she can declare an idle/event-only wake. The drive-to-
      // terminal leg (openPlacements) STILL applies: she must keep a cadence to finish
      // in-flight work. Fail-soft: an unreadable steering store ⇒ the full guard.
      const paused = await getOwnerSteering(workspaceId, installSlug, sql)
        .then((s) => isPausedNow(s, Date.now()))
        .catch(() => false);
      const [frontierIdsRaw, openPlacementIds] = await Promise.all([
        listUnplacedPotFrontier(sql, workspaceId, installSlug),
        listNonTerminalPlacements(sql, workspaceId, installSlug),
      ]);
      const frontierIds = paused ? [] : frontierIdsRaw;
      const refusal = evaluateWakeFrontierGuard({ hasTimeWake: false, frontierIds, openPlacementIds });
      if (refusal) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...refusal }) }],
        };
      }
    }

    let time: { at: string; clamped: boolean } | null = null;
    if (wantsTime) {
      const requested = args.at != null ? new Date(args.at) : new Date(Date.now() + (args.inSeconds as number) * 1_000);
      const r = await declarePotTimeWake(sql, { workspaceId, installSlug, at: requested, kickoff: clampText(args.kickoff, LIMITS.ANNOTATION) });
      time = { at: r.at.toISOString(), clamped: r.clamped };
    } else {
      // K1 (workspace-scoped-coordination P-003): thread the workspace so a clear
      // targets the papercup wake routine when the flag is ON (OFF ⇒ per-pot).
      await clearPotTimeWake(sql, installSlug, { workspaceId });
    }

    const declared: PotEventSubscription[] = (args.events ?? []).map((s) => ({
      on: s.on,
      when: s.when as DataCondition | undefined,
      note: clampText(s.note, LIMITS.ANNOTATION),
    }));
    // EI-10525 — always-armed demand-wake invariant. This tool has REPLACE
    // semantics, so a TIME-ONLY (or mode:'none') re-declaration carries no `events`
    // and USED to persist [], silently wiping the three default demand
    // subscriptions (plans:start / work_items:create / coord:escalate). The Mug was
    // then left with a time wake only — a new unplaced work item or escalation no
    // longer woke her, and the watchdog didn't flag it because "a wake is armed"
    // (time-only) satisfied the liveness check. Union the defaults onto whatever she
    // declared before persisting: her declared events REPLACE her own custom set
    // (re-tunable, exactly as pot:start's ENSURE mode preserves her tuning), but the
    // demand defaults always survive while the pot is started.
    // EI-13608: fold the owner's create-wake plan-suppression list (if any) into
    // the built-in defaults before ensuring them onto her declared set — fail-soft
    // (readCreateWakeSuppressPlans never throws), so an unreadable steering store
    // just means no suppression, same as before this option existed.
    const suppressCreateWakePlans = await readCreateWakeSuppressPlans(workspaceId, installSlug);
    const subs = withDefaultPotWakeSubscriptions(
      declared,
      defaultPotEventSubscriptions({ suppressCreateWakePlans }),
    );
    const eventRules = await setPotEventSubscriptions(workspaceId, subs);
    const defaultsEnsured = subs.length - declared.length;

    // Carry-note (P-015 / B-04): REPLACE-semantics — store the note for the next
    // wake's brief tail, or clear it when omitted (re-derive from the floor).
    const carryNote = await setPotCarryNote(workspaceId, args.remember);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            time,
            eventRules,
            // How many default demand subs were auto-added to preserve the always-armed
            // invariant (EI-10525) — distinguishes what the Mug declared from what was
            // ensured beneath her declaration.
            defaultsEnsured,
            carryNote: carryNote ? { set: true, chars: carryNote.length } : { set: false },
            floorSec: potWakeFloorSec(),
            mode: time && eventRules > 0 ? 'time+event' : time ? 'time' : eventRules > 0 ? 'event' : 'none',
          }),
        },
      ],
    };
  },
});
