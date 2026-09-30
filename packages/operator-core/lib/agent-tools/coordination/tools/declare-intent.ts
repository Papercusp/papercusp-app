/**
 * coord:declare-intent — set what this agent is currently working on.
 *
 * Upserts the caller's liveness row in harness_shared.coord_presence
 * and bumps its heartbeat. This is the explicit-declaration path; the
 * OMP hook also writes presence automatically on session_start /
 * turn_start. agent-coordination-architecture-v2 §4.2 / §4.3.
 *
 * Semantics: this declares the caller's *whole* current work state — an
 * omitted `current_plan_slug` resets to empty, so pass it if it should
 * persist.
 *
 * `current_files` is the EXCEPTION, alongside `items` (EI-18776963284535761):
 * omitting it leaves the declared file set UNTOUCHED; an explicit `[]` clears
 * it. It used to reset like current_plan_slug, which made it permanently empty
 * in practice — `coord:orient`, the mandated every-wake bootstrap, re-declares
 * intent without the arg, so every agent wiped its own file set on every wake
 * (measured: 113 live presence rows, 0 populated) and every downstream
 * collision-avoidance consumer read a dead signal. `current_plan_slug` was
 * deliberately NOT changed with it: it is genuinely populated (37/113 live rows
 * at the time of the fix), and preserving it would strand a stale plan
 * association on an agent that has moved off the plan.
 *
 * `items` (claim-discipline-enforcement-2026-06-10): the declared LANE.
 * When passed with `current_plan_slug`, each P-NNN is auto-claimed
 * (plan_item_claims lease) and the caller's other claims in that plan
 * are released — one call = presence + structured claims, replacing the
 * prose-lane pattern ("X holds P-001..P-005") that nothing could read.
 * An explicit empty `items` array is also valid without a plan slug: it
 * declares the caller's new presence state without claiming or releasing a
 * plan lane. This is the replacement-member re-declaration path; there is no
 * plan scope to reconcile when the member has no current plan.
 * Omitting `items` leaves existing claims untouched (so a bare
 * re-declare never drops a lane claimed via plans:set-status wip).
 *
 * Lane ids are validated against the plan's parsed items (EI-356) so the
 * claim surface agrees with plans:items / plans:set-status — see the
 * handler comment for the unknown-id semantics.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { resolveActorIdentity, actorMailboxKeys } from '../actor-identity';
import { drainAndDeliverUserMailbox } from '../messages';
import { writePresence, getPresence } from '../presence';
import { fetchPresenceFleet, type FleetMembership } from '../presence-fleet';
import { COORD_ROLES } from '../roles';
import { resolvePlanScope, getPlanRow, planItemsForRow } from '../../plans/source';
import { ctxToPlanSourceOpts } from '../../plans/_ctx-opts';
import { reconcileDeclaredClaims } from '../../../plan-items/claim-discipline';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../../plan-items/agent-names';
import { convertPlanItem } from '../../../plan-items/convert';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { withBoundedTimeout } from '../../../bounded-timeout';
import { cellTranscriptionHint } from '../../../cell-transcription-detector';
import { goalRefSchema } from '../../../agent-goal-ref';

/**
 * EI-9484 — "coord:declare-intent timing out repeatedly": the watchdog observed
 * the tool exceed the 60s MCP tool timeout on ~2% of calls under fleet load
 * ("handler returned but signal had aborted"). The declaration itself is one
 * upsert (`writePresence`), but the handler then AWAITS several best-effort
 * ENRICHMENT legs in the critical request path:
 *   • the `@user:` mailbox drain — a drain query + a SERIAL `appendLine` loop
 *     whose cost scales with the returning member's parked-message count,
 *   • the `getPresence` re-read and `fetchPresenceFleet` label lookup that only
 *     shape the RETURN payload.
 * Under event-loop / DB-pool saturation any one of these can stall, and because
 * they are un-bounded they hold the whole call past the 60s timeout even though
 * the essential presence write already succeeded. Bounding each enrichment leg
 * (the WI-3818 `withBoundedTimeout` pattern already used in coord:orient /
 * fleet:status) caps the blast radius of a slow leg to its own budget: the
 * declaration still lands, the enrichment degrades to a fallback. The mailbox
 * drain is claim-once, so a skipped drain is simply redelivered on the next
 * declare-intent / inbox read — degrading it changes nothing.
 */
const DECLARE_INTENT_LEG_TIMEOUT_MS = 8_000;

/**
 * EI-5873 — "broad AUTO directives cause fleet over-coverage": observed twice
 * in one session, multiple fleet members each independently declared
 * "working ALL remaining items" in free-text `intent` (no structured `items`)
 * and raced for the same set. The structural claim path (`items` + P-NNN)
 * already prevents a double-EDIT via `reconcileDeclaredClaims`'s conflict
 * check — the gap is double-INTENT: a broad prose declaration that never
 * enumerates items bypasses that check entirely, so two agents can each
 * believe they own "everything" with no structural signal either sees.
 *
 * This is a CHEAP, PURELY-ADVISORY nudge (never blocks or alters behavior):
 * when `intent` reads like a broad "take everything remaining" scope AND no
 * structured `items` were declared alongside it, surface a hint recommending
 * the caller enumerate its lane instead — so the next declare-intent naturally
 * produces the conflict signal this class of collision needs. False positives
 * cost nothing (the caller still declared successfully); false negatives just
 * mean the pattern wasn't broad-sounding enough to catch, same as today.
 */
const BROAD_INTENT_RE =
  /\ball\b[\s\S]{0,40}\b(remaining|items?|work|todos?|the\s+backlog|left)\b|\beverything\b|\bwhatever'?s?\s+left\b/i;

function broadIntentHint(intent: string, hasStructuredItems: boolean): string | null {
  if (hasStructuredItems) return null;
  if (!BROAD_INTENT_RE.test(intent)) return null;
  return (
    'EI-5873: this reads like a broad "take everything remaining" intent with no structured `items` — ' +
    'a peer declaring the same broad scope has no structural signal to see the overlap (the claim check ' +
    'only runs on declared `items`). If this work has enumerable plan items (P-NNN) or work-items, pass ' +
    'them as `items` (or claim the specific ones via work_items:claim / scheduler:get_next) so a colliding ' +
    'peer sees a real conflict instead of both of you discovering it after the fact.'
  );
}

/**
 * EI-22662451852499659: has THIS process completed one intent-pivot embed?
 * Until it has, the pivot leg answers lexically and warms the embedder in the
 * background instead of racing a cold in-process model load against
 * PIVOT_EMBED_BUDGET_MS (measured: the deadline fired on every cold installed
 * run and vitest-fail-on-console turned the warning into a red).
 */
let pivotEmbedWarm = false;
/** Test seam only. */
export function __resetPivotEmbedWarmForTest(): void {
  pivotEmbedWarm = false;
}

export default defineTool({
  name: 'coord:declare-intent',
  description:
    'Declare current work: one-line intent, optional plan slug, P-NNN lane (auto-claimed), files, optional typed goal refs, and optional ambient-retrieval exclusions. `items` accepts plan ids in P-NNN form only; scheduler:get_next claims WI-/EI- work-items and declares their intent automatically, so do not pass those ids here. A non-empty `items` lane requires a plan slug; an explicit empty `items: []` may be used without one for a replacement-member presence re-declaration and does not touch plan claims. Peers see this via coord:presence / fleet:assignments. Omitted fields reset state except `items`, `current_files`, and `ambient_excluded_refs` (omission preserves; [] clears). A broad "all remaining items" intent without structured `items` returns advisory `overCoverageHint` (EI-5873).',
  guidance: {
    when: 'Starting distinct work so peers see it. For a plan lane, pass P-NNN ids as `items` to claim it structurally. For multi-goal coverage, pass resolvable refs as `declared_goal_refs`. scheduler:get_next already declares claimed WI-/EI- intent; do not pass that work-item id as `items`. For broad "take everything remaining" work, enumerate items to expose overlap (EI-5873).',
    notWhen: 'Every turn — the OMP hook heartbeats automatically; call this when your intent changes.',
    chaining:
      'coord:declare-intent { intent, current_plan_slug, items: ["P-001"] } → work → plans:set-status done. Conflicts mean a peer holds the item; coordinate or re-lane. `claims.unknown` means an id was not claimed.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // EI-20226779878046151: declare-intent resolves its own presence/plan stores
  // and never reads ctx.tx. The orient bootstrap should not keep an ambient
  // org-app transaction open while this write's bounded side effects run.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    intent: z
      .string()
      .min(1)
      .describe('One line: what you are working on right now.'),
    current_plan_slug: z
      .string()
      .nullish()
      .describe('Plan slug this work belongs to, if any; null is treated like omission.'),
    // EI-21139039044360936: the caller passed a WI-/EI- work-item id and read back only
    // the shared `P-NNN form required` string, which names the FORM and not the route —
    // so the recovery was "retry without items", losing the lane declaration entirely.
    // The arg description has named scheduler:get_next since 2026-08-12 and the filing is
    // from 2026-08-22, so the description alone did not prevent it: the correction has to
    // be at the refusal. A regex message is not emitted into the JSON Schema, so this
    // costs no prompt weight — which is what makes it available at all here
    // (coord:declare-intent has 44 chars of headroom against the 1500 budget).
    items: z
      .array(
        z
          .string()
          .regex(
            /^P-\d{3,}$/,
            'P-NNN form required — `items` is the PLAN-item lane (P-001). A WI-/EI- work-item is ' +
              'claimed by scheduler:get_next, which declares its intent for you; do not pass one here. ' +
              'To declare an ad-hoc lane, omit `items` and name the work-item in `intent`.',
          ),
      )
      .max(40)
      .optional()
      .describe(
        'P-NNN plan items you are taking (your LANE) — each is auto-claimed; your other claims in this plan are released. A non-empty lane requires current_plan_slug. Pass [] with a plan to release your whole lane; pass [] without a plan for a replacement-member presence re-declaration that does not touch plan claims. Omit to leave claims untouched. WI-/EI- work-item ids belong to scheduler:get_next, not this field.',
      ),
    declared_goal_refs: z
      .array(goalRefSchema)
      .min(1)
      .max(40)
      .optional()
      .describe(
        'Optional typed goal refs explicitly covered by this declaration — generated goal slugs and WI-/EI- work-item refs are accepted; blank and bare numeric refs are rejected. Omit when no multi-goal declaration is intended; prose is never inferred.',
      ),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Harness the plan lives in, for the item claims (default: session harness, or operator home if unscoped).'),
    current_files: z
      .array(z.string())
      .optional()
      .describe(
        'Repo-relative files currently in scope — read by lock-contention enrichment (is the holder still focused on this path?) and by fleet placement. Omit to leave your declared file set untouched; pass [] to clear it. Same omission semantics as `items`.',
      ),
    ambient_excluded_refs: z
      .array(z.string())
      .optional()
      .describe(
        'Work-item/session refs that ambient corpus retrieval must never inject into this session. Omit to preserve the durable fence; pass [] to clear it. A read failure fails closed for corpus retrieval.',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const declaredPlanSlug = args.current_plan_slug?.trim() || null;
    let declaredPlanScope: Awaited<ReturnType<typeof resolvePlanScope>> | null = null;
    let declaredPlanRow: Awaited<ReturnType<typeof getPlanRow>> | null = null;

    // EI-22589724741483734: validate a declared plan BEFORE writePresence. A
    // missing slug otherwise lands in coord_presence.current_plan_slug, and
    // the next MCP request refuses its own harness scope as stale before the
    // caller can issue the documented self-clear declaration.
    if (declaredPlanSlug) {
      try {
        const planOpts = args.harness
          ? { harnessSlug: args.harness }
          : await ctxToPlanSourceOpts(ctx);
        declaredPlanScope = await resolvePlanScope(planOpts);
        declaredPlanRow = await getPlanRow(declaredPlanSlug, planOpts);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `current_plan_slug '${declaredPlanSlug}' could not be validated: ${detail}`,
              }),
            },
          ],
          isError: true,
        };
      }
      if (!declaredPlanRow) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `current_plan_slug '${declaredPlanSlug}' was not found in ${declaredPlanScope!.harnessSlug}; no presence or lane claim was written.`,
              }),
            },
          ],
          isError: true,
        };
      }
    }

    // An empty lane is meaningful even when this member has no plan scope: it
    // is the replacement-member re-declaration path. Non-empty P-NNN lanes
    // still require an explicit plan so claim reconciliation cannot silently
    // target an unknown scope.
    if (args.items && args.items.length > 0 && !declaredPlanSlug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'items requires current_plan_slug — the lane is claimed within one plan',
            }),
          },
        ],
        isError: true,
      };
    }
    // P-015 pivot detection needs the PREVIOUS intent. The presence upsert
    // returns that pre-image from the same SQL statement (EI-23110847647700079),
    // removing the former standalone getPresence + 1500ms warning-producing
    // deadline from the request path.
    const prevIntent = await writePresence(
      identity,
      {
        intent: args.intent,
        currentPlanSlug: declaredPlanSlug,
        // EI-18776963284535761: pass THROUGH (no `?? []`). `undefined` is the store's
        // "leave untouched" sentinel; `?? []` turned every omission into a CLEAR, and
        // coord:orient re-declares intent WITHOUT this arg on every wake — so the
        // column was empty for 113/113 live agents.
        currentFiles: args.current_files,
        // Omit to preserve the durable session fence; [] is an explicit clear.
        ambientExcludedRefs: args.ambient_excluded_refs,
      },
      // harness the work is in → resolves the agent's home hive_slug (D-004).
      args.harness ?? null,
    );

    // Offline-member mailbox (shared-hive-collaboration P-016): declaring intent is
    // the explicit ARRIVAL signal (the OMP hook calls it at session start), so a
    // returning member's parked `@user:` assignments are delivered into their inbox
    // here — surfacing in their [coord+N] injection right away. claim-once makes
    // this a safe no-op alongside the coord:inbox-read hook. Best-effort.
    //
    // EI-9484: BOUNDED — this drains a `@user:` mailbox via a SERIAL `appendLine`
    // loop whose cost scales with the parked-message count, so a large mailbox
    // (or DB-pool starvation under fleet load) could stall it past the 60s MCP
    // tool timeout and abort the whole call. Bounded so a slow drain degrades to
    // a no-op instead; claim-once means the un-drained batch is redelivered on
    // the next declare-intent / inbox read. withBoundedTimeout never throws.
    await withBoundedTimeout<void>(
      resolveActorIdentity(ctx).then(async (actor) => {
        await drainAndDeliverUserMailbox(actorMailboxKeys(actor), actor.ownerId);
      }),
      { fallback: undefined, timeoutMs: DECLARE_INTENT_LEG_TIMEOUT_MS, label: 'declare-intent:mailbox-drain' },
    );

    // Reconcile the declared lane → claims (claim-discipline). Per-item
    // conflicts are reported, never thrown: declaring intent must succeed even
    // when part of the lane is contested.
    //
    // EI-356: the lane is validated against the SAME parsed-item set that
    // plans:items / plans:set-status see (planItemsForRow) — an id those
    // surfaces reject with item_not_found is never claimed here either.
    // Unknown ids come back in `claims.unknown` with `hint`; a lane that is
    // ENTIRELY unknown (or a missing plan) skips reconcile so a typo'd
    // declaration can't release the caller's real claims. An explicit `[]`
    // still releases the whole lane.
    let claims = null;
    if (args.items && declaredPlanSlug) {
      // The plan was resolved and validated before writePresence above. Reuse
      // that exact row/scope so the claim path cannot validate a different
      // snapshot from the one that authorized the presence write.
      const scope = declaredPlanScope!;
      const row = declaredPlanRow!;
      const knownIds = row ? new Set(planItemsForRow(row).map((i) => i.id)) : new Set<string>();
      const known = args.items.filter((i) => knownIds.has(i));
      const unknown = args.items.filter((i) => !knownIds.has(i));
      if (args.items.length > 0 && known.length === 0) {
        claims = {
          claimed: [],
          alreadyHeld: [],
          conflicts: [],
          released: [],
          unknown,
          hint: row
            ? 'none of the declared items parse as items of this plan (plans:items would not list them — legacy/checkbox lines are invisible); nothing was claimed or released. Fix the plan format (plans:lint) or declare real P-NNN ids.'
            : `plan '${declaredPlanSlug}' not found in ${scope.harnessSlug} — nothing was claimed or released. Check the slug (plans:list) or pass the right harness.`,
        };
      } else {
        const ownerName = await resolveAdoptedName(scope.workspaceId, identity.ownerId).catch(() => null);
        const reconciled = await reconcileDeclaredClaims({
          workspaceId: scope.workspaceId,
          harnessSlug: scope.harnessSlug,
          planSlug: declaredPlanSlug,
          items: known,
          owner: identity.ownerId,
          ownerLabel: identity.ownerLabel,
          ownerName,
          ownerUser: bestEffortOwnerUser(ctx),
          intent: args.intent,
        });

        // work-queue-completeness Phase A (ENFORCEMENT): when the auto-convert flag is ON,
        // each item the caller now HOLDS (just-claimed or already-held) gets a tracked
        // work_item via convertPlanItem — so an auto-claimed declare-intent lane never
        // leaves untracked work. Idempotent (resumes an existing record), so re-declaring
        // is a harmless no-op. BEST-EFFORT: wrapped per-item AND as a whole so a convert
        // failure (or a flag-IO error) NEVER breaks declare-intent — the lane stays
        // claimed regardless. Fail-safe to OFF on a flag-read error.
        const autoConvert = await getFlag(FLAGS.PLAN_ITEM_CLAIM_AUTO_CONVERT, 'system').catch(() => false);
        if (autoConvert) {
          const held = [...reconciled.claimed, ...reconciled.alreadyHeld];
          for (const itemId of held) {
            await convertPlanItem({
              workspaceId: scope.workspaceId,
              harnessSlug: scope.harnessSlug,
              planSlug: declaredPlanSlug,
              itemId,
              owner: identity.ownerId,
              ownerLabel: identity.ownerLabel,
              ownerName,
              ownerUser: bestEffortOwnerUser(ctx),
              intent: args.intent,
            }).catch((e) =>
              console.warn(
                `[coord:declare-intent] auto-convert ${declaredPlanSlug}#${itemId} failed:`,
                (e as Error)?.message ?? e,
              ),
            );
          }
        }

        claims =
          unknown.length > 0
            ? {
                ...reconciled,
                unknown,
                hint: 'unknown items do not parse as items of this plan (plans:set-status would return item_not_found) and were not claimed — fix the plan format or the ids.',
              }
            : reconciled;
      }
    }

    // EI-9484: these two reads only shape the RETURN payload (the declaration
    // already landed via writePresence). Bound each so a slow read under load
    // degrades the echoed-back presence/fleet label instead of holding the whole
    // call past the 60s MCP tool timeout.
    const record = (
      await withBoundedTimeout(getPresence(identity.ownerId), {
        fallback: null,
        timeoutMs: DECLARE_INTENT_LEG_TIMEOUT_MS,
        label: 'declare-intent:getPresence',
      })
    ).value;
    // Surface the agent's named-fleet membership (P-005) alongside its presence row —
    // fleet_slug/fleet_role are a SOFT coord_presence label that does NOT ride the base
    // PresenceRecord, so join the STORED value (reflects a leader role a handoff may have
    // promoted this row to, not just the launch env). Absent ⇒ no fleet.
    const fleet = record
      ? (
          await withBoundedTimeout(fetchPresenceFleet([identity.ownerId]), {
            fallback: new Map<string, FleetMembership>(),
            timeoutMs: DECLARE_INTENT_LEG_TIMEOUT_MS,
            label: 'declare-intent:fetchPresenceFleet',
          })
        ).value.get(identity.ownerId)
      : undefined;
    const presence = record
      ? { ...record, fleetSlug: fleet?.fleetSlug ?? null, fleetRole: fleet?.fleetRole ?? null }
      : record;
    const overCoverageHint = broadIntentHint(args.intent, !!(args.items && args.items.length > 0));
    // P-017 (c) / D-016 / D-047 row 4: "this value has a cell, read it". A declared
    // intent that TRANSCRIBES a cell-backed value (a deployed sha, a behind-count) is
    // stating something that was true when it was copied and rots silently afterwards
    // — and peers read intents to decide what to do. DETECTOR, never a gate: this is a
    // string on the result, the declare always succeeds, and a deliberate historical
    // quote is legitimate. Pure + total (never throws), so it needs no timeout budget
    // like the pivot leg below.
    const cellHint = cellTranscriptionHint(args.intent);
    // P-015: mechanical pivot detection between consecutive intents (plan D-006
    // — extractive embedding use only; deterministic lexical fallback). A sharp
    // pivot usually means the previous approach dead-ended — the nudge points
    // at the typed slot (facts:assert { slot: 'dead-end' }). Advisory only;
    // bounded so the leg can never hold the declare past its budget.
    const pivot = (
      await withBoundedTimeout(
        (async () => {
          if (!prevIntent) return null;
          const { detectIntentPivot } = await import('../../../intent-pivot');
          // Lazy embedder: resolved only if the comparison actually runs (the
          // short/identical-intent short-circuits never pay for it). An
          // unresolvable/disabled embedder throws → lexical fallback inside.
          const embed = async (text: string): Promise<number[]> => {
            const { resolveBackfillEmbedder } = await import('../../../search/embed-backfill');
            const resolved = await resolveBackfillEmbedder();
            if (resolved.mode === 'disabled') throw new Error('embedder disabled');
            return resolved.embed(text);
          };
          // EI-22662451852499659: on a COLD process the lazy embed pays an
          // in-process model load per text, so the 1500ms pivot deadline fires
          // on every first call and logs a [bounded-timeout] warning that
          // fail-on-console turns into a test failure. When local embed
          // acquisition is not cheap (no ready sidecar), skip the embedding
          // race entirely — lexical is the documented fallback and needs no
          // deadline — rather than racing a load we know will lose.
          // Two gates, both required before the embedding race is offered:
          //  (1) acquisition is cheap (a sidecar URL resolves, or no sidecar is
          //      configured, or this process's sidecar finished its handshake);
          //  (2) this PROCESS has already completed one embed — the in-process
          //      fallback's model load is deferred to the first embed(text)
          //      call, which is exactly the cold cost that overran the deadline.
          // The first eligible call warms the embedder in the BACKGROUND (its
          // result is discarded) and answers lexically; every later call in the
          // same process races the warm embedder within budget.
          const { isLocalEmbedAcquisitionCheap } = await import('../../../memory/embed-sidecar-wiring');
          if (!isLocalEmbedAcquisitionCheap()) return detectIntentPivot(prevIntent, args.intent, {});
          if (!pivotEmbedWarm) {
            void embed(args.intent)
              .then(() => {
                pivotEmbedWarm = true;
              })
              .catch(() => {});
            return detectIntentPivot(prevIntent, args.intent, {});
          }
          return detectIntentPivot(prevIntent, args.intent, { embed });
        })(),
        { fallback: null, timeoutMs: 2_500, label: 'declare-intent:pivot' },
      )
    ).value;
    const pivotField =
      pivot?.pivot === true
        ? { pivotHint: (await import('../../../intent-pivot')).pivotHint(pivot) }
        : undefined;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            presence,
            ...(claims ? { claims } : {}),
            ...(overCoverageHint ? { overCoverageHint } : {}),
            ...(cellHint ? { cellHint } : {}),
            ...(pivotField ?? {}),
          }),
        },
      ],
    };
  },
});
