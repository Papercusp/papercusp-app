/**
 * events:await — register a one-shot WAKE subscription on an event key
 * (await-event-primitive-2026-06-05 P-003, D-002/D-003).
 *
 * "I am blocked on this; re-invoke me when it fires." The caller's session
 * wake-handle (adv_sessions row via the coord SID, or an explicit plan-run id)
 * is stamped onto the subscription NOW — it cannot be fetched at fire time
 * because the agent is asleep. One-shot by construction: it fires once and
 * clears, so an await can never wake-loop.
 */

import { z } from 'zod';
import { dataConditionSchema } from '@papercusp/rules';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { resolveAgentIdentity } from '../coordination/identity';
import { getMessageById } from '../coordination/messages';
import { readGateRefs } from '../coordination/ref-hydrate';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import {
  familyAdmitsKey,
  keyMatchesCatalog,
  mergeInstalledEventCatalog,
  findRequiredParamPrefixMatch,
  findZeroParamSuffixMismatch,
  findCatalogNearMiss,
  type EventCatalogEntry,
} from '../../events/await/catalog';
import { readInstalledUnitEvents } from '../../events/await/installed-events';
import {
  registerAwait,
  hasLiveExactAwaitForSubscriberKey,
  findAnnouncementsForKey,
  findNearMissKeys,
  cancelAwait,
  cancelAwaitsForSubscribersOnKeys,
  FLEET_BENCH_NOTE_PREFIX,
  probeKeyFireEvidence,
  probePatternMatchScope,
  type AwaitGenerationState,
  type KeyFireEvidence,
} from '../../events/await/store';
import { registerComposedAwait } from '../../events/await/compose';
import { ComposedSpecError, type ComposedSpec } from '../../events/await/compose-spec';
import { withBoundedTimeout } from '../../bounded-timeout';
import { startAwaitSweeper } from '../../events/await/engine';
import { isPattern, expandPatternMacro, assertUsablePattern, payloadMatchesFilter } from '../../events/await/pattern';
import {
  liveBlockedState,
  liveSettledProbe,
  liveAssigneeProbe,
  liveWorkItemClaimableEventPayload,
  type LiveBlockedStateProbe,
} from '../../work-items-events';
import { planItemEffectiveStatus } from '../../plan-items/assignments';
import { hardText, softText, clampText, LIMITS } from '../limits';
import { extendOwnerClaimsForAwait } from '../../plan-items/claims';
import { resolvePlanScope } from '../plans/source';
import {
  currentPipelineName,
  isMultiPipelineGateKey,
  isMultiPipelineGateKeyPattern,
} from '../../release/pipeline-name';
import { getClaimSpecRecord, type ClaimSpecRecord } from '../../scheduler/claim-spec-store';
import { claimSpecReferencesField, formatSpecRef } from '../../scheduler/claim-spec';
import { resolveClaimSpecWorkspace } from '../../scheduler/claim-spec-workspace';
import { claimSpecFilterToClaimablePayloadFilter } from '../../scheduler/claim-spec-payload-filter';
import { readIssueClaimability } from '../../scheduler/get-next';
import {
  producerHealthInputSchema,
  progressLeaseInputSchema,
  resolveProducerHealthCertificate,
  resolveProgressLeaseCertificate,
} from './producer-health';
import { resolveAnnouncementOwnership, type AnnouncementOwnership } from './status';
import {
  buildServiceUpEdgeAdvice,
  isFlapDamped,
  parseServiceUpKey,
  probeServiceUpLatch,
} from './service-up-edge';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  hasActiveMonitorForOwnerPredicate,
  monitorPredicateDedupRefusal,
  normalizeMonitorPredicateKey,
} from '../../harness/routines/monitor-policy';
import { acquireWithContentionRetry } from '../locks/contention-retry';

// The fallback timeout-wake window + hard cap — one shared source of truth
// (await-timeout-fallback-defaults-2026-07-03): the default is now 30min, not 4h.
// Aliased to the local names so every usage/describe below is unchanged.
import { AWAIT_DEFAULT_TIMEOUT_SEC as DEFAULT_TIMEOUT_SEC, AWAIT_MAX_TIMEOUT_SEC as MAX_TIMEOUT_SEC } from '../../events/await/types';
import type { AwaitRow } from '../../events/await/types';
import { projectAwaitWaitOperationalBrief } from '../../operational-brief/wait-brief';
import { acceptancePlaneAdvisoryForWait, mainWaitPlanReviewForWait } from '../../acceptance-runtime-wait-guard';

type GenerationPinDetails = {
  eventKey: string;
  expectedGeneration: number;
  currentGeneration: number | null;
  currentState: AwaitGenerationState;
  firedAt?: string | null;
};

function announcementGenerationState(row: {
  firedAt?: string | null;
  firedReason?: string | null;
  cancelledAt?: string | null;
  supersededAt?: string | null;
} | null): AwaitGenerationState {
  if (!row) return 'undeclared';
  if (row.firedAt) return row.firedReason === 'expired' ? 'expired' : 'fired';
  if (row.cancelledAt) return 'cancelled';
  if (row.supersededAt) return 'superseded';
  return 'declared';
}

function generationResyncReason(details: GenerationPinDetails): string {
  if (details.currentGeneration == null) return 'no_current_declaration';
  if (details.expectedGeneration < details.currentGeneration) return 'consumer_behind';
  if (details.expectedGeneration > details.currentGeneration) return 'consumer_ahead';
  return 'current_not_waitable';
}

function generationMismatchResponse(details: GenerationPinDetails) {
  const hasRetryableDeclaration = details.currentGeneration != null && details.currentState === 'declared';
  const nextStatus = !hasRetryableDeclaration
    ? `events:status { event: "${details.eventKey}" }`
    : `events:status { event: "${details.eventKey}", after_generation: ${details.currentGeneration} }`;
  const advice = hasRetryableDeclaration
    ? `The exact declaration for "${details.eventKey}" changed before this await could be registered. Re-read it with ${nextStatus}, then retry events:await using the returned current generation.`
    : `The exact declaration for "${details.eventKey}" is ${details.currentState} and is not waitable. Re-read it with ${nextStatus}, then wait for a fresh declared generation before retrying events:await.`;
  return {
    ok: false,
    error: 'await_generation_mismatch',
    event: details.eventKey,
    expected_generation: details.expectedGeneration,
    current_generation: details.currentGeneration,
    current_state: details.currentState,
    ...(details.firedAt ? { fired_at: details.firedAt } : {}),
    resync: {
      required: true,
      reason: generationResyncReason(details),
      consumer_generation: details.expectedGeneration,
      authoritative_generation: details.currentGeneration,
      rule: 'Replace the cached exact-key declaration with events:status before retrying events:await; never register against a generation that is no longer current and unfired.',
      next_verb: nextStatus,
    },
    advice,
  };
}

function isAwaitGenerationMismatchError(error: unknown): error is GenerationPinDetails & { code: 'await_generation_mismatch' } {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'await_generation_mismatch';
}

export default defineTool({
  name: 'events:await',
  description:
    'Register a one-shot WAKE on an event key/pattern; when it fires you are re-invoked, so end your turn instead of polling. Patterns wake on their first match; `spec` threshold trees wake when satisfied.',
  guidance: {
    when: 'You are blocked on a known event key: lock grant, plan run, peer answer, deploy/gate, or another emitter (patterns/macros cover families; see `event`). For `work-item:status:<id>` / `work-item:done:<id>` / `claim:released:<id>`, the id must belong to a DIFFERENT assignee: awaiting your own item is an unsatisfiable self-deadlock and is refused before registration. Pair key? Its completion OWNER must declare it (`events:emit { announce:true }`); await the RETURNED key, never a hand-typed chat key. `work-item:unblocked:<id>` is emitted only when the last live `blocks` edge clears: registration returns `already_unblocked` when already clear and refuses lifecycle-blocked items with no blocker edge because that exact key cannot fire.',
    notWhen:
      'Ambient interest (use watch:create { targetKind:"topic", wake:false }), sub-minute waits inside one turn, or recurring schedules. Prefer sugar verbs for common waits: deploy:await, checkpoint:await, work-item:await, service:await-up, git-sync:await, plan-item:await, fleet:await-drained.',
    chaining: 'Recipe: `events:catalog` → `events:await { event }` (or sugar) → END YOUR TURN → wake carries payload → re-register for the NEXT occurrence (one-shot: a fired await is gone). Re-awaiting the same key retires your prior wait; `events:cancel` retracts, `events:status` inspects.',
    // EI-21240881678776697: callers reach this tool holding a `policy` axis borrowed from
    // another verb (the filed repro passed `policy: 'qualification'`). events:await has no
    // policy axis at all — it is ALWAYS a one-shot wake — so the near-name guess a bare
    // rejection produces is worse than useless: there is no declared key it could mean.
    // The wake-vs-inject choice the caller is actually reaching for belongs to watch:create,
    // which `notWhen` already names in prose — prose read at BROWSE time, never at the
    // moment of failure. An authored redirect outranks and suppresses the guess
    // (invalidInputCorrections) and reaches the caller exactly when they got it wrong.
    // Zero prompt weight: argRedirects is excluded from the projected tool text and is paid
    // only on the failure path, so this costs nothing against the tool-weight budget.
    argRedirects: {
      policy: {
        tool: 'watch:create',
        args: { pattern: '<topic-slug>', targetKind: 'topic', wake: false },
        note: 'events:await has NO policy axis — every await is a one-shot WAKE that costs a turn. The wake-vs-inject choice is a different verb: watch:create { pattern, targetKind:"topic", wake:false } registers ambient interest that injects into your inbox cheaply instead of waking you. If you meant the DEADLINE behaviour rather than delivery, that is `on_timeout` ("wake" | "expire")',
      },
      // Retired delivery keys: events:await never took either, and both read as a delivery
      // switch, so they route to the verb that actually has one rather than to a near-name.
      wake: {
        tool: 'watch:create',
        args: { pattern: '<topic-slug>', targetKind: 'topic', wake: false },
        note: 'an await IS the wake — there is no `wake` toggle to pass. For the non-waking form (cheap inbox inject) use watch:create { pattern, wake:false }; for what happens at the DEADLINE use `on_timeout`',
      },
      once: {
        tool: 'events:await',
        args: { event: '<key>' },
        note: 'every events:await is ALREADY one-shot — a fired await is gone and must be re-registered for the next occurrence. There is no `once` key; drop it. For a STANDING (repeating) subscription use watch:create instead',
      },
      // Exact synonyms of a declared key: the terse string form renders "pass it as `X`
      // instead". This schema is snake_case while much of the catalog is camelCase, which
      // is a systematic near-miss rather than a one-off typo.
      afterGeneration: 'after_generation',
      timeoutSec: 'timeout_sec',
      onTimeout: 'on_timeout',
      payloadFilter: 'payload_filter',
      producerHealth: 'producer_health',
      planRunId: 'plan_run_id',
      progressLease: 'progress_lease',
    },
    seeAlso: [
      'events:catalog (what CAN I wait on? — the awaitable-key registry; check before polling)',
      'deploy:await / work-item:await / … (named sugar for the common waits — build the key for you)',
      'events:emit (the counterpart — fire the event a peer awaits)',
      'events:cancel (retract a pending await)',
      'watch:create (a standing watch instead of a one-shot await)',
      'EI-14225/EI-14793: re-awaiting the SAME exact key — or re-registering the SAME composed `spec` — auto-retires your own prior pending registration on it (see `superseded` in the response), so a repeated idle-park loop never has to call events:cancel first.',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    event: hardText(LIMITS.IDENT)
      .optional()
      .describe(
        'Event key to wait on (mutually exclusive with `spec`). An EXACT key (`lock:grant:t1`) matches that one key. A PATTERN — a glob with `*` (`work-item:done:*`), or a macro `@plan:<slug>` (→ any plan item done) / `@fleet:<slug>` (→ any fleet event) — wakes on the FIRST key that matches. `*` matches any run of characters.',
      ),
    after_generation: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Pin this await to the exact announced declaration generation returned by events:status; stale pins return a structured resync response.'),
    spec: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Composed THRESHOLD TREE (mutually exclusive with `event`): wake ONCE when a combination of event occurrences is satisfied. A leaf is { event, when? } (`when` = a payload_filter DataCondition on that event). Combinators: { all: [...] } = every child; { any: [...] } = ≥1 child; { some: { require: k, of: [...] } } = k-of-n. Nest ≤3 deep, ≤20 leaves total; event-level negation is not supported (absence is observed by the deadline). e.g. { any: [ { event: "deploy:done" }, { all: [ { event: "ci:green" }, { event: "review:approved" } ] } ] }. IMPORTANT: the root is whole-tree one-shot; an `any` match consumes and voids every sibling. Do not mix frequent/non-terminal events with rare/terminal events unless the first match is intentionally terminal; split those waits or use an explicit threshold that matches the lifecycle. Deadline via timeout_sec/on_timeout as usual; a tree already satisfied at registration returns already_satisfied WITHOUT registering.',
      ),
    note: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('Why you are waiting — echoed into the wake turn so resumed-you has the thread. Auto-truncated to 2000 chars if longer.'),
    timeout_sec: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_SEC)
      .optional()
      .describe(`Deadline in seconds (default ${DEFAULT_TIMEOUT_SEC}). See on_timeout.`),
    on_timeout: z
      .enum(['wake', 'expire'])
      .optional()
      .describe(
        "What happens at the deadline without the event: 'wake' (default) = you are woken with a TIMEOUT marker (the non-event is as actionable as the event); 'expire' = the await lapses silently (visible in events:status).",
      ),
    plan_run_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('When awaiting FROM a plan run, pass its runId — the wake re-invokes the run via the plans:resume path instead of a session resume.'),
    payload_filter: dataConditionSchema
      .optional()
      .describe(
        "EI-8998: also require the emitted PAYLOAD to satisfy this predicate before firing, e.g. { queue_depth: { lt: 5 } } — same vocabulary as an ECA rule's `when`. Only takes effect combined with an `event` key/pattern the emitter actually fires. Omitted on event:'work-item:claimable'? EI-13846: it is auto-narrowed to YOUR OWN claim spec when one exists (see auto_scoped_payload_filter in the response) — pass this explicitly to override.",
      ),
    producer_health: producerHealthInputSchema
      .optional()
      .describe('Verified producer health for a single event/fromMsg wait; requires `event` or `fromMsg` and is rejected with a composed `spec`.'),
    progress_lease: progressLeaseInputSchema
      .optional()
      .describe(
        'Evidence-backed liveness lease for a delegated upstream owner. Uses an authoritative read-only tool/path and automatically wakes owner_id on the first cadence miss. After repeated misses, remedy must use one of spec-widen, outside-lane-placement, leader-claim, or create-unblock-item; wake-owner is not a valid remedy kind.',
      ),
    fromMsg: hardText(LIMITS.IDENT)
      .optional()
      .describe(
        'coord-authority-hardening P-006: a coord msg_id — await the gate THAT message declared (its `gateRefs` stamps, read server-side). `fromMsg` resolves gateRefs only; it does not consume a coord:send `expectEffect` directive. ExpectEffect compliance is reported on fleet:leader-brief → members[].directiveActuation. Kills hand-typed key drift: you never re-type the key, the platform resolves it off the message. Exactly one gate on the message is required — none/many is a loud error naming what it found. Mutually exclusive with `event`/`spec`.',
      ),
  })
    .refine(
      (a) => [a.event, a.spec, a.fromMsg].filter((x) => x != null).length === 1,
      { message: 'pass exactly one of `event`, `spec`, or `fromMsg`' },
    )
    .refine(
      (a) => a.after_generation == null || (a.event != null && !isPattern(a.event)),
      { message: 'after_generation requires an exact `event` key (not a pattern, spec, or fromMsg)' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    startAwaitSweeper();
    if (args.producer_health && args.spec) {
      throw new Error('events:await — producer_health applies to one event/fromMsg wait, not a composed spec');
    }
    if (args.progress_lease && args.spec) {
      throw new Error('events:await — progress_lease applies to one event/fromMsg wait, not a composed spec');
    }
    if (args.producer_health && args.progress_lease) {
      throw new Error('events:await — pass producer_health or progress_lease, not both');
    }
    if (args.producer_health && args.on_timeout === 'expire') {
      throw new Error('events:await — producer_health requires on_timeout:"wake" so a stalled/absent diagnosis is actionable');
    }
    if (args.progress_lease && args.on_timeout === 'expire') {
      throw new Error('events:await — progress_lease requires on_timeout:"wake" so stale evidence and remedies remain actionable');
    }

    // EI-383: a REAL registered await ends the turn until the wake — no activity-
    // bus event fires again until then, so any plan-item claim the caller holds
    // would otherwise lapse mid-sleep on a long park. Extend it to survive the
    // sleep (capped at the existing MAX_TTL_SEC ceiling — see claims.ts). Called
    // only right before an ACTUAL registration succeeds (not on an early
    // already_satisfied/already_fired/already_done short-circuit, which never
    // sleeps at all). Best-effort: never let this block or fail the await itself.
    const extendClaimsForThisAwait = async (timeoutSec: number): Promise<void> => {
      try {
        const harnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
        const { workspaceId } = await resolvePlanScope({
          harnessSlug: typeof harnessRaw === 'string' ? harnessRaw : undefined,
        });
        await extendOwnerClaimsForAwait(workspaceId, identity.ownerId, timeoutSec);
      } catch {
        /* best-effort — a claim-extension failure must never block registering the await */
      }
    };

    // ── Composed threshold-tree await (composable-event-awaits-2026-07-11): a `spec`
    //    (mutually exclusive with `event`) registers an all/any/some TREE that wakes
    //    ONCE when its combination is satisfied. Leaves are ordinary awaits; only a ROOT
    //    trip queues a wake. A tree already satisfied at registration short-circuits to
    //    already_satisfied without persisting anything. Spec validation (caps, no-`not`,
    //    unusable-glob) throws ComposedSpecError → a caller-facing error, never a 500. ──
    if (args.spec != null) {
      const { handle, note: handleNote } = await captureWakeHandleForOwner(identity.ownerId, {
        planRunId: args.plan_run_id,
      });
      try {
        const res = await registerComposedAwait({
          subscriberId: identity.ownerId,
          spec: args.spec as unknown as ComposedSpec,
          wakeHandle: handle,
          note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
          timeoutSec: args.timeout_sec ?? null,
          timeoutBehavior: args.on_timeout ?? 'wake',
        });
        if (!res.registered) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  already_satisfied: true,
                  fired: res.fired,
                  advice:
                    'The composed condition is ALREADY satisfied — no await was registered. Proceed now with the work it was gating instead of waiting.',
                }),
              },
            ],
          };
        }
        await extendClaimsForThisAwait(args.timeout_sec ?? DEFAULT_TIMEOUT_SEC);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                composed: true,
                root_id: res.rootId,
                await_id: res.anchorAwaitId,
                leaf_count: res.leafCount,
                depth: res.depth,
                on_timeout: args.on_timeout ?? 'wake',
                wake_handle: handleNote,
                ...(res.superseded > 0
                  ? {
                      superseded: res.superseded,
                      superseded_advice: `Retired ${res.superseded} of your own prior pending composed tree(s) on this identical spec — one-shot semantics mean only the NEWEST registration stays live, so an earlier tree can no longer fire a duplicate wake for the same underlying event.`,
                    }
                  : {}),
                advice:
                  'Registered a composed threshold tree. End your turn now — you will be woken ONCE when the combination is satisfied (or at the deadline). The wake reports consumed:true because the whole tree is one-shot: an `any` match consumes and voids every sibling. Do not mix frequent/non-terminal events with rare/terminal events unless the first match is intentionally terminal; split those waits or use an explicit threshold. Re-register for the next occurrence. Cancel the whole tree with events:cancel { root_id }.',
              }),
            },
          ],
        };
      } catch (e) {
        if (e instanceof ComposedSpecError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: e.message,
                  advice: 'The composed `spec` is invalid — fix it and retry (see the events:await `spec` schema).',
                }),
              },
            ],
          };
        }
        throw e;
      }
    }

    // ── P-006 (coord-authority-hardening): fromMsg — resolve the gate key OFF the
    //    message that declared it, so the awaiter never re-types it (hand-typed
    //    near-miss keys never rendezvous; this closes that class). Exactly one
    //    gateRef on the message resolves; none/many is a LOUD, named error. ──
    let eventInput = args.event;
    if (args.fromMsg != null) {
      const origin = await getMessageById(args.fromMsg).catch(() => null);
      if (!origin) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'msg_not_found',
                fromMsg: args.fromMsg,
                advice: `fromMsg '${args.fromMsg}' matches no coord message — nothing was registered. Pass the msg_id from your inbox/feed line, or the gate key itself via \`event\`.`,
              }),
            },
          ],
        };
      }
      const gates = readGateRefs(origin as unknown as Record<string, unknown>);
      if (gates.length !== 1) {
        const hasExpectEffect = Object.prototype.hasOwnProperty.call(origin, 'expectEffect');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: gates.length === 0 ? 'no_gate_refs_on_msg' : 'ambiguous_gate_refs',
                fromMsg: args.fromMsg,
                gate_refs: gates.map((g) => g.key),
                advice:
                  gates.length === 0
                    ? hasExpectEffect
                      ? `Message '${args.fromMsg}' carries an expectEffect directive, not a gateRefs stamp — fromMsg resolves gateRefs only, so nothing was registered. Read the derived compliance verdict on fleet:leader-brief → members[].directiveActuation; to await a gate, ask the sender to re-send with gateRefs:[<key>], or find the key via events:catalog and await it via \`event\`.`
                      : `Message '${args.fromMsg}' carries no gateRefs stamp — fromMsg resolves gateRefs only, so nothing was registered. Ask the sender to re-send with gateRefs:[<key>], or find the key via events:catalog and await it via \`event\`.`
                    : `Message '${args.fromMsg}' declares ${gates.length} gates — pick one and await it via \`event\` (keys listed in gate_refs).`,
              }),
            },
          ],
        };
      }
      eventInput = gates[0].key;
    }
    if (eventInput == null) {
      // The refine guarantees exactly one of event/spec/fromMsg; spec is handled above.
      throw new Error('events:await: pass exactly one of `event`, `spec`, or `fromMsg`');
    }

    // ── Resolve the key: a PATTERN (glob / @macro) normalizes to a stored glob (P-201);
    //    an exact key passes through. A bad macro / too-broad glob throws a clear message. ──
    const patternAwait = isPattern(eventInput);
    const eventKey = patternAwait ? expandPatternMacro(eventInput) : eventInput;
    if (patternAwait) assertUsablePattern(eventKey);

    // ── EI-9270: the announced-gate LATCH — if this exact key was DECLARED and has
    // ALREADY fired, say so NOW instead of registering a wait that can never fire
    // again (the await-after-emit race that stranded late joiners forever). A lapsed
    // declaration (fired_reason='expired') is NOT a latch. Best-effort read.
    let announcedGate: {
      note: string | null;
      announcedBy: string;
      generation: number | null;
      expected: unknown | null;
    } | null = null;
    let announcedGateOwnership: AnnouncementOwnership | null = null;
    let nearMiss: Array<{ key: string; kind: 'await' | 'announce'; holders: number }> | null = null;
    if (!patternAwait) {
      try {
        const anns = await findAnnouncementsForKey(
          eventKey,
          args.after_generation != null ? { includeCancelled: true } : undefined,
        );
        if (args.after_generation != null) {
          const current = anns.find((announcement) => !announcement.supersededAt) ?? anns[0] ?? null;
          const currentGeneration = current?.causalGeneration ?? null;
          const currentState = announcementGenerationState(current);
          const isExpectedFire =
            currentGeneration === args.after_generation && currentState === 'fired' && current?.firedReason === 'event';
          if (
            (currentGeneration !== args.after_generation || currentState !== 'declared') &&
            !isExpectedFire
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    generationMismatchResponse({
                      eventKey,
                      expectedGeneration: args.after_generation,
                      currentGeneration,
                      currentState,
                      firedAt: current?.firedAt,
                    }),
                  ),
                },
              ],
            };
          }
        }
        const latched = anns.find((a) => a.firedAt && a.firedReason === 'event');
        if (latched) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  already_fired: true,
                  event: eventKey,
                  fired_at: latched.firedAt,
                  generation: latched.causalGeneration ?? null,
                  ...(latched.expectedCondition != null ? { expected: latched.expectedCondition } : {}),
                  ...(latched.note ? { gate_note: latched.note } : {}),
                  advice: `The announced gate "${eventKey}" ALREADY FIRED at ${latched.firedAt} — do not wait. Proceed with the work this gate was blocking now.`,
                }),
              },
            ],
          };
        }
        const declared = anns.find((a) => !a.firedAt);
        if (declared) {
          announcedGate = {
            note: declared.note,
            announcedBy: declared.subscriberId,
            generation: declared.causalGeneration ?? null,
            expected: declared.expectedCondition ?? null,
          };
          const ownership = await withBoundedTimeout(
            resolveAnnouncementOwnership(anns, identity.workspaceId),
            { fallback: null, timeoutMs: 1_000, label: 'events-await:announcementOwnership' },
          );
          announcedGateOwnership = ownership.value?.get(declared.id) ?? null;
        }
        // ── event-key-nearmiss-guard P-005: no announcement matches this key
        // exactly — advisory scan for a near-identical active key (another
        // agent's await, or a declared gate you almost-typed). Time-bounded +
        // fail-soft; the registration below always proceeds. ──
        if (anns.length === 0) {
          const found = await withBoundedTimeout(
            findNearMissKeys(eventKey, { excludeOwner: identity.ownerId }),
            { fallback: [], timeoutMs: 1_000, label: 'events-await:nearMiss' },
          );
          if (found.value.length > 0) {
            nearMiss = found.value.map((m) => ({ key: m.eventKey, kind: m.kind, holders: m.holders }));
          }
        }
      } catch { /* best-effort — never block a registration */ }
    }

    // ── Monotonic exact-key LATCHES. The fire ledger is normally diagnostic: a
    // recurring key having fired before does not satisfy a wait for its NEXT edge.
    // One concrete SHA's proven egress and one durable task's first terminal
    // transition cannot become untrue or recur, so a late exact-key registrant must
    // consume the latch. Patterns and bare streams remain ordinary edge waits.
    const gitSyncEgressTarget = !patternAwait ? /^git-sync:egressed:([^:]+)$/.exec(eventKey) : null;
    const taskTerminalTarget = !patternAwait ? /^task:terminal:([^:]+)$/.exec(eventKey) : null;
    const monotonicLatchTarget = gitSyncEgressTarget ?? taskTerminalTarget;
    if (monotonicLatchTarget) {
      const probe = await withBoundedTimeout(probeKeyFireEvidence(eventKey), {
        fallback: null,
        timeoutMs: 1_000,
        label: 'events-await:monotonicExactLatch',
      });
      if (probe.value?.exact && probe.value.fires > 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                already_fired: true,
                event: eventKey,
                fired_at: probe.value.lastFiredAt,
                advice: taskTerminalTarget
                  ? `The managed-task terminal key "${eventKey}" ALREADY FIRED at ${probe.value.lastFiredAt ?? 'an earlier time'} — this task has already entered its first authoritative terminal ledger state. Do not wait; inspect the terminal result and continue now.`
                  : `The git-sync egress key "${eventKey}" ALREADY FIRED at ${probe.value.lastFiredAt ?? 'an earlier time'} — origin/staging has already contained this commit. Do not wait; proceed with the work this egress unblocks now.`,
              }),
            },
          ],
        };
      }
    }

    // ── EI-10870: the ORPHAN-AWAIT guard. `event` is a free-form string, so an
    // invented or mistyped key registers happily and can then only ever TIME OUT
    // — silently, in the safe-looking direction (the agent just waits, and reports
    // "it never happened"). Live proof: `overwatch:surface-landed` — 14 settled
    // awaits, 0 fires EVER, a key that appears nowhere in the tree. The catalog
    // already knew every family's emitter; nothing consulted it at await time.
    //
    // WARN, never reject — a key absent from the catalog is often legitimate (an
    // announced gate, a hand-minted pair key), and a hard reject would break them.
    // And if the installed tier cannot be CONFIRMED, stay silent: a false "nothing
    // emits this" is worse than no warning at all (it trains the warning out).
    // ── EI-13089: the bare FAMILY-PREFIX guard. `keyMatchesCatalog` (used by the
    // orphan-key probe just below) treats a family's prefix as a match whether its
    // first placeholder is required or optional — correct for optional (the bare
    // key IS the real global emit, e.g. `release:deployed`) but WRONG for required
    // (no emitter ever fires the bare literal, e.g. `work-item:done` with no id) —
    // so that probe alone would stay silent and this await could only ever TIME
    // OUT. Cheap + synchronous (static catalog only, no installed-tier I/O); same
    // guard scope as the orphan probe (skip on a pattern or an already-announced
    // gate — both are intentional, not a dropped param). Warns, never rejects.
    let requiredParamPrefixMismatch: { family: string; keyTemplate: string; paramName: string } | null = null;
    if (!patternAwait && !announcedGate) {
      const hit = findRequiredParamPrefixMatch(eventKey);
      if (hit) {
        requiredParamPrefixMismatch = {
          family: hit.entry.family,
          keyTemplate: hit.entry.keyTemplate,
          paramName: hit.param.name,
        };
      }
    }

    // ── P-004/D-002: the ZERO-PARAM-FAMILY-WITH-A-SUFFIX guard — the exact inverse of
    // the EI-13089 check above, and deliberately NOT gated on `patternAwait`. Every other
    // emitter-existence probe in this handler skips globs, so for a pattern the ABSENCE of
    // a warning has never been evidence of anything: the check simply never ran, and the
    // agent cannot distinguish that from "checked and fine". This one IS decidable for a
    // glob (its literal head before the first `*`), and is cheap + synchronous (static
    // catalog, no I/O), so it runs for BOTH forms. An announced gate is exempt: a
    // hand-minted pair-emit key really is fired by its declarer, so the catalog says
    // nothing about it. Warns, never rejects.
    const zeroParamSuffix = announcedGate ? undefined : findZeroParamSuffixMismatch(eventKey);

    let unknownEventKey = false;
    // P-010: the catalogued emitter that owns this key, for the await-wait brief's owner.
    let catalogEmitter: string | null = null;
    if (!patternAwait && !announcedGate) {
      const harnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
      const probe = await withBoundedTimeout(
        (async () => {
          const installed = await readInstalledUnitEvents({
            harnessSlug: typeof harnessRaw === 'string' && harnessRaw !== '*' ? harnessRaw : undefined,
          });
          return mergeInstalledEventCatalog(installed).entries as readonly EventCatalogEntry[];
        })(),
        { fallback: null, timeoutMs: 1_500, label: 'events-await:orphanKey' },
      );
      // A null probe (timeout / discovery failure) ⇒ we cannot be sure ⇒ say nothing.
      if (probe.value) {
        unknownEventKey = !keyMatchesCatalog(eventKey, probe.value);
        catalogEmitter = probe.value.find((entry) => familyAdmitsKey(entry, eventKey))?.emitter ?? null;
      }
    }

    // ── WI-1632193: a key minted by buildAnnouncedKey (`fleet:`/`plan:`/`harness:`
    // + ref + gate) belongs to NO static family, by design — the catalog cannot know
    // a key that is minted at RUNTIME from the announcer's scope. EI-21666331086562886
    // is what it costs to pretend otherwise: a genuinely declared P-508 release latch
    // came back `uncatalogued_event_key:true`, so late agents could not trust the
    // critical-path gate they were waiting on and had to inherit the key out-of-band.
    //
    // Ask the surface that actually OWNS the answer instead. A key with a declaration
    // is legitimate whether or not it has ever fired, and whether or not THIS caller
    // can see it: the `announcedGate` flag above is scope-resolved off the caller's
    // presence, so it answers the narrower "is this MY gate", and a reader outside the
    // announcing fleet/plan gets `false` for a gate that is perfectly real.
    //
    // This is also what keeps the orphan guard SHARP rather than merely quiet. A typo
    // has no declaration, so `plan:draft-redy:x` still warns — which is precisely why
    // the wildcard `plan-event` family was removed from the catalog rather than
    // re-templated: any static family under `plan:` had to answer for the typo and for
    // the real gate identically, and no catalog can tell those apart.
    let declaredAnnouncement: { generations: number; everFired: boolean } | null = null;
    if (unknownEventKey) {
      const declared = await withBoundedTimeout(
        findAnnouncementsForKey(eventKey, { includeSuperseded: true }),
        { fallback: null, timeoutMs: 1_000, label: 'events-await:declaredAnnouncementCheck' },
      );
      // Fail-soft, like every probe here: an unavailable read leaves the warning
      // exactly as it was rather than inventing a reassurance we cannot support.
      if (declared.value && declared.value.length > 0) {
        declaredAnnouncement = {
          generations: declared.value.length,
          everFired: declared.value.some((a) => a.firedAt && a.firedReason === 'event'),
        };
        unknownEventKey = false;
      }
    }

    // ── EI-18676056143796303: the orphan guard knows catalog MEMBERSHIP, but it
    // spoke about EMITTERS ("nothing in this system will ever fire it and this
    // await can only TIME OUT"). For a family that emits but was never registered
    // in the catalog, that verdict is flatly FALSE and maximally actionable in the
    // wrong direction — the correct response to it is to abandon the park, and the
    // live case was `coord:inbox-wake:<ownerId>`: the most-fired key in the system
    // AND the mechanism that rescues a stranded agent. Believing the warning there
    // strands you, which is exactly what the inbox-wake exists to prevent.
    //
    // The fire latch is DIRECT evidence to the contrary: this key (or a sibling in
    // its family) demonstrably fired. When there is such evidence, the membership
    // gap is a CATALOG bug, not a dead await — report it as that and drop the
    // scary claim entirely. A genuine orphan has neither exact nor sibling history,
    // so EI-10870's real case still warns. Bounded + fail-soft: an unavailable
    // latch leaves the (softened) warning exactly as it was. Announcement history
    // is checked first because a runtime-minted key with both histories is a
    // declared gate, not an unregistered catalog family.
    let emitterEvidence: KeyFireEvidence | null = null;
    if (unknownEventKey) {
      const evidence = await withBoundedTimeout(probeKeyFireEvidence(eventKey), {
        fallback: null,
        timeoutMs: 1_000,
        label: 'events-await:keyFireEvidence',
      });
      if (evidence.value && evidence.value.fires > 0) {
        emitterEvidence = evidence.value;
        unknownEventKey = false;
      }
    }

    // ── EI-18701276960172209 (the "green-gate-verdict" incident): a SELF- (or
    // peer-) DECLARED gate is exempted from the orphan-await guard above (an
    // announced-but-unfired gate is normally legitimate — a hand-minted pair-emit
    // key has no catalog entry yet, by design), but that exemption silently hid a
    // dead wait: an agent declared `green-gate-verdict`, expecting the
    // green-checkpoint pipeline to fire it, when the pipeline actually emits
    // `release:green:<pipeline>` — NOTHING was ever going to fire the invented
    // key, and nothing said so. "Announced" only proves someone WANTS this key to
    // fire; it does not prove anything ever WILL. So: cross-check the catalog +
    // fire history for an announced gate too, but phrase it as an advisory about
    // the GATE, never as "this will time out" (an intentional pair-emit gate that
    // simply hasn't fired YET is not a bug). Advisory only — never blocks
    // registration, and skipped once the emitter-evidence check above already ran
    // for THIS key (it can't have, since that only runs when `!announcedGate`).
    let noKnownEmitterForAnnouncedGate: { catalogNearMiss: string[] } | null = null;
    if (!patternAwait && announcedGate) {
      const harnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
      const probe = await withBoundedTimeout(
        (async () => {
          const installed = await readInstalledUnitEvents({
            harnessSlug: typeof harnessRaw === 'string' && harnessRaw !== '*' ? harnessRaw : undefined,
          });
          return mergeInstalledEventCatalog(installed).entries as readonly EventCatalogEntry[];
        })(),
        { fallback: null, timeoutMs: 1_500, label: 'events-await:announcedGateEmitterCheck' },
      );
      // A null probe (timeout/discovery failure) ⇒ cannot be sure ⇒ say nothing.
      if (probe.value && !keyMatchesCatalog(eventKey, probe.value)) {
        const evidence = await withBoundedTimeout(probeKeyFireEvidence(eventKey), {
          fallback: null,
          timeoutMs: 1_000,
          label: 'events-await:announcedGateFireEvidence',
        });
        // A previous declaration generation is direct evidence that this exact
        // hand-minted gate has fired, even when the unconditional fire latch was
        // introduced after that generation (or its best-effort write was lost).
        // Without this history read, a new declaration after a fired generation
        // was incorrectly described as a key that had "never fired on this host".
        const declarationHistory = await withBoundedTimeout(
          findAnnouncementsForKey(eventKey, { includeSuperseded: true }),
          { fallback: null, timeoutMs: 1_000, label: 'events-await:announcementHistory' },
        );
        const priorGenerationFired = declarationHistory.value?.some(
          (announcement) => announcement.firedAt && announcement.firedReason === 'event',
        );
        // No catalog family, no fire-latch evidence, and no fired declaration
        // history ⇒ genuinely no known emitter. An unavailable history read is
        // fail-soft: an unverifiable claim is safer than a contradictory warning.
        const hasLiveEmitterDuty = announcedGateOwnership != null &&
          ((announcedGateOwnership.declaredByLiveness != null && announcedGateOwnership.declaredByLiveness !== 'ended') ||
            announcedGateOwnership.liveSuccessorIds.length > 0);
        if (evidence.value?.fires === 0 && declarationHistory.value && !priorGenerationFired && !hasLiveEmitterDuty) {
          noKnownEmitterForAnnouncedGate = { catalogNearMiss: findCatalogNearMiss(eventKey, probe.value) };
        }
      }
    }

    // ── EI-20268841604319803: the SERVICE-UP EDGE advisory. `service:up:<name>`
    // is emitted from a diffHealth unhealthy→healthy TRANSITION, so arming it
    // while <name> is ALREADY healthy parks on an edge nothing is heading
    // toward. Measured cost: a real inference-gateway restart slept through a
    // 6h await and surfaced ~56 minutes later as a TIMEOUT — the restart having
    // completed between health ticks, so no unhealthy sample, so no transition,
    // so no event. For a flap-damped name that is not merely likely but
    // STRUCTURAL: damping exists to swallow exactly these short restart blips.
    //
    // The knowledge already existed one file away — `service:await-up`
    // (sugar.ts) probes at arm time and short-circuits when the service is
    // healthy — but the RAW path shared none of it. One key, two surfaces,
    // opposite safety, and the unprotected surface's SILENCE was
    // indistinguishable from a clean bill of health. Both now call the same
    // predicate (./service-up-edge) so they cannot drift apart again.
    //
    // ADVISORY, never a short-circuit — deliberately unlike the work-item /
    // plan-item latches below. Those keys fire once and provably cannot fire
    // again, so returning "already satisfied" is the whole truth. A service CAN
    // go down and recover later, so "wake me if this ever breaks and comes
    // back" is a legitimate standing wait, and short-circuiting it would break
    // the arm-before-I-cause-an-outage pattern. Warn, register, let the caller
    // decide. Fail-open + bounded like every probe here: an unreadable health
    // read says nothing rather than manufacturing an all-clear.
    let serviceUpEdge: { name: string; damped: boolean } | null = null;
    if (!patternAwait && !announcedGate) {
      const serviceUpName = parseServiceUpKey(eventKey);
      if (serviceUpName) {
        const healthyNow = await probeServiceUpLatch(serviceUpName);
        if (healthyNow) {
          serviceUpEdge = { name: serviceUpName, damped: isFlapDamped(serviceUpName) };
        }
      }
    }

    // ── EI-19332682533219755: a PATTERN whose glob silently spans SCOPES.
    // `release:green:*` looks like "the gate went green", but the pipeline is a
    // key SEGMENT (`release:green:<pipeline>`) and `*` is a plain glob over the
    // rest of the key — so on a multi-pipeline host it subscribes to OTHER
    // PROJECTS. Live case: an agent awaiting the papercusp gate woke on
    // `satisfied: true` carrying `pipeline: "oddsmith"`, whose sha is not even an
    // object in this repo, while the papercusp gate was still mid-run. Every
    // affordance read as success (family literally named `release:green`, wake
    // says satisfied, documented next step is to SHIP) and nothing disclosed the
    // foreign scope; it was caught only by hand-checking the sha.
    //
    // So DISCLOSE what the glob really covers, from observed fire history. This
    // deliberately does NOT narrow or reject the await: a primitive the whole
    // fleet parks on must never start dropping wakes to fix a reporting gap, and
    // cross-pipeline monitors are legitimate (checkpoint:await has an explicit
    // `global: true` for exactly that). Advisory only, best-effort, time-bounded.
    let patternScope: { matchedKeys: string[]; truncated: boolean } | null = null;
    if (patternAwait) {
      const probe = await withBoundedTimeout(probePatternMatchScope(eventKey), {
        fallback: null,
        timeoutMs: 1_500,
        label: 'events-await:patternScope',
      });
      // Only worth saying when the pattern demonstrably spans MORE THAN ONE
      // concrete key — a glob matching a single observed key (or none yet) is
      // exactly what its author expected and needs no warning.
      if (probe.value && probe.value.matchedKeys.length > 1) {
        patternScope = { matchedKeys: probe.value.matchedKeys, truncated: probe.value.truncated };
      }
    }

    // ── EI-13095 (the WI-5075 stranded-await incident): the done-key LATCH.
    // `work-item:done:<id>` fires ONCE, at settle time, so a registration made
    // AFTER the item settled can only ever time out — the awaiter sleeps through
    // a fix/completion that already happened (live case: an await on
    // work-item:done:WI-5075 registered 6 minutes after the item resolved slept
    // to its 2h timeout). The item row is the durable latch state: probe it NOW
    // and answer already_done instead of registering a dead wait. Same class as
    // the EI-9270 announced-gate latch and the P-006 unblocked latch below.
    // Best-effort + time-bounded: an 'unknown' probe registers normally.
    const doneTarget = patternAwait ? undefined : /^work-item:done:([^:]+)$/.exec(eventKey)?.[1];
    if (doneTarget) {
      const probe = await withBoundedTimeout(liveSettledProbe(doneTarget), {
        fallback: { verdict: 'unknown' as const },
        timeoutMs: 1_500,
        label: 'events-await:doneLatch',
      });
      if (probe.value.verdict === 'settled') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                already_done: true,
                event: eventKey,
                item_state: probe.value.itemState ?? 'settled',
                advice: `${doneTarget} is ALREADY settled (${probe.value.itemState ?? 'terminal'}) — "${eventKey}" fired when it settled and will not fire again. Do not wait; proceed with the work this settle unblocks now.`,
              }),
            },
          ],
        };
      }
    }

    // ── EI-18734910825871393-class fix: the `plan-item:done:<slug>:<id>` LATCH,
    // same shape as the work-item:done latch just above. `plan-item:done:<slug>:<id>`
    // fires exactly once, on the real →done edge (plan-item-events.ts: "never a
    // re-set of an already-done item") — so a registration made after that edge can
    // only ever time out. Live repro (2026-07-26): an await registered ~76s AFTER
    // the item's done-fire slept the FULL default timeout (3600s) instead of
    // resolving immediately, on a fleet where plan-item:done events fire in quick
    // succession (an orient-check-then-await sequence easily straddles one).
    //
    // Deliberately NOT a blanket `event_key_fires`-latch check (the bug's own
    // suggested fix): that table accumulates fires for EVERY key including
    // RECURRING ones (work-item:claimable, coord:inbox-wake:<owner>, …), so
    // treating "a fire exists" as "already satisfied" there would falsely
    // short-circuit every SUBSEQUENT await on a recurring key using its ancient
    // first-ever fire — a much worse regression than the race being fixed. Instead
    // this probes the plan item's CURRENT LIVE effectiveStatus (mirrors
    // liveSettledProbe's approach above, not an event-history read) — a plan item
    // can only be 'done' via that one-shot edge, so live-status=='done' is exactly
    // equivalent to "the event already fired" without the recurring-key hazard.
    // Best-effort + time-bounded: an unreadable/ambiguous probe registers normally.
    const planItemDoneMatch = patternAwait ? null : /^plan-item:done:([^:]+):([^:]+)$/.exec(eventKey);
    if (planItemDoneMatch) {
      const [, planSlug, planItemId] = planItemDoneMatch;
      const probe = await withBoundedTimeout(
        (async () => {
          const harnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
          const { harnessSlug } = await resolvePlanScope({
            harnessSlug: typeof harnessRaw === 'string' ? harnessRaw : undefined,
          });
          return planItemEffectiveStatus(harnessSlug, planSlug, planItemId);
        })(),
        { fallback: null, timeoutMs: 1_500, label: 'events-await:planItemDoneLatch' },
      );
      if (probe.value === 'done') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                already_done: true,
                event: eventKey,
                item_state: 'done',
                advice: `Plan item ${planSlug}#${planItemId} is ALREADY done — "${eventKey}" fired when it settled and will not fire again. Do not wait; proceed with the work this settle unblocks now.`,
              }),
            },
          ],
        };
      }
    }

    // ── linking-notify-family-hardening P-006: the unblocked-key LATCH.
    // `work-item:unblocked:<id>` fires only on a blocked→unblocked EDGE, so a
    // registration against an item with NO live blocker (or already settled)
    // could only ever time out — the await-after-the-fact strand, same class
    // as the EI-9270 announced-gate race above. A lifecycle-only `blocked` /
    // `needs-human` hold is NOT an emitter: with no live `blocks` edge there is
    // no last-edge-clear transition that can fire this exact key. Refuse that
    // shape before registration instead of returning a durable silent park.
    // Best-effort and time-bounded: an 'unknown' probe (unreadable item,
    // ambiguous id) falls through to a normal registration.
    const unblockedTarget = patternAwait ? undefined : /^work-item:unblocked:([^:]+)$/.exec(eventKey)?.[1];
    let unblockedProbe: LiveBlockedStateProbe | null = null;
    if (unblockedTarget) {
      const probe = await withBoundedTimeout(liveBlockedState(unblockedTarget), {
        fallback: { verdict: 'unknown' as const, dependencyState: 'unknown' as const },
        timeoutMs: 1_500,
        label: 'events-await:unblockedLatch',
      });
      unblockedProbe = probe.value;
      if (probe.value.verdict === 'unblocked' || probe.value.verdict === 'settled') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                already_unblocked: true,
                event: eventKey,
                item_state: probe.value.verdict,
                lifecycle_state: probe.value.lifecycleState,
                dependency_state: probe.value.dependencyState,
                advice:
                  probe.value.verdict === 'settled'
                    ? `${unblockedTarget} is already SETTLED — "${eventKey}" will never fire. Do not wait on it.`
                    : `${unblockedTarget} has NO live blocker right now — it is ALREADY unblocked, so "${eventKey}" will not fire (it fires only on a future blocked→unblocked edge). Proceed with the blocked work now instead of waiting.`,
              }),
            },
          ],
        };
      }
      if (probe.value.verdict === 'blocked' && probe.value.dependencyState === 'unblocked') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'unfirable_work_item_unblocked',
                firable: false,
                event: eventKey,
                work_item_id: unblockedTarget,
                item_state: probe.value.lifecycleState,
                lifecycle_state: probe.value.lifecycleState,
                dependency_state: probe.value.dependencyState,
                advice:
                  `${unblockedTarget} is lifecycle-${probe.value.lifecycleState} but has NO live blocker dependency edge. ` +
                  `"${eventKey}" fires only when the item's LAST live \`blocks\` edge clears, so this exact key cannot fire for the current shape and nothing was registered. ` +
                  'Await work-item:done:<actual-blocker-id> instead (and keep a bounded fallback wake), or use the general work-item:status:<id> key if a lifecycle transition is what you need.',
              }),
            },
          ],
        };
      }
    }

    // ── EI-18731480441007330 (the WI-6095 unbreakable self-deadlock incident):
    // the SELF-AWAIT guard. An agent can hold a work-item as its own assignee
    // AND register an events:await on that SAME item's `work-item:status:<id>`
    // / `work-item:done:<id>` / `claim:released:<id>` key — but each key is
    // driven by the awaiter's own claim lifecycle (the first two by acting on
    // the item, the latter by releasing its claim), so the wait is unsatisfiable
    // by construction: a permanent self-deadlock that no fleet health check
    // surfaces (the resulting verdict — `parked-awaiting-capability` — looks
    // identical to a legitimate wait on a PEER's work).
    // We actively teach members to "park on the event that unblocks you"
    // (correct advice in general — see EI-18730414627683753's opposite
    // failure, dormant members that never park at all), and a member holding
    // the very item that blocks it will naturally derive this exact wrong
    // key. REFUSE the await outright (preferred fix, per the filed report)
    // rather than let it register and silently strand: this is a pure
    // precondition check against state the caller already has in hand (its
    // own ownerId vs. the item's assignee field), not a probe that can go
    // stale. Skipped for a pattern await (no single id to check) and for an
    // already-settled item (liveAssigneeProbe returns 'settled' — no
    // deadlock risk; the doneTarget latch above already short-circuits that
    // case for `work-item:done:<id>` before we even get here).
    const selfAwaitTarget = patternAwait ? undefined : /^(?:work-item:(?:status|done)|claim:released):([^:]+)$/.exec(eventKey)?.[1];
    if (selfAwaitTarget) {
      const probe = await withBoundedTimeout(liveAssigneeProbe(selfAwaitTarget), {
        fallback: { verdict: 'unknown' as const },
        timeoutMs: 1_500,
        label: 'events-await:selfAwaitGuard',
      });
      if (probe.value.verdict === 'live' && probe.value.assignee === identity.ownerId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'self_await_deadlock',
                event: eventKey,
                work_item_id: selfAwaitTarget,
                advice:
                  `You are the CURRENT ASSIGNEE of ${selfAwaitTarget} — awaiting "${eventKey}" would wait on YOUR OWN completion of it, which is unsatisfiable by construction (this key only fires when you yourself act on the item). Nothing was registered. Do the work and settle the item (work_items:complete / work_items:set_state) instead of awaiting it; if you meant to wait on a DIFFERENT item that actually blocks you, double-check the id.`,
              }),
            },
          ],
        };
      }
    }

    // ── EI-13846 (hive-wide wake-storm): default the payload_filter for the
    // canonical `work-item:claimable` key to the CALLER'S OWN claim-spec view
    // when they didn't pass one explicitly. The member contract (scheduler:get_next's
    // miss advice, loop.ts's idle-park instruction) has always TOLD callers to copy
    // a derived filter onto this park, but nothing enforced or defaulted it — a
    // member that simply calls `events:await({ event: 'work-item:claimable' })`
    // (no lane yet, or one that just drained) got an UNSCOPED await that fires on
    // EVERY hive-wide claimable emission. On a ~2000-item board that is constant:
    // one drained member burned ~54 wakes / 272 tool calls overnight on a
    // guaranteed-miss scheduler:get_next, purely from an unscoped park. Reuses the
    // EI-15185 derivation verbatim (claimSpecFilterToClaimablePayloadFilter) — no
    // new translation logic, just applying it as a DEFAULT instead of advice text.
    // Best-effort: a claim-spec read failure/timeout must never block registration
    // — it just leaves the await unscoped, exactly as before this fix.
    let effectivePayloadFilter = args.payload_filter ?? null;
    let autoScopedFrom: { source: 'cup' | 'fleet'; specId: string; revision: number | null } | null = null;
    let unscopedClaimableWarning = false;
    let claimableSpecRecord: ClaimSpecRecord | null = null;
    if (!patternAwait && eventKey === 'work-item:claimable') {
      const probe = await withBoundedTimeout(
        getClaimSpecRecord({
          cupId: identity.ownerId,
          workspaceId: resolveClaimSpecWorkspace(identity.workspaceId ?? undefined),
        }),
        { fallback: null, timeoutMs: 1_500, label: 'events-await:claimSpecDefault' },
      );
      const record = probe.value;
      claimableSpecRecord = record;
      if (effectivePayloadFilter == null && record && record.source !== 'default') {
        // EI-18674502503888023 / EI-18674151670359202 / EI-18674160393981819: the spec's
        // `view.filter` tree can NEVER carry a `harness` leaf (D-002 — harness scoping is a
        // resolver-level floor, not spec vocabulary; see ITEM_FIELDS in claim-spec.ts), so
        // `claimSpecFilterToClaimablePayloadFilter` alone can only narrow on kind/id/title/
        // plan/tags/goal. A harness-bound fleet spec (the common case — every fleet:launch-on-plan
        // fleet stores its `harness_slug` on the very same cup_claim_specs row) was silently
        // left UNSCOPED on harness, so this auto-scope fired on any matching-kind item from
        // ANY harness in the workspace — observed live: a papercusp fleet member woken by a
        // brand-new bug in an unrelated harness (oddsmith-hive), burning a full wake for
        // nothing. Fix: AND in an explicit `harness` leaf from the claim-spec record's own
        // `harnessSlug` column (independent of the filter-tree translation) whenever it is
        // set, on top of whatever the filter tree itself narrows.
        const derived = claimSpecFilterToClaimablePayloadFilter(record.spec.view.filter) ?? null;
        const harnessLeaf = record.harnessSlug ? { harness: { equals: record.harnessSlug } } : null;
        const combined =
          derived && harnessLeaf ? { all: [derived, harnessLeaf] } : (harnessLeaf ?? derived);
        if (combined) {
          effectivePayloadFilter = combined;
          autoScopedFrom = { source: record.source, specId: record.spec.specId, revision: record.revision };
        } else {
          unscopedClaimableWarning = true;
        }
      } else if (effectivePayloadFilter == null) {
        unscopedClaimableWarning = true;
      }
    }

    // ── EI-19344528739076339 (cross-pipeline false green): the same auto-narrow, for the
    // gate-verdict keys. `green-checkpoint.ts` emits a GLOBAL `release:green` /
    // `green-checkpoint:red` alongside each `<key>:<pipeline>` sibling, so the bare key fires
    // from every one of the ~13 co-hosted pipelines on this box. An agent awaiting it is
    // woken by a STRANGER'S gate with nothing in the wake itself saying so.
    //
    // Twice in one day that produced a false "the gate is green": EI-19311522275272409 (woken
    // by oddsmith's advance of 9a8aa848 while papercusp had no verdict in that window at all)
    // and again at 12:17:49Z (woken by oddsmith's b54be5962 while papercusp was RED with its
    // refire still in flight). Measured at the time: bare `release:green` last fired for
    // oddsmith, while `release:green:papercusp` was ~10.7h stale.
    //
    // The prior fix put a `[pipeline]` prefix on the SUMMARY, which helps only an agent that
    // reads the wake banner — not one whose wake was parked and redelivered across a
    // carry-respawn (exactly the filer's case), and not one inspecting events:status. The
    // trap is the KEY CHOICE, so it has to be closed at registration.
    //
    // ⚠ Scoped on the pipeline DERIVED THE WAY THE EMITTER DERIVES IT, never on the caller's
    // harness slug. `pipeline` is the sanitized basename of the integration root; that it
    // currently equals a slug for all four emitting pipelines is naming convention, not
    // construction. Narrowing on a slug that never appears in any payload yields an await
    // that CANNOT fire — a silent hang, strictly worse than the wrong-pipeline wake this
    // fixes. Hence: resolve it or warn, never guess.
    let autoScopedPipeline: string | null = null;
    let unscopedGateKeyWarning = false;
    if (!patternAwait && eventKey && isMultiPipelineGateKey(eventKey) && effectivePayloadFilter == null) {
      const pipeline = currentPipelineName();
      if (pipeline) {
        effectivePayloadFilter = { pipeline: { equals: pipeline } };
        autoScopedPipeline = pipeline;
      } else {
        unscopedGateKeyWarning = true;
      }
    }

    // ── EI-19928976726540168: the SAME auto-narrow as immediately above, for the GLOB form
    // of a gate-verdict key ("release:green:*", "green-checkpoint:red:*",
    // "green-checkpoint:inconclusive:*"). The exact-key block above requires `!patternAwait`,
    // so it never ran for this shape — which is exactly the form an agent reaches for when they
    // actually want "any verdict for my pipeline". The glob is just as cross-tenant as the bare
    // key (the pipeline is the last key segment, so `*` matches every co-hosted pipeline's, not
    // just the caller's). Live incident: a caller parked on `green-checkpoint:red:*` and was
    // woken by a foreign pipeline's verdict, payload-shape-identical to its own.
    //
    // Deliberately separate variables (`patternAutoScopedPipeline` / `patternUnscopedGateKeyWarning`)
    // rather than reusing `autoScopedPipeline`/`unscopedGateKeyWarning` above: the response text
    // for the exact-key case interpolates `"${eventKey}:${autoScopedPipeline}"`, which would render
    // MALFORMED for a glob (`release:green:*:papercusp`) if reused here.
    let patternAutoScopedPipeline: string | null = null;
    let patternUnscopedGateKeyWarning = false;
    if (patternAwait && eventKey && isMultiPipelineGateKeyPattern(eventKey) && effectivePayloadFilter == null) {
      const pipeline = currentPipelineName();
      if (pipeline) {
        effectivePayloadFilter = { pipeline: { equals: pipeline } };
        patternAutoScopedPipeline = pipeline;
      } else {
        patternUnscopedGateKeyWarning = true;
      }
    }

    // ── EI-14225: retire the CALLER'S OWN prior pending registration(s) on this
    // EXACT key before adding a new one. events:await is one-shot by construction
    // (the caller only ever wants ONE outstanding wait per key) — the canonical
    // idle-park loop (scheduler:get_next miss → re-await 'work-item:claimable' →
    // end turn, repeated every wake) previously left every earlier registration
    // alive, each ticking down to its OWN independent timeout: a long-running loop
    // that re-registered on turns 2/3/4 could still be woken by turn 2's stale
    // await firing its TIMEOUT well after turns 3/4 were already handled — a full
    // wasted wake turn carrying a stale `note` for zero new information. Reuses the
    // exact supersede primitive the checkpoint/deploy sugar verbs already rely on
    // for this (cancelAwaitsForSubscribersOnKeys, EI-12457) instead of a new
    // mechanism. Best-effort: a failed retirement must never block registering the
    // new wait. Skipped when a PRIOR key genuinely fired for someone (announcedGate/
    // already_fired above already returned) — this only runs on the path that is
    // about to register a fresh row.
    if (!isPattern(eventKey)) {
      const predicateKey = normalizeMonitorPredicateKey(eventKey);
      // EI-22582439825634596: this is an OPTIONAL duplicate-monitor advisory, not
      // part of the await's durable registration. A saturated admin pool used to
      // let its bounded read reject here, so a valid events:await never reached
      // registerAwait and the caller lost its wake source. Degrade this read just
      // like the other best-effort probes; the exact await remains authoritative.
      const monitorProbe = predicateKey
        ? await withBoundedTimeout(
            () =>
              hasActiveMonitorForOwnerPredicate({
                workspaceId: ctx.workspaceId ?? identity.workspaceId ?? activeWorkspaceId(),
                ownerId: identity.ownerId,
                predicateKey,
              }),
            { fallback: false, timeoutMs: 1_500, label: 'events-await:monitorPredicateDedup' },
          )
        : null;
      if (monitorProbe?.value === true) {
        const refusal = monitorPredicateDedupRefusal(predicateKey, 'monitor')!;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: refusal.code, message: refusal.message, ...refusal.details }) }],
          isError: true,
        };
      }
    }

    // A release await can park this session while unrelated plan work is ready,
    // or while a false A -> B -> C edge hides that work. Check the plan before
    // retiring any existing await or registering a new one.
    const mainWaitPlanReview = await mainWaitPlanReviewForWait({
      ownerId: identity.ownerId,
      event: eventKey,
      note: args.note,
    });
    if (mainWaitPlanReview && !mainWaitPlanReview.allowWait) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: mainWaitPlanReview.code, ...mainWaitPlanReview }) }],
        isError: true,
      };
    }

    let supersededCount = 0;
    try {
      supersededCount = await cancelAwaitsForSubscribersOnKeys([identity.ownerId], [eventKey], {
        excludeNotePrefix: FLEET_BENCH_NOTE_PREFIX,
        onceOnly: true,
      });
    } catch {
      /* best-effort — never let a retirement failure block the new registration */
    }

    // ── Capture the wake handle NOW (D-003) ────────────────────────────
    const { handle, note: handleNote } = await captureWakeHandleForOwner(identity.ownerId, {
      planRunId: args.plan_run_id,
    });

    // Was a hand-rolled copy of the canonical resolver, sentinel list and all.
    // resolveConcreteHarnessSlug(null, ctx) is identical by construction — ctx-only
    // (no arg override), trimmed, and filtered through isAllHarnessSentinel — with
    // the sentinel vocabulary owned in ONE place instead of duplicated here.
    const harnessRaw = resolveConcreteHarnessSlug(null, ctx);
    const producerHealthCertificate = args.producer_health
      ? await resolveProducerHealthCertificate({
          producerHealth: args.producer_health,
          subscriberId: identity.ownerId,
          timeoutSec: args.timeout_sec,
        })
      : args.progress_lease
        ? await resolveProgressLeaseCertificate({
            progressLease: args.progress_lease,
            subscriberId: identity.ownerId,
            workspaceId: ctx.workspaceId ?? identity.workspaceId ?? activeWorkspaceId(),
            harnessSlug: harnessRaw,
            role: ctx.role ?? 'su',
            timeoutSec: args.timeout_sec,
          })
        : null;
    const effectiveTimeoutSec =
      args.timeout_sec ??
      (args.producer_health
        ? args.producer_health.expected_cadence_sec
        : args.progress_lease
          ? args.progress_lease.expected_cadence_sec
          : DEFAULT_TIMEOUT_SEC);
    let row: AwaitRow;
    try {
      // EI-22727577507367447: one transient 57014/55P03 while renewing an
      // await must not strand the caller without a wake source. The store's
      // supersede-and-insert transaction is idempotent across a retry: if an
      // ambiguous first attempt committed, the next attempt retires that row
      // before inserting its replacement. Non-contention failures still
      // surface immediately.
      row = await acquireWithContentionRetry(() =>
        registerAwait({
          subscriberId: identity.ownerId,
          eventKey,
          policy: 'wake',
          note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
          wakeHandle: handle,
          timeoutBehavior: args.on_timeout ?? 'wake',
          timeoutSec: effectiveTimeoutSec,
          payloadFilter: effectivePayloadFilter,
          producerHealthCertificate,
          expectedGeneration: args.after_generation,
          supersedePending: {
            excludeNotePrefix: FLEET_BENCH_NOTE_PREFIX,
          },
        }),
      );
    } catch (error) {
      if (!isAwaitGenerationMismatchError(error)) throw error;

      // The pre-registration status read and the atomic store registration can
      // race with the gate emitter. If the exact generation we authenticated
      // fired during that handoff, the gate is satisfied; only a different
      // generation/state requires a full status re-sync.
      if (
        args.after_generation != null &&
        error.currentGeneration === args.after_generation &&
        error.currentState === 'fired'
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                already_fired: true,
                event: eventKey,
                generation: error.currentGeneration,
                ...(error.firedAt ? { fired_at: error.firedAt } : {}),
                advice: `The announced gate "${eventKey}" fired during await registration at ${error.firedAt ?? 'an earlier time'} — do not wait. Proceed with the work this gate was blocking now.`,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              generationMismatchResponse({
                eventKey: error.eventKey,
                expectedGeneration: error.expectedGeneration,
                currentGeneration: error.currentGeneration,
                currentState: error.currentState,
                firedAt: error.firedAt,
              }),
            ),
          },
        ],
      };
    }

    // Close the registration-window race for every monotonic exact latch. The
    // emitter records the latch BEFORE claiming await rows, so a fire landing after
    // the preflight read is visible here. Cancel only through the row-level pending
    // guard: if the emitter already claimed this row, its durable delivery wins.
    if (monotonicLatchTarget) {
      const postRegisterProbe = await withBoundedTimeout(probeKeyFireEvidence(eventKey), {
        fallback: null,
        timeoutMs: 1_000,
        label: 'events-await:monotonicExactLatchAfterRegister',
      });
      if (postRegisterProbe.value?.exact && postRegisterProbe.value.fires > 0) {
        let retired = false;
        try {
          retired = await cancelAwait({ awaitId: row.id, subscriberId: identity.ownerId });
        } catch {
          // Fail-soft: if the reconciliation write is unavailable, keep the
          // registration response honest and let the normal await path proceed.
        }
        if (retired) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  already_fired: true,
                  event: eventKey,
                  fired_at: postRegisterProbe.value.lastFiredAt,
                  advice: taskTerminalTarget
                    ? `The managed-task terminal key "${eventKey}" fired during registration at ${postRegisterProbe.value.lastFiredAt ?? 'an earlier time'} — the still-pending await was retired because this task has already entered its first authoritative terminal ledger state. Do not wait; inspect the terminal result and continue now.`
                    : `The git-sync egress key "${eventKey}" fired during registration at ${postRegisterProbe.value.lastFiredAt ?? 'an earlier time'} — the still-pending await was retired and the commit is already on origin/staging. Proceed with the work this egress unblocks now.`,
                }),
              },
            ],
          };
        }
      }
    }

    // A work item or plan item can settle between the pre-registration state
    // read and the await insert. Re-read the CURRENT business state after the
    // row is durable; a concurrent emitter wins cancelAwait's pending guard
    // and keeps its queued wake. A reopened item remains pending for its next
    // terminal transition rather than trusting an old fire latch.
    if (doneTarget || planItemDoneMatch) {
      const settled = await withBoundedTimeout(
        doneTarget
          ? liveSettledProbe(doneTarget).then((result) => result.verdict === 'settled')
          : (async () => {
              const [, planSlug, planItemId] = planItemDoneMatch!;
              const harnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
              const { harnessSlug } = await resolvePlanScope({
                harnessSlug: typeof harnessRaw === 'string' ? harnessRaw : undefined,
              });
              return (await planItemEffectiveStatus(harnessSlug, planSlug, planItemId)) === 'done';
            })(),
        { fallback: false, timeoutMs: 1_500, label: 'events-await:terminalStateAfterRegister' },
      );
      if (settled.value) {
        let retired = false;
        try {
          retired = await cancelAwait({ awaitId: row.id, subscriberId: identity.ownerId });
        } catch {
          // An unreadable cancellation leaves the durable await in place.
        }
        if (retired) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                already_done: true,
                event: eventKey,
                advice: 'The current item reached terminal state during registration. Inspect its result and continue now.',
              }),
            }],
          };
        }
      }
    }

    // ── EI-21565976517547834: close the recurring claimable-key registration
    // race. `work-item:claimable` is an EDGE signal, but the condition it announces
    // is level-triggered: a matching row may still be claimable after its release /
    // requeue event has already fired. The live incident registered await 106008
    // after WI-42252 returned to the pool; another member claimed the row during the
    // await window, proving useful work existed, yet this waiter saw only its timeout.
    //
    // Reconcile AFTER the durable row is inserted. That single post-registration
    // read covers both sides of the handoff: work already present before registration
    // and work that becomes claimable during it. If an emitter concurrently claims
    // the await, cancelAwait's pending-row guard loses and the durable wake delivery
    // wins. If the await is still pending, retire it and return already_claimable so
    // the caller immediately re-runs scheduler:get_next instead of sleeping through
    // a level that is already true. Best-effort and issue-family scoped: an absent /
    // default spec or a bounded oracle failure preserves the ordinary edge await.
    if (
      !patternAwait &&
      eventKey === 'work-item:claimable' &&
      claimableSpecRecord &&
      claimableSpecRecord.source !== 'default' &&
      claimableSpecRecord.harnessSlug
    ) {
      const record = claimableSpecRecord;
      const live = await withBoundedTimeout(
        (async () => {
          const reading = await readIssueClaimability(
            record.spec.view.filter,
            {
              harness: record.harnessSlug!,
              workspaceId: resolveClaimSpecWorkspace(identity.workspaceId ?? undefined),
              states: record.spec.states,
              assignee: identity.ownerId,
              claimantFleetSlug: record.fleetSlug,
              claimSpecReferencesFleet: claimSpecReferencesField(record.spec, 'fleet'),
              // EI-21398324268952860: mirror the claim's goal leg, or this readiness read
              // under-reports a goal-scoped spec's own plan lane as gated.
              claimSpecReferencesGoal: claimSpecReferencesField(record.spec, 'goal'),
              spec: record.spec,
            },
            { limit: 20, statementTimeoutMs: 1_500 },
          );
          for (const candidate of reading.rows) {
            const payload = await liveWorkItemClaimableEventPayload(candidate.id, record.harnessSlug ?? undefined);
            if (payload && payloadMatchesFilter(effectivePayloadFilter, payload)) return payload;
          }
          return null;
        })(),
        { fallback: null, timeoutMs: 2_000, label: 'events-await:claimableLevelAfterRegister' },
      );
      if (live.value) {
        let retired = false;
        try {
          retired = await cancelAwait({ awaitId: row.id, subscriberId: identity.ownerId });
        } catch {
          // Fail-soft: if the pending-row reconciliation write is unavailable,
          // keep the registration response honest and let the normal await path run.
        }
        if (retired) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  already_claimable: true,
                  event: eventKey,
                  item: live.value,
                  ...(effectivePayloadFilter != null ? { payload_filter: effectivePayloadFilter } : {}),
                  advice:
                    `A work item matching this claimable await is ALREADY in the live pool (${String(live.value.id ?? 'id unknown')}). ` +
                    'The still-pending await registered during the handoff was retired. Re-run scheduler:get_next now; do not end your turn or wait for another edge.',
                }),
              },
            ],
          };
        }
      }
    }

    await extendClaimsForThisAwait(effectiveTimeoutSec);

    // acceptance-runtime-plane P-003: a release-deploy wait by an agent whose held
    // live/deployed acceptance bars are measured elsewhere gets told so. Advisory only;
    // never throws and never alters the registration above.
    const acceptancePlaneAdvisory = await acceptancePlaneAdvisoryForWait({
      ownerId: identity.ownerId,
      event: eventKey,
    });

    // P-010 (OP-BRIEF-P010-WAIT): a pending one-shot wake registration is the await outcome
    // that blocks the caller across turns; every early return above (already_fired,
    // already_claimable, generation mismatch, refusals) is synchronous and carries none.
    const operationalBrief = projectAwaitWaitOperationalBrief({
      wakeAwait: row,
      announcement: announcedGate
        ? {
            announcedBy: announcedGate.announcedBy,
            declaredByLiveness: announcedGateOwnership?.declaredByLiveness ?? null,
            liveSuccessorIds: announcedGateOwnership?.liveSuccessorIds ?? [],
          }
        : null,
      catalogEmitter,
      emitterHint: patternAwait
        ? 'pattern'
        : declaredAnnouncement
          ? 'declared-out-of-scope'
          : emitterEvidence
            ? 'fired-uncatalogued'
            : null,
      noKnownEmitter: unknownEventKey || noKnownEmitterForAnnouncedGate !== null,
      wakeHandleNote: handleNote,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            await_id: row.id,
            event: row.eventKey,
            ...(unblockedProbe?.verdict === 'blocked' && unblockedProbe.lifecycleState
              ? {
                  item_state: unblockedProbe.lifecycleState,
                  lifecycle_state: unblockedProbe.lifecycleState,
                  dependency_state: unblockedProbe.dependencyState,
                }
              : {}),
            ...(supersededCount > 0
              ? {
                  superseded: supersededCount,
                  superseded_advice: `Retired ${supersededCount} of your own prior pending await(s) on this exact key — one-shot semantics mean only the NEWEST registration stays live, so a stale earlier wait can no longer fire a duplicate/late TIMEOUT wake.`,
                }
              : {}),
            ...(args.fromMsg ? { resolved_from_msg: args.fromMsg } : {}),
            ...(patternAwait ? { pattern: true } : {}),
            ...(patternScope
              ? {
                  pattern_spans_multiple_keys: true,
                  pattern_matched_keys: patternScope.matchedKeys,
                  pattern_spans_multiple_keys_advice:
                    `SCOPE CHECK — "${eventKey}" already matches ${patternScope.matchedKeys.length}` +
                    `${patternScope.truncated ? '+' : ''} DISTINCT keys that have really fired here: ` +
                    `${patternScope.matchedKeys.slice(0, 8).join(', ')}` +
                    `${patternScope.matchedKeys.length > 8 ? ', …' : ''}. You will wake on the FIRST of ` +
                    `them to fire — which may not be the one you mean, and the wake will still say ` +
                    `satisfied:true. If you meant one specifically, await that exact key instead, or keep ` +
                    `the glob and add a payload_filter on the field that discriminates them. Registered ` +
                    `anyway — this is a warning, not a refusal, and cross-scope monitors are legitimate.`,
                }
              : {}),
            ...(announcedGate ? { announced_gate: announcedGate } : {}),
            ...(announcedGateOwnership
              ? {
                  announced_gate_ownership: {
                    declared_by_liveness: announcedGateOwnership.declaredByLiveness,
                    live_successor_ids: announcedGateOwnership.liveSuccessorIds,
                    ...(announcedGateOwnership.staleOwner ? { stale_owner: true } : {}),
                  },
                }
              : {}),
            ...(noKnownEmitterForAnnouncedGate
              ? {
                  no_known_emitter: true,
                  no_known_emitter_advice:
                    `The gate "${eventKey}" is DECLARED (by ${announcedGate?.announcedBy ?? 'someone'}) but matches no ` +
                    `catalogued emitter family and has never fired on this host. An announcement only proves someone ` +
                    `WANTS this key to fire — it does NOT guarantee anything ever will. Confirm the party who owns the ` +
                    `completion this gate represents will actually call events:emit on this EXACT key, or you may be ` +
                    `waiting forever.` +
                    (noKnownEmitterForAnnouncedGate.catalogNearMiss.length > 0
                      ? ` Possible near-miss catalogued key(s) — did you mean one of these instead? ${noKnownEmitterForAnnouncedGate.catalogNearMiss.join(', ')} (see events:catalog for their full templates).`
                      : ''),
                  ...(noKnownEmitterForAnnouncedGate.catalogNearMiss.length > 0
                    ? { catalog_near_miss: noKnownEmitterForAnnouncedGate.catalogNearMiss }
                    : {}),
                }
              : {}),
            ...(nearMiss
              ? {
                  near_miss: nearMiss,
                  near_miss_advice: `No declaration matches "${eventKey}" exactly, but a near-identical key is active: "${nearMiss[0].key}" (${nearMiss[0].kind}). If you meant that key, events:cancel this await and re-await it EXACTLY — normalized-near keys never rendezvous.`,
                }
              : {}),
            ...(unknownEventKey
              ? {
                  unknown_event_key: true,
                  unknown_event_key_advice: `NO KNOWN EMITTER for "${eventKey}" — it matches no family in events:catalog, no announced gate, and no key in its family ("${eventKey.split(':').slice(0, 2).join(':')}") has EVER fired on this host, so this await will most likely only TIME OUT. If you mistyped a key, events:cancel and re-await the exact one (events:catalog lists them). If a peer is meant to emit it, have them DECLARE it first (events:emit { announce:true }) and await the key it returns. Registered anyway — this is a warning, not a refusal.`,
                }
              : {}),
            // EI-18676056143796303: the key emits but is missing from the catalog.
            // Say so plainly — the await is FINE (do not cancel it); what is broken
            // is the registry, and naming the gap is what gets it registered instead
            // of re-teaching the next agent to distrust the orphan warning.
            ...(emitterEvidence
              ? {
                  uncatalogued_event_key: true,
                  uncatalogued_event_key_advice: `"${eventKey}" matches no family in events:catalog, BUT it has demonstrably fired before — ${emitterEvidence.exact ? 'this exact key has fired' : `${emitterEvidence.distinctKeys} key(s) in its family "${emitterEvidence.prefix}" have fired`}, ${emitterEvidence.fires} time(s) total, most recently ${emitterEvidence.lastFiredAt ?? 'unknown'}. So an emitter EXISTS and this await is fine — do NOT cancel it. The gap is in the catalog, not your await: the family is unregistered, which is a bug worth filing (it also means events:catalog cannot surface this key to anyone else).`,
                  emitter_evidence: emitterEvidence,
                }
              : {}),
            // WI-1632193 / EI-21666331086562886: matches no static family because
            // announced gates never do — but it is DECLARED, so the await is sound.
            // Distinct from `uncatalogued_event_key` above (that one means "it fired
            // but the family is unregistered — file a catalog bug"); here there is no
            // catalog bug to file, because a runtime-minted key has no family to add.
            ...(declaredAnnouncement
              ? {
                  declared_announced_gate: true,
                  declared_announced_gate_advice: `"${eventKey}" matches no family in events:catalog — an ANNOUNCED gate never does, because its key is minted at runtime from the announcer's scope — but it HAS been declared (${declaredAnnouncement.generations} declaration generation(s)${declaredAnnouncement.everFired ? ', and a previous generation has already fired' : ''}). This await is sound: do NOT cancel it, and do not file a catalog gap for it. To discover gates like this one, read the ANNOUNCED section of events:catalog rather than its family list — the family list deliberately describes only statically-emitted keys.`,
                }
              : {}),
            // EI-20268841604319803: armed on a service that is healthy RIGHT
            // NOW, so the unhealthy→healthy edge this key needs is not coming
            // unless the service first goes down AND the tick samples it.
            ...(serviceUpEdge
              ? {
                  service_up_edge_already_healthy: true,
                  service_up_edge_advice: buildServiceUpEdgeAdvice(serviceUpEdge.name, {
                    damped: serviceUpEdge.damped,
                  }),
                }
              : {}),
            ...(requiredParamPrefixMismatch
              ? {
                  family_prefix_missing_param: true,
                  family_prefix_missing_param_advice: `"${eventKey}" is the FAMILY PREFIX for '${requiredParamPrefixMismatch.family}' (template ${requiredParamPrefixMismatch.keyTemplate}), but its '${requiredParamPrefixMismatch.paramName}' param is REQUIRED — no emitter ever fires the bare key, so this await can only TIME OUT. Did you mean the parameterized key (fill in ${requiredParamPrefixMismatch.paramName}), or the glob form "${eventKey}:*" to wake on ANY instance? Registered anyway — this is a warning, not a refusal.`,
                }
              : {}),
            ...(zeroParamSuffix
              ? {
                  zero_param_family_suffix: true,
                  zero_param_family_suffix_advice: `"${eventKey}" appends a suffix to "${zeroParamSuffix.prefix}", but that family ('${zeroParamSuffix.entry.family}', template ${zeroParamSuffix.entry.keyTemplate}) declares NO key params — its emitter (${zeroParamSuffix.entry.emitter}) only ever fires the bare key "${zeroParamSuffix.prefix}". Nothing catalogued fires a suffixed form, so this await can only TIME OUT.${
                    zeroParamSuffix.entry.payloadFiltered
                      ? ` Scope it with payload_filter instead of in the key: await "${zeroParamSuffix.prefix}" and narrow on the payload (that is what this family is designed for).`
                      : ` Await the bare key "${zeroParamSuffix.prefix}" instead.`
                  } Registered anyway — this is a warning, not a refusal.`,
                }
              : {}),
            ...(autoScopedFrom
              ? {
                  auto_scoped_payload_filter: true,
                  payload_filter: effectivePayloadFilter,
                  payload_filter_source: autoScopedFrom,
                  auto_scoped_payload_filter_advice: `EI-13846: no payload_filter was passed, so this "work-item:claimable" await was AUTOMATICALLY narrowed to your own ${autoScopedFrom.source} claim spec (${formatSpecRef(autoScopedFrom.specId, autoScopedFrom.revision)}) — it fires on items matching the claim-spec payload filter, not on every hive-wide release. Claimability floors (for example plan reservations, claim holds, assignments, and owner-action gates) are checked separately by scheduler:get_next, so a matching wake is only a hint and may still be a guaranteed miss; re-run scheduler:get_next after waking. Pass an explicit payload_filter to override.`,
                }
              : {}),
            ...(unscopedClaimableWarning
              ? {
                  unscoped_claimable_await: true,
                  unscoped_claimable_advice:
                    'EI-13846: no payload_filter was passed, and you have no claim spec that narrows over the claimable payload (id/kind/title/plan/tags/goal), so this await is UNSCOPED — it will wake you on EVERY hive-wide work-item:claimable emission, which fires constantly on a large board. If you are fleet-scoped, confirm scheduler:get_claim_spec narrows on one of those fields; otherwise pass an explicit payload_filter or expect frequent guaranteed-miss wakes.',
                }
              : {}),
            ...(autoScopedPipeline
              ? {
                  auto_scoped_payload_filter: true,
                  payload_filter: effectivePayloadFilter,
                  payload_filter_source: { source: 'pipeline' as const, pipeline: autoScopedPipeline },
                  auto_scoped_payload_filter_advice: `EI-19344528739076339: "${eventKey}" is emitted GLOBALLY by every co-hosted pipeline on this box (~13 of them), so awaiting it bare subscribes you to strangers' gates — it has produced a false "the gate is green" twice in one day. No payload_filter was passed, so this await was AUTOMATICALLY narrowed to { pipeline: "${autoScopedPipeline}" }, derived from THIS process's integration root exactly as the emitter derives it. Pass an explicit payload_filter to override, or await the pipeline-scoped key "${eventKey}:${autoScopedPipeline}" directly.${
                    eventKey === 'release:green'
                      ? ' ⚠ Note that even a correctly-scoped release:green does NOT by itself mean the tip is green: the same key also fires for a PARTIAL advance (longest green prefix, tip still red) with payload.partial=true + payload.redTip. Check `partial` before concluding the pipeline is deployable.'
                      : ''
                  }`,
                }
              : {}),
            ...(unscopedGateKeyWarning
              ? {
                  unscoped_gate_key_await: true,
                  unscoped_gate_key_advice: `EI-19344528739076339: "${eventKey}" is emitted GLOBALLY by every co-hosted pipeline on this box, so this await can be woken by an UNRELATED pipeline's gate — the failure mode is a confident, wrong "the gate is green". It was NOT auto-scoped because this process's own pipeline could not be resolved from PAPERCUSP_INTEGRATION_ROOT, and a filter narrowed on a guess would be worse than none (an await that can never match is a silent hang, not a noisy wake). Await the pipeline-scoped key "${eventKey}:<pipeline>" instead, or pass payload_filter { pipeline: { equals: "<pipeline>" } } explicitly. Registered anyway — this is a warning, not a refusal.`,
                }
              : {}),
            ...(patternAutoScopedPipeline
              ? {
                  auto_scoped_payload_filter: true,
                  payload_filter: effectivePayloadFilter,
                  payload_filter_source: { source: 'pipeline' as const, pipeline: patternAutoScopedPipeline },
                  auto_scoped_payload_filter_advice: `EI-19928976726540168: "${eventKey}" is a GLOB over the pipeline segment of a gate-verdict key that every co-hosted pipeline on this box emits, so awaiting it bare subscribes you to strangers' gates — it has already woken an agent on a foreign pipeline's verdict, payload-shape-identical to its own. No payload_filter was passed, so this await was AUTOMATICALLY narrowed to { pipeline: "${patternAutoScopedPipeline}" }, derived from THIS process's integration root exactly as the emitter derives it. Pass an explicit payload_filter to override, or await the pipeline-scoped key "${eventKey.slice(0, -1) + patternAutoScopedPipeline}" directly.`,
                }
              : {}),
            ...(patternUnscopedGateKeyWarning
              ? {
                  unscoped_gate_key_await: true,
                  unscoped_gate_key_advice: `EI-19928976726540168: "${eventKey}" is a GLOB over the pipeline segment of a gate-verdict key that every co-hosted pipeline on this box emits, so this await can be woken by an UNRELATED pipeline's gate — the failure mode is a confident, wrong "the gate is green/red". It was NOT auto-scoped because this process's own pipeline could not be resolved from PAPERCUSP_INTEGRATION_ROOT, and a filter narrowed on a guess would be worse than none (an await that can never match is a silent hang, not a noisy wake). Await the pipeline-scoped key "${eventKey.slice(0, -1)}<pipeline>" instead, or pass payload_filter { pipeline: { equals: "<pipeline>" } } explicitly. Registered anyway — this is a warning, not a refusal.`,
                }
              : {}),
            expires_ts: row.expiresTs,
            on_timeout: row.timeoutBehavior,
            wake_handle: handleNote,
            ...(operationalBrief ? { operational_brief: operationalBrief } : {}),
            ...(acceptancePlaneAdvisory ? { acceptance_plane_advisory: acceptancePlaneAdvisory } : {}),
            ...(mainWaitPlanReview ? { main_wait_plan_review: mainWaitPlanReview } : {}),
            advice: patternAwait
              ? `Registered a PATTERN await on "${row.eventKey}". End your turn now — you will be re-invoked when the FIRST matching key fires (or at the deadline). It is one-shot: re-register if you need to wake on the next match too. Do not poll.`
              : 'Registered. End your turn now — you will be re-invoked when the event fires (or at the deadline). Do not poll.',
          }),
        },
      ],
    };
  },
});
