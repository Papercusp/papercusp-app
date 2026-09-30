/**
 * work_items:set_state — Lifecycle (D-003). Sets the UNIFIED lifecycle state for BOTH
 * families (work-item-status-full-unify P-003 writer-flip): open|wip|blocked|needs-human|
 * done|dropped. Legacy per-family spellings (feature passed/deprecated/todo/…, issue
 * resolved/closed) still fold to unified via the alias maps, preserving the passed/resolved
 * vs deprecated/closed nuance in work_items.terminal_reason.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): set ONE inline
 * ({ id, state }), MANY to the SAME state (ids:[…] + state), or MANY heterogeneous
 * (items:[{ id, state, harness?, decision? }]) → { ok, results:[{ ok, id, workItem?
 * | error }], counts }. The P-114 arm tripwire is evaluated PER item; the
 * plan-item reflect + rationale-reproject reactions fire per item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getWorkItem, setWorkItemStateWithAliasInfo, type TerminalCompletionConflict } from '../../work-items';
import { resolvePlanItemStamp } from '../../scheduler/plan-item-lane-guard';
// From the LEAF module, not '../../work-items': unit tests here mock that module
// wholesale, which would make the guard `undefined` at exactly this call site.
import { harnessScopeMismatch } from '../../work-items-harness-scope';
import { planWorkItemArm, commitWorkItemArm } from './arm-reversible-work-item';
import { runBulk, bulkContent } from '../_bulk';
import { toolReachabilityHint } from '../_tool-reachability';
import {
  assumptionsArg,
  hasAssumptionDeclaration,
  normalizePersistedAssumptionDeclaration,
  resolveDeclaredAssumptions,
  ASSUMPTIONS_REQUIRED_MESSAGE,
  TERMINAL_CLOSE_RECOVERY_HINT,
} from './_assumptions';
import {
  completionRefAliasFields,
  rejectCompletionRefAliasConflict,
  rejectNonTerminalCompletionAlias,
  resolveCompletionRefAlias,
} from './_completion-ref-alias';
import { nonAssumptionKindAdvisory } from '../../agent-facts/assumptions';
import {
  TERMINAL_INPUT_STATES,
  NON_TERMINAL_INPUT_STATES,
  isTerminalStateInput,
} from '../../work-item-dispatch-states';
import {
  isPlaneGapItem,
  preflightPlaneCloseLive,
  renderPlaneClosePreflightWarning,
} from '../../agent-plane-close-preflight';
import { activeExternalBlockers } from '../../external-blockers';

/**
 * Keep the batch-level refusal diagnosis bounded and stable. Per-item errors remain
 * unchanged for correlation/detail; this summary is the compact signal that survives
 * the result door when a large batch spills. `other` intentionally includes not-found,
 * plan-lane, and future refusal text until a new stable category is added here.
 */
// `ok` is DERIVED from counts.failed (see packages/agent-mcp/src/_bulk.ts runBulk),
// so this constraint must accept a FAILED envelope too. It previously read `ok: true`,
// which was the same "the type cannot express failure" defect as the hard-coded
// producer — it just happened to sit on the consumer side (EI-23737206446729041).
function addRefusalSummary<T extends { ok: boolean; results: Array<{ ok: boolean; error?: unknown }>; counts: { ok: number; failed: number } }>(
  env: T,
): T {
  if (env.counts.failed === 0) return env;
  let remoteAuthored = 0;
  let other = 0;
  for (const result of env.results) {
    if (result.ok) continue;
    if (typeof result.error === 'string' && result.error.includes('remote-authored')) remoteAuthored += 1;
    else other += 1;
  }
  return {
    ...env,
    counts: {
      ...env.counts,
      refusals: { 'remote-authored': remoteAuthored, other },
    },
  } as T;
}

// P-114: an AUTONOMOUS agent declares the action's risk/authority so the auto-revert
// tripwire arms faithfully to the upstream decision (the verb has no inherent item
// risk). Absent ⇒ fail-safe `critical`. Ignored for human callers.
const decisionSpec = z.object({
  riskTier: z.enum(['trivial', 'low', 'moderate', 'high', 'critical']).optional(),
  authority: z.enum(['system', 'owner']).optional(),
});

/**
 * P-005 / D-006: the terminal-state evidence requirement is STRUCTURAL, not described.
 *
 * It used to live in `completionRef`'s .describe() ("REQUIRED alongside a terminal
 * state") while the schema said `.optional()` — precisely the IFEval-FC failure mode
 * this plan cites (models frequently miss format rules embedded in JSON-schema
 * descriptions; D-004: a rule that matters gets an enum or a validator, never a
 * sentence). `state` was worse still: a bare z.string().max(40), so the valid
 * vocabulary was prose too and a typo landed in a non-dispatchable limbo (the GAP-5
 * harm) rather than being rejected.
 *
 * Now a terminal write WITHOUT evidence is UNREPRESENTABLE: the discriminated union
 * renders as two distinct shapes in the generated tool schema, so the model SEES
 * that `done` requires completionRef and `wip` does not, instead of reading it.
 *
 * Both state sets are DERIVED in work-item-dispatch-states.ts from the alias map +
 * terminal sets — never hand-listed here, so a new alias cannot drift this gate away
 * from the runtime writer (the hand-copy drift that caused EI-18653071581558556).
 */
const asEnumValues = (v: readonly string[]) => v as unknown as [string, ...string[]];

/** Trim + lower-case ONLY, matching normalizeFeatureStateInput's own folding, so the
 *  union accepts exactly what the runtime writer already accepted (case drift like
 *  `DONE` keeps working — this gate adds structure, it does not narrow acceptance). */
const foldStateCase = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

const itemBase = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  decision: decisionSpec.optional(),
  // EI-19961538712475843: declared on BOTH union arms, not just the terminal one — the
  // schema is strict, so an undeclared key is rejected at parse time and would preempt
  // the targeted non-terminal message with a generic "Unrecognized key".
  ...completionRefAliasFields,
  force: z
    .boolean()
    .optional()
    .describe(
      'EI-7422: required to REOPEN an item that already carries a terminal completion (terminalOwner + terminalCompletionRef) — without it the write is REJECTED rather than silently discarding a peer\'s completion. Only needed when the target is already terminal AND you are deliberately reopening it.',
    ),
});

const terminalItem = itemBase.extend({
  state: z.preprocess(foldStateCase, z.enum(asEnumValues(TERMINAL_INPUT_STATES))),
  // EI-19961538712475843: `.optional()` ONLY because `reason`/`note` are accepted as
  // aliases for the same field (see ./_completion-ref-alias). The requirement itself is
  // unchanged and is re-closed by the superRefine below, which reads whichever spelling
  // the caller used — so this branch still cannot go terminal without evidence.
  completionRef: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      'REQUIRED for this terminal state — completion evidence (summary / commit / coord or plan-item ref). Prefer work_items:complete for a structured completion record.',
    ),
  // P-017 (b) gate #2 / D-016 / D-050: `assumptions` joins the SAME terminal branch
  // that already carries `completionRef`, so BOTH requirements render in the one
  // schema shape the model sees — evidence for the claim, and the assumptions the
  // claim rests on. Non-terminal writes carry neither field at all.
  assumptions: z.preprocess(normalizePersistedAssumptionDeclaration, assumptionsArg),
}).superRefine((it, ctx) => {
  rejectCompletionRefAliasConflict(it, ctx);
  if (resolveCompletionRefAlias(it) === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completionRef'],
      message:
        'a terminal state requires completion evidence — pass `completionRef` (or its `reason` / `note` alias), or (preferred) use work_items:complete for a structured completion record',
    });
  }
});

const nonTerminalItem = itemBase
  .extend({
    state: z.preprocess(foldStateCase, z.enum(asEnumValues(NON_TERMINAL_INPUT_STATES))),
  })
  .superRefine((it, ctx) => {
    rejectNonTerminalCompletionAlias(it, it.state, ctx);
  });

const itemSpec = z.union([terminalItem, nonTerminalItem]);

export default defineTool({
  name: 'work_items:set_state',
  profile: 'engineer',
  description:
    'Set lifecycle state for one or many work-items. Unified states: open|wip|blocked|needs-human|done|dropped; legacy aliases preserve terminal_reason. Terminal states require completionRef + assumptions ("none" or facts:assert keys). Blocked writes require an active typed external blocker via work_items:set_blocker; link internal dependencies with work_items:link { rel:"blocks" }. Plan-linked feature blocks use plans:set-status. Reopening a terminal item requires force:true. Supports inline, ids:[…], or items[]; inspect appliedState.',
  guidance: {
    when: `Use for lifecycle changes. Prefer work_items:complete for terminal evidence. Batch with ids:[…] or items[]. For blocked, first use work_items:set_blocker (event/gate/runtime/human) or work_items:link { rel:"blocks" }; bare blocked is refused. Plan-linked feature blocks use plans:set-status. Before \`force:true\`, read terminalOwner/ref. ${TERMINAL_CLOSE_RECOVERY_HINT}`,
    chaining: 'work_items:claim → work_items:set_blocker or work_items:link → work_items:set_state; terminal writes use completionRef + assumptions.',
    seeAlso: [
      'work_items:complete (terminal state WITH a structured completion record)',
      'work_items:set_blocker { id, kind, ref, summary } (typed external event/gate/runtime/human blocker)',
      'work_items:link { source, target, rel:"blocks" } (internal work-item dependency)',
      'plans:set-status { item, status:"blocked" } (the source-of-truth park for plan-linked feature items)',
      'work_items:release (drop a claim without changing state; claimHold:true parks an issue-family item out of claim_next self-select — WI-2797)',
      'work_items:set_priority (steer backlog order, not lifecycle state)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the work-item id (use with `state`)'),
      state: z
        .preprocess(foldStateCase, z.enum(asEnumValues([...TERMINAL_INPUT_STATES, ...NON_TERMINAL_INPUT_STATES])))
        .optional()
        .describe('the lifecycle state applied to the inline id / every id in `ids` — a terminal state REQUIRES `completionRef`'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
      decision: decisionSpec.optional().describe('P-114 risk/authority for the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('set MANY items to the same `state` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('set many work-items at once — each { id, state, harness?, decision?, completionRef? }'),
      completionRef: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe('completion evidence applied to the inline id / every id in `ids` (see itemSpec.completionRef)'),
      // EI-19961538712475843 — see ./_completion-ref-alias for why `reason`/`note` are
      // accepted here and refused on a non-terminal write.
      ...completionRefAliasFields,
      // P-017 (b) gate #2: `.optional()` ONLY because an items[]-only call carries its
      // own per-item value. The requirement for the inline / ids[] shorthand is closed
      // by the refine below — without it the gate would MOVE to the shorthand, which is
      // the cheaper call and would therefore carry all the traffic.
      assumptions: z
        .preprocess(normalizePersistedAssumptionDeclaration, assumptionsArg.optional())
        .describe('assumption declaration applied to the inline id / every id in `ids` (see itemSpec.assumptions)'),
      force: z
        .boolean()
        .optional()
        .describe('applied to the inline id / every id in `ids` (see itemSpec.force) — required to reopen an already-terminally-completed item'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.state) && ((a.ids?.length ?? 0) > 0 || Boolean(a.id))), {
      message: 'pass { id, state } for one, { ids:[…], state } for many of the same state, or items:[{ id, state }] for many',
    })
    // P-005: the SAME structural rule the items[] union enforces, applied to the
    // inline / ids[] shape. itemSpec's union cannot cover these — `state` and
    // `completionRef` live at the top level there — so without this the evidence
    // requirement would simply MOVE to the shorthand rather than being closed.
    // EI-19961538712475843: reads whichever spelling the caller used, so the evidence
    // requirement is unchanged — `reason`/`note` satisfy it exactly as `completionRef`
    // does, and none of the three satisfies it when all are absent.
    .refine((a) => !(a.state && isTerminalStateInput(a.state) && !resolveCompletionRefAlias(a)), {
      path: ['completionRef'],
      message:
        'a terminal state requires completion evidence — pass `completionRef` (or its `reason` / `note` alias), or (preferred) use work_items:complete for a structured completion record',
    })
    // P-017 (b) gate #2 / D-050 — the SAME structural rule terminalItem enforces for
    // items[], applied to the inline / ids[] shape, exactly as the completionRef refine
    // above does for evidence. Two separate refines rather than one so a caller missing
    // both fields is told about both, not just whichever check ran first.
    .refine((a) => !(a.state && isTerminalStateInput(a.state) && !hasAssumptionDeclaration(a.assumptions)), {
      path: ['assumptions'],
      message: ASSUMPTIONS_REQUIRED_MESSAGE,
    })
    // EI-19961538712475843: the SAME alias rules the items[] union arms enforce, applied
    // to the inline / ids[] shape — without this the alias would be silently accepted and
    // dropped on a non-terminal shorthand write, which is the bug, not the fix.
    .superRefine((a, ctx) => {
      rejectCompletionRefAliasConflict(a, ctx);
      if (a.state && !isTerminalStateInput(a.state)) {
        rejectNonTerminalCompletionAlias(a, a.state, ctx);
      }
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // P-005: itemSpec is now a UNION (terminal carries a required completionRef;
    // non-terminal has no such field at all), so flatten to one uniform shape here
    // — every downstream reader keeps its single `it.completionRef` access.
    const list = args.items?.length
      ? args.items.map((it) => ({
          id: it.id,
          state: it.state as string,
          harness: it.harness,
          decision: it.decision,
          force: it.force,
          // EI-19961538712475843: resolve the alias HERE, at the one place the three
          // spellings collapse into the single value every downstream reader consumes —
          // so `it.completionRef` keeps meaning exactly what it meant before. The fields
          // are now listed explicitly rather than spread: `...it` would carry `reason`
          // and `note` PAST this point, leaving two live spellings of a field that has
          // already been resolved, and it made this branch's shape diverge from the
          // ids[] / inline ones below.
          completionRef: resolveCompletionRefAlias(it),
          // P-008 (d): flattened exactly like `completionRef` above — the union's
          // terminal arm carries it, the non-terminal arm has no such field.
          assumptions: 'assumptions' in it ? it.assumptions : undefined,
        }))
        : args.ids?.length
        ? args.ids.map((id) => ({ id, state: args.state as string, harness: args.harness, decision: args.decision, completionRef: resolveCompletionRefAlias(args), assumptions: args.assumptions, force: args.force }))
        : [{ id: args.id as string, state: args.state as string, harness: args.harness, decision: args.decision, completionRef: resolveCompletionRefAlias(args), assumptions: args.assumptions, force: args.force }];
    const env = await runBulk(
      list,
      async (it) => {
        const harness = it.harness ?? args.harness;
        if (String(it.state).trim().toLowerCase() === 'blocked') {
          const current = await getWorkItem(it.id, harness);
          if (current) {
            const planStamp = await resolvePlanItemStamp(current);
            if (planStamp) {
              const itemIds = planStamp.item_ids.join(', ');
              throw new Error(
                `work-item '${it.id}' is linked to plan item(s) ${planStamp.plan_slug}#${itemIds}; ` +
                  'direct state:"blocked" writes are not durable because the plan item is the source of truth. ' +
                  `Use plans:set-status { slug: "${planStamp.plan_slug}", item: "${planStamp.item_ids[0]}", status: "blocked" } instead.`,
              );
            }
            if (activeExternalBlockers(current.payload).length === 0) {
              throw new Error(
                `work-item '${it.id}' has no active typed blocker; refusing a reasonless state:"blocked" write. ` +
                  'For an external event, gate, runtime condition, or human capability, use ' +
                  'work_items:set_blocker { id, kind, capability, ref, summary, nextVerb } — it records the ' +
                  'machine-readable reason and parks the lifecycle. For another work-item dependency, use ' +
                  'work_items:link { source: "<blocker-id>", target: "' + it.id + '", rel: "blocks" } instead; ' +
                  'do not write blocked state separately for a linked work dependency. ' +
                  // EI-21655300007082004: naming the verb is not the same as delivering it. On a
                  // trimmed client surface work_items:set_blocker does not resolve through a
                  // client-side tool lookup, so a caller reads this refusal as directing them to a
                  // tool that does not exist and has nowhere to go. Name the route too.
                  toolReachabilityHint('work_items:set_blocker'),
              );
            }
          }
        }
        // P-114 arm-call-site: gate-FIRST (before the mutation) so the captured prior-state
        // handle is faithful; best-effort (never fails the verb); null on the common path.
        const armPlan = await planWorkItemArm(
          ctx,
          'work_items:set_state',
          'state',
          it.id,
          harness,
          it.decision,
        ).catch(() => null);
        // EI-7712 (extends EI-7125/WI-2573): ALWAYS report the alias/no-op discriminator —
        // requestedState/appliedState/aliased on every result row, not just when the
        // normalize-layer onAlias fires — so a careless caller reading `ok` alone can no
        // longer be told ok:true for a write that landed somewhere other than what it asked
        // (the WI-2381 incident: set_state->blocked returned ok:true, state silently stayed
        // 'open', discovered only by an unrelated list read 10min later).
        // P-008 (d) / D-050 / D-079: resolve the declared assumptions BEFORE the
        // mutation, so a dangling reference refuses the close instead of being
        // discovered after the item has already left the queue. Only a terminal
        // write carries a declaration — a non-terminal state removes nobody's
        // ability to check you, which is D-050's whole definition of the class.
        const assumptions = isTerminalStateInput(it.state) && it.assumptions
          ? await resolveDeclaredAssumptions({
              declared: it.assumptions,
              workItemId: it.id,
              ownerId: ident.ownerId,
              harnessSlug: harness,
            })
          : undefined;
        // EI-19298742806956600: WARN-ONLY — see nonAssumptionKindAdvisory's header.
        // Never refuses; mirrors the planeRatchetWarning pattern below.
        const assumptionKindWarning =
          assumptions && Array.isArray(assumptions.declared)
            ? nonAssumptionKindAdvisory(assumptions.declared)
            : undefined;
        // EI-18850142725126359 fix #4 — the SAME plane-ratchet pre-flight
        // work_items:complete runs. Wired here too because this verb is the other
        // way to make a row terminal: a guard that lives on only one of the two
        // close paths is a guard with a documented bypass, and the bypass is the
        // one an agent reaches for when the other path just refused them.
        // Computed BEFORE the mutation (so the baseline still sees the item open)
        // and fail-open (a guard fault never fails the state write).
        let planeRatchetWarning: string | undefined;
        if (isTerminalStateInput(it.state) && isPlaneGapItem(it.id)) {
          try {
            const verdict = await preflightPlaneCloseLive({ closingIds: [it.id], workspaceId: ctx.workspaceId });
            if (verdict) planeRatchetWarning = renderPlaneClosePreflightWarning(verdict);
          } catch {
            /* fail-open */
          }
        }
        // WI-2142258 / EI-22177453452277846: a terminal write here can land on a row a
        // DIFFERENT actor already closed (most commonly system:plan-item-reconcile racing
        // ahead of a caller who resolved the "would race ahead of that plan gate" refusal by
        // flipping the plan item first — see reconcile-linked-work-items.ts). setWorkItemState
        // ALREADY computes the full attested/upgraded diagnosis for that case (the same
        // `onTerminalConflict` callback work_items:complete wires at complete.ts:3037/3106) —
        // this tool simply never listened for it, so a caller who got back `ok:true` had no
        // way to learn their evidence was filed as a second attestation
        // (payload._completionAttestations) rather than installed as the row's completion
        // record. Wire it the same way complete.ts does, and surface it the same way
        // (`terminalConflictWarning` + raw `terminalConflict`) so the two tools do not disagree
        // about whether a stranded close is visible to the caller.
        let terminalConflict: TerminalCompletionConflict | undefined;
        const { workItem, aliased, requestedState, appliedState, aliasNote } =
          await setWorkItemStateWithAliasInfo(it.id, it.state, {
            harness,
            by: ident.ownerId,
            completionRef: it.completionRef,
            assumptions,
            force: it.force,
            onTerminalConflict: (info) => {
              terminalConflict = info;
            },
          });
        if (armPlan && workItem) await commitWorkItemArm(armPlan).catch(() => {});
        // EI-19393623437103599 — the SAME cross-harness retarget warning work_items:complete
        // carries, wired here for the reason stated in fix #4 above: this verb is the other
        // way to make a row terminal, and a guard on only one close path is a guard with a
        // documented bypass.
        //
        // `getWorkItem` does not apply `harness` to the issue-family branch, so naming a
        // harness does not scope the lookup — an id minted against one store can resolve
        // onto a DIFFERENT pot's row of the same id. `WI-<n>` ids make that reachable in
        // practice: D-008 (migration 142) mints them from a per-database sequence starting
        // at 1, so WI-1/WI-2/WI-3 exist in every long-lived store. Observed 2026-08-03: a
        // `WI-1` from a recovered store resolved onto an unrelated 2026-07-18 plan item and
        // a terminal close landed on it, silently.
        //
        // Computed from the row the write actually returned, and warn-only (never fails the
        // write) — mirroring planeRatchetWarning/assumptionKindWarning above. Deliberately
        // NOT gated to terminal states: a state write aimed at the wrong item is wrong at
        // any state, and the caller needs to know it hit something they did not mean.
        const harnessMismatch = workItem ? harnessScopeMismatch(workItem, harness) : null;
        const harnessMismatchWarning = harnessMismatch
          ? `set_state on '${it.id}' was scoped to harness '${harnessMismatch.requested}', but the row ` +
            `that resolved belongs to harness '${harnessMismatch.resolved}' — titled "${workItem?.title}". ` +
            `A bare WI-<n> id is NOT globally unique (it comes from a per-database sequence that starts ` +
            `at 1), so an id minted in one store can resolve to a different item in another. If that ` +
            `title is not the item you meant, you have just written state onto someone else's work.`
          : undefined;
        return workItem
          ? {
              ok: true as const,
              id: it.id,
              // Ahead of the echoed `workItem` row for the same EI-15982 reason as the
              // warnings below: this is the field a caller must not lose to tail truncation.
              ...(harnessMismatchWarning ? { harnessMismatchWarning } : {}),
              // WI-2142258 — same field name/shape work_items:complete already returns
              // (complete.ts), so a caller (or a doc) does not have to learn two spellings
              // of "your evidence didn't win" depending on which tool it called.
              ...(terminalConflict
                ? {
                    terminalConflictWarning:
                      terminalConflict.outcome === 'attested'
                        ? `COMPLETION RECORDED AS A SECOND ATTESTATION, NOT AS THIS ITEM'S RECORD — ${terminalConflict.note}`
                        : `YOUR COMPLETION REPLACED AN EARLIER, THINNER ONE — ${terminalConflict.note}`,
                    terminalConflict,
                  }
                : {}),
              // Ahead of the echoed `workItem` row: the per-result context door
              // truncates from the tail, and this is the field a caller must not
              // lose (EI-15982). Only when the write actually landed terminal —
              // the warning is future-tense about a gate red that a no-op write
              // will not cause.
              ...(planeRatchetWarning && isTerminalStateInput(String(appliedState ?? ''))
                ? { planeRatchetWarning }
                : {}),
              ...(assumptionKindWarning && isTerminalStateInput(String(appliedState ?? ''))
                ? { assumptionKindWarning }
                : {}),
              workItem,
              aliased,
              requestedState,
              appliedState,
              ...(aliasNote ? { aliasNote } : {}),
            }
          : { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(addRefusalSummary(env));
  },
});
