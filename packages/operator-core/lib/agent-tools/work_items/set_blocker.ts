/**
 * work_items:set_blocker — typed non-work-item dependencies.
 *
 * Internal work dependencies remain `work_items:link { rel:'blocks' }` (and plan
 * `blocked-by`) so their history/graph semantics stay intact. This surface is
 * specifically for conditions that are not work-items: events, gates, runtime
 * state, and human decisions. Clearing marks history; it never deletes it.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { runBulk, bulkContent } from '../_bulk';
import { getModes } from '../../modes/store';
import { modeImpliesAutonomy } from '../../modes/registry';
import {
  getWorkItem,
  mergeWorkItemPayload,
  setWorkItemClaimHold,
  setWorkItemStateWithAliasInfo,
} from '../../work-items';
import {
  activeExternalBlockers,
  applyExternalBlockerUpdate,
  externalBlockerCapabilityPolicy,
  EXTERNAL_BLOCKER_CAPABILITIES,
  readExternalBlockers,
  type ExternalBlockerCapability,
  type ExternalBlockerKind,
} from '../../external-blockers';
import { lookupWorkItem } from './_lookup';
import { isStrictOwnerActionCapability } from '../../harness/improvements/agent-review-policy';
import { stagingFirstBlockerProblem } from '../plans/staging-first-activation-guard';
import { workItemRefBlockerProblem } from './work-item-ref-blocker-guard';

// Older callers used the missing capability as `kind` (for example,
// `kind:'credential'`). Keep accepting those inputs at the tool boundary, but
// normalize them to the canonical trigger/capability split before persistence.
const BLOCKER_KIND = z.enum([
  'event',
  'gate',
  'runtime',
  'human',
  'credential',
  'physical-device',
  'external-service-action',
  'product-decision',
  'approval-auto-clearable',
]);
const BLOCKER_CAPABILITY = z.enum(EXTERNAL_BLOCKER_CAPABILITIES);
type BlockerKindInput = z.infer<typeof BLOCKER_KIND>;
type BlockerCapabilityInput = z.infer<typeof BLOCKER_CAPABILITY>;
type BlockerInput = {
  id: string;
  kind?: BlockerKindInput;
  capability?: BlockerCapabilityInput;
  ref?: string;
  summary?: string;
  evidence?: string;
  nextVerb?: string;
  clear?: boolean;
  harness?: string;
};
type NormalizedBlockerInput = Omit<BlockerInput, 'kind'> & { kind?: ExternalBlockerKind };
const CAPABILITY_KIND_ALIASES = {
  credential: { kind: 'human', capability: 'credential' },
  'physical-device': { kind: 'human', capability: 'physical-device' },
  'external-service-action': { kind: 'human', capability: 'external-service-action' },
  'product-decision': { kind: 'human', capability: 'product-decision' },
  'approval-auto-clearable': { kind: 'human', capability: 'approval-auto-clearable' },
} as const satisfies Record<string, { kind: ExternalBlockerKind; capability: ExternalBlockerCapability }>;

function validateCapabilityKindAlias(
  value: { kind?: BlockerKindInput; capability?: BlockerCapabilityInput },
  ctx: z.RefinementCtx,
) {
  const alias = value.kind ? CAPABILITY_KIND_ALIASES[value.kind as keyof typeof CAPABILITY_KIND_ALIASES] : undefined;
  if (alias && value.capability && value.capability !== alias.capability) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: `kind '${value.kind}' is a shorthand for capability '${alias.capability}' and cannot be combined with capability '${value.capability}'`,
    });
  }
}

function normalizeBlockerInput(input: BlockerInput): NormalizedBlockerInput {
  const alias = input.kind ? CAPABILITY_KIND_ALIASES[input.kind as keyof typeof CAPABILITY_KIND_ALIASES] : undefined;
  if (!alias) return { ...input, kind: input.kind as ExternalBlockerKind | undefined };
  return {
    ...input,
    kind: alias.kind,
    capability: input.capability ?? alias.capability,
  };
}

const fields = {
  kind: BLOCKER_KIND.optional(),
  capability: BLOCKER_CAPABILITY.optional(),
  ref: z.string().min(1).max(300).optional(),
  summary: z.string().max(1000).optional(),
  evidence: z.string().max(4000).optional(),
  nextVerb: z.string().max(300).optional(),
  clear: z.boolean().optional(),
  harness: z.string().max(80).optional(),
};
const itemSpec = z
  .object({ id: z.string().min(1), ...fields })
  .strict()
  .superRefine(validateCapabilityKindAlias);

const TERMINAL = new Set(['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']);

export default defineTool({
  name: 'work_items:set_blocker',
  profile: 'engineer',
  description:
    "Set or clear a TYPED external blocker on one or many work-items — a condition that is NOT a work-item: an event, a gate, runtime state, or a human capability. `kind` names the trigger shape; `capability` names what is actually missing. Capability shorthands (kind:'credential') normalize to kind:'human', capability:'credential'. Pass capability whenever you know it: authority alone cannot fabricate a credential, a physical device, or an external-service action. clear:true PRESERVES history.",
  guidance: {
    // P-011: response documentation lives here, not in `description` — `returns` is not
    // counted against the 1500-char prompt-weight budget and is demand-loaded via
    // tools:find instead of baked into every system prompt (the WI-9334 pattern).
    returns:
      'activeBlockers (the rows still holding this item), capabilityDispositions (what to await/obtain per capability; under AUTO/DRAIN a standing approval is history-cleared rather than parking the item), and lifecycle. Clearing the LAST blocker returns a feature blocked→todo, or drops the issue-family claim hold. Internal work-item dependencies are not represented here — those stay in work_items:link{rel:\'blocks\'} and plan blocked-by.',
    when: 'Work cannot proceed until a named event fires, a gate changes, runtime/external state becomes ready, or a human capability becomes available. Omitted legacy rows infer live-dependency, human rows product-decision. Use a stable ref and name the concrete nextVerb when one exists.',
    notWhen:
      "Another work-item must finish first — use work_items:link with rel:'blocks' (blocker id as source). A vague concern with no actual stop condition is a comment, not a blocker. Do not block ordinary implementation on main/:3070/green-checkpoint — staging/current-build is the acceptance plane; only final shipment or a named deployed-only property waits on the release plane.",
    chaining:
      'work_items:set_blocker {id,kind,capability,ref,…} → follow the returned capabilityDisposition → work_items:set_blocker {id,ref,clear:true,evidence}. A clear-only call may omit ref when the item has one matching active blocker; pass ref (and kind when reused) if the request is ambiguous.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  // This handler only performs independent work-item/mode operations and never
  // reads ctx.tx. Do not hold an ambient workspace transaction while those
  // operations wait on the database; tools:invoke callers otherwise consume a
  // pool slot for the whole handler lifetime.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional(),
      kind: BLOCKER_KIND.optional(),
      capability: BLOCKER_CAPABILITY.optional(),
      ref: z.string().min(1).max(300).optional(),
      summary: z.string().max(1000).optional(),
      evidence: z.string().max(4000).optional(),
      nextVerb: z.string().max(300).optional(),
      clear: z.boolean().optional(),
      harness: z.string().max(80).optional(),
      items: z.array(itemSpec).min(1).max(100).optional(),
    })
    .strict()
    .refine(
      (args) =>
        (args.items?.length ?? 0) > 0 ||
        (Boolean(args.id) && (Boolean(args.ref) || args.clear === true)),
      {
        message:
          'pass { id, ref, kind?, summary? } for one, or items:[{ id, ref, kind?, … }]; clear:true may omit ref when one active blocker matches',
      },
    )
    .superRefine((args, ctx) => {
      validateCapabilityKindAlias(args, ctx);
      if (!args.items?.length) return;
      for (const [index, item] of args.items.entries()) {
        if (!item.clear && !item.ref) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'ref'],
            message: 'ref is required when setting a blocker',
          });
        }
      }
    })
    .refine((args) => (args.items?.length ?? 0) > 0 || Boolean(args.kind) || args.clear === true, {
      message: 'kind is required when setting a blocker; clear:true may infer kind from ref',
    })
    .superRefine((args, ctx) => {
      if (!args.items?.length) return;
      for (const [index, item] of args.items.entries()) {
        if (!item.kind && item.clear !== true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'kind'],
            message: 'kind is required when setting a blocker; clear:true may infer kind from ref',
          });
        }
      }
    }),
  result: z
    .object({
      rel: z.string().optional(),
      ok: z.boolean().optional(),
      id: z.string().optional(),
      activeBlockers: z.array(z.unknown()).optional(),
      capabilityDispositions: z.unknown().optional(),
      lifecycle: z.unknown().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const rawItems: BlockerInput[] = args.items?.length
      ? args.items
      : [
          {
            id: args.id as string,
            kind: args.kind as ExternalBlockerKind,
            capability: args.capability,
            ref: args.ref as string,
            summary: args.summary,
            evidence: args.evidence,
            nextVerb: args.nextVerb,
            clear: args.clear,
            harness: args.harness,
          },
        ];
    const items: NormalizedBlockerInput[] = rawItems.map(normalizeBlockerInput);
    const wantsAutoAuthority = items.some((input) => !input.clear && input.capability === 'approval-auto-clearable');
    let autoAuthority = false;
    if (wantsAutoAuthority) {
      try {
        const modes = await getModes(identity.workspaceId ?? 'default', identity.ownerId);
        autoAuthority = modes.some((row) => modeImpliesAutonomy(row.mode));
      } catch {
        // Fail closed: a mode-read outage must never fabricate approval.
      }
    }
    const env = await runBulk(
      items,
      async (input) => {
        const workItem = await getWorkItem(input.id, input.harness);
        if (!workItem) return { ok: false as const, id: input.id, error: `work_item '${input.id}' not found` };
        if (!input.clear && TERMINAL.has(workItem.state.toLowerCase())) {
          return {
            ok: false as const,
            id: input.id,
            error: `work_item '${input.id}' is already terminal ('${workItem.state}') — reopen it explicitly before adding an active blocker`,
          };
        }
        if (!input.clear) {
          if (!input.ref) {
            return {
              ok: false as const,
              id: input.id,
              error: `work_item '${input.id}' blocker ref is required when setting a blocker. Blocker was not written.`,
            };
          }
          // WI-2141488: a bare work-item id here is inert — no event key, nothing
          // to await, nothing to clear — so the row would wait forever. Refuse at
          // the write; `clear` is deliberately exempt so rows already carrying a
          // bad ref stay clearable.
          const workItemRef = workItemRefBlockerProblem({ itemId: input.id, ref: input.ref });
          if (workItemRef) {
            return {
              ok: false as const,
              id: input.id,
              error: `${workItemRef.detail} Blocker was not written.`,
              code: workItemRef.code,
            };
          }
          const stagingFirst = stagingFirstBlockerProblem({
            itemId: input.id,
            itemText: `${workItem.title ?? ''}\n${workItem.summary ?? ''}`,
            // The staging-first guard classifies dependency semantics, not the
            // caller's provenance note. In particular, evidence commonly names
            // both :3170 and :3070 to say which runtime was measured; feeding
            // that note into the release-plane matcher turns an unrelated gate
            // blocker into a false non-final deployment wait.
            blockerText: [input.ref, input.nextVerb].filter(Boolean).join('\n'),
            // ...but the caller's summary/evidence IS where the refusal tells them to
            // name the deployed-only property, so the narrow exception (and only it)
            // reads them (EI-24018845641231261).
            exceptionText: [input.summary, input.evidence].filter(Boolean).join('\n'),
            kind: input.kind ?? '',
          });
          if (stagingFirst) {
            return {
              ok: false as const,
              id: input.id,
              error: `${stagingFirst.detail} Blocker was not written; use staging/current-build for this work item.`,
              code: stagingFirst.code,
            };
          }
        }
        const strictHumanAsk =
          !input.clear && input.kind === 'human' && isStrictOwnerActionCapability(input.capability);
        if (strictHumanAsk && (!input.summary?.trim() || !input.nextVerb?.trim())) {
          return {
            ok: false as const,
            id: input.id,
            error:
              `work_item '${input.id}' owner-capability blocker rejected — a structured ask requires both ` +
              '`summary` (the concrete question) and `nextVerb` (what action unblocks it).',
          };
        }
        if (strictHumanAsk) {
          // EI-13766 requirement 2: preflight plan truth BEFORE persisting the
          // blocker payload. The canonical lifecycle writer repeats this guard,
          // but discovering it only there would leave a half-written human
          // blocker behind after the state transition is rejected.
          const { planItemNeedsHumanContradiction } = await import('../../scheduler/plan-item-lane-guard');
          const contradiction = await planItemNeedsHumanContradiction(workItem).catch(() => null);
          if (contradiction) {
            return {
              ok: false as const,
              id: input.id,
              error:
                `work_item '${input.id}' owner-capability blocker rejected — ${contradiction.reason}. ` +
                'Update the plan item to needs-human first; no blocker was written.',
            };
          }
        }

        // A clear-only request may omit kind when the ref points to exactly one
        // active blocker. Keep the (kind, ref) identity strict when a ref is
        // reused across different blocker kinds, rather than clearing the wrong
        // dependency. The schema already rejects kind-less set requests; this
        // guard is defensive for callers that bypass parsing.
        let resolvedKind = input.kind;
        let resolvedRef = input.ref;
        if (input.clear && !resolvedRef) {
          const active = activeExternalBlockers(workItem.payload);
          const candidates = resolvedKind ? active.filter((blocker) => blocker.kind === resolvedKind) : active;
          if (candidates.length > 1) {
            const qualifier = resolvedKind ? ` of kind '${resolvedKind}'` : '';
            return {
              ok: false as const,
              id: input.id,
              error:
                `work_item '${input.id}' clear-only blocker request omitted ref but matches ${candidates.length} active blockers${qualifier}; ` +
                'pass ref explicitly',
            };
          }
          const candidate = candidates[0];
          if (!candidate) {
            return {
              ok: true as const,
              id: input.id,
              changed: false,
              workItem,
              activeBlockers: active,
              blockerHistory: readExternalBlockers(workItem.payload),
              capabilityDisposition: externalBlockerCapabilityPolicy(input.capability ?? 'live-dependency'),
              autoCleared: false,
            };
          }
          resolvedKind = candidate.kind;
          resolvedRef = candidate.ref;
        } else if (input.clear && !resolvedKind) {
          // A clear-only request with a ref may omit kind when the ref points to
          // exactly one active blocker. Keep the (kind, ref) identity strict when
          // a ref is reused across different blocker kinds.
          const matchingKinds = [
            ...new Set(
              activeExternalBlockers(workItem.payload)
                .filter((blocker) => blocker.ref === resolvedRef)
                .map((blocker) => blocker.kind),
            ),
          ];
          if (matchingKinds.length > 1) {
            return {
              ok: false as const,
              id: input.id,
              error:
                `work_item '${input.id}' clear-only blocker ref '${resolvedRef}' is ambiguous across kinds ` +
                `(${matchingKinds.join(', ')}); pass kind explicitly`,
            };
          }
          resolvedKind = matchingKinds[0];
          if (!resolvedKind) {
            return {
              ok: true as const,
              id: input.id,
              changed: false,
              workItem,
              activeBlockers: activeExternalBlockers(workItem.payload),
              blockerHistory: readExternalBlockers(workItem.payload),
              capabilityDisposition: externalBlockerCapabilityPolicy(input.capability ?? 'live-dependency'),
              autoCleared: false,
            };
          }
        }
        if (!resolvedKind || !resolvedRef) {
          return {
            ok: false as const,
            id: input.id,
            error: input.clear
              ? 'clear-only blocker requests need an active blocker ref to resolve'
              : 'kind and ref are required when setting a blocker',
          };
        }

        const history = applyExternalBlockerUpdate(
          workItem.payload,
          {
            kind: resolvedKind,
            capability: input.capability,
            ref: resolvedRef,
            summary: input.summary,
            evidence: input.evidence,
            nextVerb: input.nextVerb,
            clear: input.clear,
          },
          identity.ownerId,
          { autoAuthority },
        );
        if (!history.changed) {
          return {
            ok: true as const,
            id: input.id,
            changed: false,
            workItem,
            activeBlockers: activeExternalBlockers(workItem.payload),
            blockerHistory: history.blockers,
            capabilityDisposition: externalBlockerCapabilityPolicy(
              input.capability ??
                history.blockers.at(-1)?.capability ??
                (resolvedKind === 'human' ? 'product-decision' : 'live-dependency'),
            ),
            autoCleared: history.autoCleared,
          };
        }

        const active = history.blockers.filter((blocker) => blocker.status === 'active');
        // WI-2146530: lifecycle follows the blockers that REMAIN after this
        // update, not the shape of the current request. A partial clear has
        // `input.clear=true`, so `strictHumanAsk` is necessarily false even
        // when a credential / physical-device / external-service blocker is
        // still active. Parking that row as generic `blocked` removes it from
        // the owner-action queue despite the surviving blocker still requiring
        // owner capability.
        const remainingStrictHumanAsk = active.some(
          (blocker) => blocker.kind === 'human' && isStrictOwnerActionCapability(blocker.capability),
        );
        const updated = await mergeWorkItemPayload(
          input.id,
          { externalBlockers: history.blockers },
          { harness: input.harness },
        );
        if (!updated) {
          return { ok: false as const, id: input.id, error: 'blocker payload write did not return the work-item' };
        }

        // EI-13301 fix: `finalWorkItem` tracks the POST-transition snapshot so the
        // response never reports pre-write state (Defect 2 — a caller that trusts the
        // return value couldn't see the item had just been parked/restored).
        let finalWorkItem = updated;
        let lifecycle: unknown = null;
        try {
          if (active.length > 0) {
            lifecycle = await setWorkItemStateWithAliasInfo(
              input.id,
              remainingStrictHumanAsk ? 'needs-human' : 'blocked',
              {
                harness: input.harness,
                by: identity.ownerId,
              },
            );
          } else if (updated.family === 'feature' && updated.state === 'blocked') {
            // work-item-status-full-unify P-007: restore to the UNIFIED claimable token
            // 'open' directly (was 'todo', which only reached 'open' via the legacy
            // alias-fold + mis-reported the synced state — same class as the
            // planSyncWorkItemState re-open writer fixed in P-005).
            lifecycle = await setWorkItemStateWithAliasInfo(input.id, 'open', {
              harness: input.harness,
              by: identity.ownerId,
            });
          } else if (updated.family === 'issue') {
            lifecycle = await setWorkItemClaimHold(input.id, false, {
              harness: input.harness,
              by: identity.ownerId,
              reason: `external blocker ${resolvedKind}:${resolvedRef} cleared`,
            });
          }
          if (lifecycle && typeof lifecycle === 'object' && 'workItem' in lifecycle) {
            const lifecycleItem = (lifecycle as { workItem?: typeof updated }).workItem;
            if (lifecycleItem) finalWorkItem = lifecycleItem;
          }
          // EI-13301 Defect 1 backstop: state:'blocked' must never survive with zero
          // active blockers — that combination is invisible to claim_next/scheduler:get_next
          // AND carries no blocker explaining the exclusion (a stranded item nobody can
          // find). If the branches above didn't clear it for any reason (a race with a
          // concurrent write, an unhandled family/state combination, …), force the
          // restore now rather than leaving the item silently orphaned.
          if (active.length === 0 && finalWorkItem.state === 'blocked') {
            const restored = await setWorkItemStateWithAliasInfo(
              input.id,
              // work-item-status-full-unify P-007: both families restore to the unified
              // claimable token 'open' (feature `todo`→`open` collapsed the duality).
              'open',
              { harness: input.harness, by: identity.ownerId },
            );
            if (restored.workItem) finalWorkItem = restored.workItem;
            lifecycle = lifecycle ?? restored;
          }
        } catch (error) {
          // The payload write above already committed. Return a structured
          // partial outcome with the authoritative post-failure row so a caller
          // can recover without blindly repeating a clear that has taken effect.
          // A failed re-read is reported as UNREADABLE, never folded into "no row" (WI-6746).
          const lookup = await lookupWorkItem(input.id, input.harness);
          const persisted = lookup.status === 'found' ? lookup.item : null;
          const persistedActive = persisted ? activeExternalBlockers(persisted.payload) : active;
          const persistedState = persisted?.state ?? null;
          const stateText = persistedState ??
            (lookup.status === 'unreadable' ? `unreadable (${lookup.error})` : 'unavailable (row not found)');
          return {
            ok: false as const,
            id: input.id,
            code: input.clear ? 'partial-clear' : 'partial-set',
            error: `typed blocker persisted, but lifecycle transition failed: ${error instanceof Error ? error.message : String(error)}. ` +
              `Current state: ${stateText}; active blockers: ${persistedActive.length}. ` +
              'Read work_items:get before recovery; do not repeat the clear blindly.',
            partialOutcome: {
              blockerHistoryPersisted: true,
              lifecycleApplied: false,
              currentState: persistedState,
              activeBlockerCount: persistedActive.length,
              recoveryAction: persistedState === 'blocked' && persistedActive.length === 0
                ? 'Reopen the item through work_items:set_state after checking for independent work-item dependencies.'
                : 'Read work_items:get and repair the lifecycle state indicated by the remaining blockers.',
            },
            workItem: persisted ?? updated,
            activeBlockers: persistedActive,
            blockerHistory: history.blockers,
          };
        }

        return {
          ok: true as const,
          id: input.id,
          changed: true,
          workItem: finalWorkItem,
          activeBlockers: active,
          blockerHistory: history.blockers,
          capabilityDispositions: active.map((blocker) => externalBlockerCapabilityPolicy(blocker.capability)),
          capabilityDisposition: externalBlockerCapabilityPolicy(
            input.capability ??
              history.blockers.at(-1)?.capability ??
              (resolvedKind === 'human' ? 'product-decision' : 'live-dependency'),
          ),
          autoCleared: history.autoCleared,
          lifecycle,
          ...(resolvedKind === 'event' && !input.clear && !history.autoCleared ? { await: { event: resolvedRef } } : {}),
        };
      },
      { keyOf: (input) => ({ id: input.id, kind: input.kind, ref: input.ref }) },
    );
    return bulkContent(env);
  },
});
