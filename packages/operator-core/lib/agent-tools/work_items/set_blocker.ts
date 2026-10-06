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
  OWNER_ASK_DEFAULT_ACTIONS,
  readExternalBlockers,
  type ExternalBlockerCapability,
  type ExternalBlockerKind,
  type OwnerAskDefaultAction,
} from '../../external-blockers';
import { lookupWorkItem } from './_lookup';
import { isStrictOwnerActionCapability } from '../../harness/improvements/agent-review-policy';
import { hasActiveStrictHumanAsk } from '../../hold-registry';
import { stagingFirstBlockerProblem } from '../plans/staging-first-activation-guard';
import { pureWorkItemDependencyReferents, workItemRefBlockerProblem } from './work-item-ref-blocker-guard';
import { linkWorkItemRefDependencies } from './work-item-ref-blocker-edges';
import { workItemRefDependencyRefusal } from './work-item-ref-dependency-refusal';

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
const SET_BLOCKER_CALL_CONSTRAINT =
  "When setting a strict human owner-capability blocker (capability: credential, physical-device, external-service-action, or product-decision), provide a nonblank defaultIfUnanswered. For items:[...], this applies to each entry. A reassertion may omit it only when that work-item already has an active human blocker with the same ref and a nonblank defaultIfUnanswered. Clear-only calls and non-human blockers do not require it. The legacy kind shorthands credential, physical-device, external-service-action, and product-decision are treated as human capabilities.";
type BlockerInput = {
  id: string;
  kind?: BlockerKindInput;
  capability?: BlockerCapabilityInput;
  ref?: string;
  summary?: string;
  evidence?: string;
  nextVerb?: string;
  defaultIfUnanswered?: string;
  decideBy?: string;
  defaultAction?: OwnerAskDefaultAction;
  clear?: boolean;
  harness?: string;
  migrateWorkItemRefs?: boolean;
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
  defaultIfUnanswered: z.string().max(500).optional(),
  decideBy: z.string().max(40).optional(),
  defaultAction: z
    .enum(OWNER_ASK_DEFAULT_ACTIONS)
    .optional()
    .describe(
      "Typed, machine-executable form of defaultIfUnanswered, applied ONCE by the reaper after decideBy passes with no owner answer. stay_parked: ask stays active, item stays parked. release_to_agents: ask cleared, item returns to the claimable pool. Needs decideBy; the free-text default is never parsed.",
    ),
  clear: z.boolean().optional(),
  harness: z.string().max(80).optional(),
  migrateWorkItemRefs: z
    .boolean()
    .optional()
    .describe('Migrate this item\'s legacy rows that name only work-items to blocks edges; pass id (+harness) only.'),
};

/** A migration request names only the item: it rewrites existing rows, so a set/clear field is contradictory. */
function validateMigrateOnly(
  value: { migrateWorkItemRefs?: boolean; kind?: unknown; capability?: unknown; ref?: unknown; clear?: unknown },
  ctx: z.RefinementCtx,
  path: (string | number)[] = [],
) {
  if (value.migrateWorkItemRefs !== true) return;
  for (const key of ['kind', 'capability', 'ref', 'clear'] as const) {
    if (value[key] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: `migrateWorkItemRefs rewrites the item's existing rows and cannot be combined with '${key}'`,
      });
    }
  }
}

const itemSpec = z
  .object({ id: z.string().min(1), ...fields })
  .strict()
  .superRefine(validateCapabilityKindAlias);

const TERMINAL = new Set(['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']);

type WorkItemRow = NonNullable<Awaited<ReturnType<typeof getWorkItem>>>;
const MIGRATION_EVIDENCE = 'WI-10005020 R-15: migrated to the work_item_deps blocks edge (canonical dependency form)';

/**
 * WI-10005020 (P-002 / R-15) — migrate an item's legacy `externalBlockers` rows whose ref
 * names ONLY work-items to the canonical `blocks` edge, then clear the row (history kept).
 *
 * - A referent equal to the item's own id is not a dependency: rows naming only the item
 *   itself are owner-action records and stay untouched; a self id inside a multi-ref row
 *   is dropped from the referents.
 * - A terminal dependent gets its rows cleared without new edges — nothing can wait on it.
 * - A refused edge (missing referent, cycle, an active dependant's guard) leaves that row
 *   active and is reported, so no dependency is ever lost.
 * - When no active row remains, the lifecycle mirrors clearing the last blocker: `blocked`
 *   returns to `open` (the edge alone now gates claiming) and an issue's claim hold drops.
 */
async function migrateWorkItemRefRows(input: NormalizedBlockerInput, workItem: WorkItemRow, by: string) {
  const ownId = input.id.toUpperCase();
  const dependentTerminal = TERMINAL.has(workItem.state.toLowerCase());
  const converted: Array<{ kind: string; ref: string; blockers: string[] }> = [];
  const refused: Array<{ kind: string; ref: string; error: string }> = [];
  const untouchedSelfOnly: Array<{ kind: string; ref: string }> = [];
  let payload: Record<string, unknown> =
    workItem.payload && typeof workItem.payload === 'object' && !Array.isArray(workItem.payload)
      ? (workItem.payload as Record<string, unknown>)
      : {};
  let blockers = readExternalBlockers(payload);

  for (const row of activeExternalBlockers(workItem.payload)) {
    const referents = pureWorkItemDependencyReferents(row.ref);
    if (!referents) continue;
    const dependencies = referents.filter((referent) => referent !== ownId);
    if (!dependencies.length) {
      untouchedSelfOnly.push({ kind: row.kind, ref: row.ref });
      continue;
    }
    if (!dependentTerminal) {
      const linked = await linkWorkItemRefDependencies({
        dependentId: input.id,
        harness: input.harness,
        referents: dependencies,
        by,
      });
      if (!linked.ok) {
        refused.push({ kind: row.kind, ref: row.ref, error: linked.error });
        continue;
      }
    }
    const history = applyExternalBlockerUpdate(
      payload,
      { kind: row.kind, ref: row.ref, clear: true, evidence: MIGRATION_EVIDENCE },
      by,
      { autoAuthority: false },
    );
    blockers = history.blockers;
    payload = { ...payload, externalBlockers: blockers };
    converted.push({ kind: row.kind, ref: row.ref, blockers: dependentTerminal ? [] : dependencies });
  }

  const migration = { dependentTerminal, converted, refused, untouchedSelfOnly };
  if (!converted.length) {
    return {
      ok: refused.length === 0,
      id: input.id,
      changed: false,
      workItem,
      migration,
      activeBlockers: activeExternalBlockers(workItem.payload),
      ...(refused.length
        ? {
            code: 'work_item_ref_dependency_refused',
            error: refused.map((r) => r.error).join(' | '),
            refusal: workItemRefDependencyRefusal(input.id, refused.map((r) => r.ref).join(',')),
          }
        : {}),
    };
  }

  const updated = await mergeWorkItemPayload(input.id, { externalBlockers: blockers }, { harness: input.harness });
  if (!updated) return { ok: false as const, id: input.id, error: 'blocker payload write did not return the work-item', migration };
  const active = activeExternalBlockers(updated.payload);
  let finalWorkItem = updated;
  let lifecycle: unknown = null;
  if (active.length === 0 && !dependentTerminal) {
    if (updated.state === 'blocked') {
      // The payload write and the edges above are already committed, so a refused
      // restore (e.g. the plan gate while the linked plan item is still blocked)
      // must not report the whole migration as failed. The item stays blocked,
      // which is correct while that gate holds; report the refusal as lifecycle.
      try {
        const restored = await setWorkItemStateWithAliasInfo(input.id, 'open', { harness: input.harness, by });
        if (restored.workItem) finalWorkItem = restored.workItem;
        lifecycle = restored;
      } catch (err) {
        lifecycle = {
          restored: false,
          state: updated.state,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else if (updated.family === 'issue') {
      lifecycle = await setWorkItemClaimHold(input.id, false, {
        harness: input.harness,
        by,
        reason: 'external work-item-ref blockers migrated to blocks edges',
      });
    }
  }
  return {
    ok: refused.length === 0,
    id: input.id,
    changed: true,
    workItem: finalWorkItem,
    migration,
    activeBlockers: active,
    blockerHistory: blockers,
    lifecycle,
    ...(refused.length
      ? {
          code: 'work_item_ref_dependency_refused',
          error: refused.map((r) => r.error).join(' | '),
          refusal: workItemRefDependencyRefusal(input.id, refused.map((r) => r.ref).join(',')),
        }
      : {}),
  };
}

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
      defaultIfUnanswered: z.string().max(500).optional(),
      decideBy: z.string().max(40).optional(),
      defaultAction: fields.defaultAction,
      clear: z.boolean().optional(),
      harness: z.string().max(80).optional(),
      migrateWorkItemRefs: fields.migrateWorkItemRefs,
      items: z.array(itemSpec).min(1).max(100).optional(),
    })
    .strict()
    .refine(
      (args) =>
        (args.items?.length ?? 0) > 0 ||
        (Boolean(args.id) && (Boolean(args.ref) || args.clear === true || args.migrateWorkItemRefs === true)),
      {
        message:
          'pass { id, ref, kind?, summary? } for one, or items:[{ id, ref, kind?, … }]; clear:true may omit ref when one active blocker matches; migrateWorkItemRefs:true takes only id',
      },
    )
    .superRefine((args, ctx) => {
      validateCapabilityKindAlias(args, ctx);
      validateMigrateOnly(args, ctx);
      if (!args.items?.length) return;
      for (const [index, item] of args.items.entries()) {
        validateMigrateOnly(item, ctx, ['items', index]);
        if (!item.clear && !item.ref && item.migrateWorkItemRefs !== true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'ref'],
            message: 'ref is required when setting a blocker',
          });
        }
      }
    })
    .refine(
      (args) =>
        (args.items?.length ?? 0) > 0 ||
        Boolean(args.kind) ||
        args.clear === true ||
        args.migrateWorkItemRefs === true,
      {
        message: 'kind is required when setting a blocker; clear:true may infer kind from ref',
      },
    )
    .superRefine((args, ctx) => {
      if (!args.items?.length) return;
      for (const [index, item] of args.items.entries()) {
        if (!item.kind && item.clear !== true && item.migrateWorkItemRefs !== true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'kind'],
            message: 'kind is required when setting a blocker; clear:true may infer kind from ref',
          });
        }
      }
    })
    .meta({ 'x-papercusp-call-constraint': SET_BLOCKER_CALL_CONSTRAINT }),
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
            defaultIfUnanswered: args.defaultIfUnanswered,
            decideBy: args.decideBy,
            defaultAction: args.defaultAction,
            clear: args.clear,
            harness: args.harness,
            migrateWorkItemRefs: args.migrateWorkItemRefs,
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
        if (input.migrateWorkItemRefs) {
          return migrateWorkItemRefRows(input, workItem, identity.ownerId);
        }
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
          // WI-10005020 (P-002 / R-14): a ref naming ONLY work-items (bare ids or
          // `work-item:done:<id>` keys) is a dependency, and its one canonical form is
          // the `blocks` edge the claim floors, plans:items blockedBy and the
          // dependency traversal read. Record that edge instead of an external row;
          // the lifecycle is left alone because the edge itself gates claiming.
          const referents = pureWorkItemDependencyReferents(input.ref);
          if (referents) {
            const linked = await linkWorkItemRefDependencies({
              dependentId: input.id,
              harness: input.harness,
              referents,
              by: identity.ownerId,
            });
            if (!linked.ok) {
              return { ok: false as const, id: input.id, error: linked.error, code: linked.code, refusal: linked.refusal };
            }
            return {
              ok: true as const,
              id: input.id,
              changed: true,
              workItem,
              convertedToEdge: { rel: 'blocks' as const, blockers: linked.edges.map((edge) => edge.blocker) },
              note:
                `Recorded as work_item_deps blocks edge(s) ${referents.join(', ')} → ${input.id}; no external ` +
                'blocker row was written. The edge resolves itself when the blocker is terminal (dropped counts); ' +
                'remove it with work_items:link { rel:"blocks", remove:true }.',
              activeBlockers: activeExternalBlockers(workItem.payload),
              blockerHistory: readExternalBlockers(workItem.payload),
              capabilityDisposition: externalBlockerCapabilityPolicy(input.capability ?? 'live-dependency'),
              autoCleared: false,
            };
          }
          // WI-2141488: a bare work-item id MIXED with other conditions is still
          // inert as external text — refuse at the write; `clear` is deliberately
          // exempt so rows already carrying a bad ref stay clearable.
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
        // Owner-attention ledger (EI-23783029010995961): an ask the owner may never
        // answer must say what the system WILL do in that case, so silence is a
        // stated outcome instead of an invisible chronic deferral. A plain
        // re-assertion of an existing ask may omit it when the record already has one.
        if (strictHumanAsk) {
          const existingDefault = activeExternalBlockers(workItem.payload).find(
            (blocker) => blocker.kind === 'human' && blocker.ref === input.ref,
          )?.defaultIfUnanswered;
          if (!input.defaultIfUnanswered?.trim() && !existingDefault?.trim()) {
            return {
              ok: false as const,
              id: input.id,
              error:
                `work_item '${input.id}' owner-capability blocker rejected — state \`defaultIfUnanswered\`: what the ` +
                'system will do if the owner never answers (e.g. "stays parked; weekly digest re-surfaces it" or ' +
                '"proceeds with option A"). Add `decideBy` (ISO timestamp) when that default has a date. Blocker was not written.',
            };
          }
        }
        if (!input.clear && input.decideBy !== undefined && !Number.isFinite(Date.parse(input.decideBy))) {
          return {
            ok: false as const,
            id: input.id,
            error: `work_item '${input.id}' decideBy '${input.decideBy}' is not a parseable ISO timestamp. Blocker was not written.`,
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
            defaultIfUnanswered: input.defaultIfUnanswered,
            decideBy: input.decideBy,
            defaultAction: input.defaultAction,
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
        //
        // D-029: "strict" is the hold registry's answerable ask (structured AND carrying
        // defaultIfUnanswered), the same predicate the canonical needs-human writer refuses
        // on. A surviving LEGACY ask with no default parks as `blocked` (an owner-clearer
        // blocker hold) instead of a needs-human write the writer would refuse.
        const remainingStrictHumanAsk = hasActiveStrictHumanAsk({ externalBlockers: active });
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
          // WI-10005104: the same stranding exists for an ISSUE-family item parked as
          // `needs-human` on a strict human ask — setWorkItemClaimHold above only strips
          // payload hold keys and never touches `status`, so clearing the last ask left
          // `needs-human` with zero blockers (unclaimable AND unexplained). Feature-family
          // `needs-human` is deliberately excluded: it can be the plan lane's own state.
          const strandedIssueNeedsHuman = updated.family === 'issue' && finalWorkItem.state === 'needs-human';
          if (active.length === 0 && (finalWorkItem.state === 'blocked' || strandedIssueNeedsHuman)) {
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
