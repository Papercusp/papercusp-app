/**
 * work_items:update — edit one OR many work-items' mutable fields (title / body /
 * severity / kind / found-during / linked feature / goal / plan item). The unified replacement for the
 * retired issues:update. Subscribers are notified. State → work_items:set_state;
 * structural decisions → work_items:amend; tags → work_items:tag; comments →
 * work_items:comment.
 *
 * Field-edit is an ISSUE-FAMILY capability (bug | change | task): a feature-family
 * item's fields are owned by the pipeline (scoper/architect), so editing one returns
 * a typed `unsupported_family` error rather than silently no-op'ing.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): edit ONE inline
 * ({ id, ...fields }) or MANY heterogeneous (items:[{ id, ...fields }]) → { ok,
 * results:[{ ok, id, item? | error }], counts }. Each result self-describes its id;
 * one not-found item never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { clampText, hardText, softText, LIMITS } from '../limits';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { COORD_ROLES } from '../coordination/roles';
import { planItemRef, PLAN_ITEM_KIND } from '../../issue-blocks-merge';
import { updateWorkItem, mergeWorkItemPayload, explainIssueClaimFloors, linkWorkItem, unlinkWorkItem } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';
import { rejectBodySummaryConflict, resolveBodyAlias } from './_body-alias';
import { unresolvedRefsInBody, unresolvedRefsWarning } from './unresolved-refs';

/**
 * EI-18707466248332421: the family-AGNOSTIC subset of this tool's fields — the ones that are
 * NOT issue-family columns but claim-ADMISSION tags on `payload`, written via
 * mergeWorkItemPayload (which supports BOTH families) instead of the updateIssue column patch.
 * Kept as ONE mapping so the issue-family path and the feature-family path below can never
 * disagree about which fields are family-agnostic.
 */
const PAYLOAD_FLAG_KEYS = {
  needsTwoMachineRig: 'needs_2_machine_rig',
} as const;

/**
 * Payload keys the free-form `payload` merge must REFUSE (WI-41509).
 *
 * `payload` is not just metadata — it carries ADMISSION IDENTITIES and CLAIM STATE that
 * the scheduler and the claim floors read as authority: `plan_item` is tested as
 * `payload ? 'plan_item'` to admit an item into a plan-scoped fleet lane, the
 * `claim_hold_*` trio holds a row against other agents, and `needs_2_machine_rig` /
 * `needsOwnerAction` / `lane` gate who may claim it at all. A caller able to merge those
 * could forge admission into another fleet's lane or wedge a claim floor, which is
 * exactly the authority the dedicated args above exist to mediate. So each has a
 * PURPOSE-SHAPED arg (plan_item, needsTwoMachineRig, needsHuman) that applies its
 * side-effects — the coverage edge, the legacy-key unset — and the general merge refuses
 * it rather than writing the key without them.
 *
 * The `_` PREFIX rule is deliberate and covers the rest by construction: internal and
 * migration markers (`_ei`, `_assumptions`, `_claimHold`, `_legacyHumanParkMigration`)
 * are system-written bookkeeping, and enumerating them would rot the moment a new one
 * ships. A prefix cannot drift the way a hand-maintained list does.
 */
const PAYLOAD_MERGE_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'plan_item',
  'needs_2_machine_rig',
  'needsOwnerAction',
  'needsHuman',
  'lane',
  'claim_hold_at',
  'claim_hold_by',
  'claim_hold_reason',
]);

/** The reserved keys present in a caller-supplied payload patch, in input order. */
export function reservedPayloadKeys(patch: Record<string, unknown> | undefined): string[] {
  if (!patch) return [];
  return Object.keys(patch).filter(
    (k) => k.startsWith('_') || PAYLOAD_MERGE_RESERVED_KEYS.has(k),
  );
}

type PayloadFlagArgs = { needsTwoMachineRig?: boolean; needsHuman?: boolean };

type PlanItemArg = { slug: string; item: string };

/** Convert the public plan_item shape into the durable payload stamp read by claim specs. */
function planItemPayloadPatch(
  planItem: PlanItemArg | null | undefined,
  harness: string | undefined,
): Record<string, unknown> {
  // `null` is the CLEAR sentinel and emits no patch — the unset is applied by the
  // caller via mergeWorkItemPayload's `unset`, because a null-merge leaves the key
  // PRESENT (`payload ? 'plan_item'` stays true) and would not clear anything.
  if (!planItem || !harness) return {};
  return {
    plan_item: {
      plan_slug: planItem.slug,
      item_id: planItem.item,
      harness_slug: harness,
    },
  };
}

/** The stamp currently on the row, so a clear knows which coverage edge to retract.
 * Shaped like the DURABLE payload (plan_slug/item_id), not the public arg. */
function readExistingStamp(item: { payload?: unknown } | null | undefined): PlanItemArg | undefined {
  // `payload` is declared `unknown` on WorkItem (work-items.ts:265), so narrow it
  // here rather than asking every caller to pre-shape a row it read verbatim.
  const payload = item?.payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const stamp = (payload as { plan_item?: unknown }).plan_item;
  if (!stamp || typeof stamp !== 'object') return undefined;
  const { plan_slug: slug, item_id: id } = stamp as { plan_slug?: unknown; item_id?: unknown };
  if (typeof slug !== 'string' || !slug || typeof id !== 'string' || !id) return undefined;
  return { slug, item: id };
}

/** Keep an update's plan-item coverage semantics aligned with work_items:create. */
async function linkPlanItemCoverage(
  id: string,
  planItem: PlanItemArg | null | undefined,
  harness: string | undefined,
  by: string,
): Promise<void> {
  // Accepts the CLEAR sentinel and no-ops on it: the call sites branch on a boolean
  // (`clearingStamp`), which does not narrow `it.plan_item` for the type checker.
  if (!planItem) return;
  try {
    await linkWorkItem(
      id,
      { kind: PLAN_ITEM_KIND, ref: planItemRef(planItem.slug, planItem.item) },
      'relates',
      { harness, by },
    );
  } catch {
    // The payload stamp is the claim-admission source of truth; coverage is best-effort.
  }
}

/** Retract the coverage edge a cleared stamp had asserted, so `plan_item: null`
 * leaves no half-removed linkage behind (the payload stamp and the coverage edge
 * are written together by both create and update — they must clear together too). */
async function unlinkPlanItemCoverage(
  id: string,
  planItem: PlanItemArg | undefined,
  harness: string | undefined,
): Promise<void> {
  if (!planItem) return;
  try {
    await unlinkWorkItem(id, { kind: PLAN_ITEM_KIND, ref: planItemRef(planItem.slug, planItem.item) }, 'relates', {
      harness,
    });
  } catch {
    // Mirror the link path: the payload stamp is authoritative, coverage is best-effort.
  }
}

/** The payload patch for whichever admission flags this caller actually requested. */
function payloadFlagPatch(it: PayloadFlagArgs): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [arg, key] of Object.entries(PAYLOAD_FLAG_KEYS)) {
    const v = (it as Record<string, unknown>)[arg];
    if (v !== undefined) patch[key] = v;
  }
  // P-005: `needsHuman` remains the compatibility-shaped public INPUT, but new
  // positive writes belong to the strictly named owner-capability path. The old
  // key is migration input only; no live writer may keep growing that cohort.
  if (it.needsHuman === true) patch.needsOwnerAction = true;
  return patch;
}

/** Keys cleared by the compatibility `needsHuman` input. True moves a row off the
 * legacy key while setting needsOwnerAction; false re-admits it from either era. */
function payloadFlagUnset(it: PayloadFlagArgs): string[] {
  if (it.needsHuman === true) return ['needsHuman'];
  if (it.needsHuman === false) return ['needsHuman', 'needsOwnerAction'];
  return [];
}

/** Whether the caller asked for a genuinely PIPELINE-OWNED column edit (issue-family only). */
function hasColumnEdit(it: {
  title?: unknown;
  body?: unknown;
  severity?: unknown;
  kind?: unknown;
  foundDuring?: unknown;
  linkedFeatureId?: unknown;
  parent?: unknown;
}): boolean {
  return (
    it.title !== undefined ||
    it.body !== undefined ||
    it.severity !== undefined ||
    it.kind !== undefined ||
    it.foundDuring !== undefined ||
    it.linkedFeatureId !== undefined ||
    it.parent !== undefined
  );
}

const FIELDS = {
  title: hardText(LIMITS.SHORT_TITLE).optional(),
  body: hardText(8000).optional(),
  // WI-4492: `summary` is an ACCEPTED ALIAS for `body` — the SAME column. work_items:get
  // and work_items:create both name this field `summary`, so a get→edit→update (or a
  // create-then-update) round-trip used to write the text under a name update silently
  // dropped. Accept either; `rejectBodySummaryConflict` rejects both-with-different-values.
  summary: hardText(8000).optional().describe('alias for `body` — the item’s main text (work_items:get/create name it `summary`). Pass either; both-with-different-values is rejected (WI-4492).'),
  severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
  kind: z
    .enum(['bug', 'change'])
    .optional()
    .describe('correct a mislabeled work-item kind — bug = broken (auto-implement-eligible), change = desired improvement (human-gated)'),
  // EI-10943 (same trap as improvements:capture): a provenance LABEL must never bounce
  // the whole update on length. Soft-capped — truncated handler-side by `clampText`,
  // never rejected. (Handler-side, not a zod .transform(): a transform crashes
  // z.toJSONSchema for the entire catalog — see limits.ts.)
  foundDuring: softText(LIMITS.LABEL).nullable().optional(),
  linkedFeatureId: z.string().max(80).nullable().optional(),
  parent: z.string().max(80).nullable().optional().describe('parent work-item id for duplicate/child relationships; null clears the edge'),
  // WI-37892: a goal is a shared work-item field, not issue-family metadata. Passing a
  // goal adopts an existing item into that goal's drain lane; null clears the edge.
  goal: z
    .string()
    .min(1)
    .max(200)
    .nullable()
    .optional()
    .describe('goal id to adopt this work-item into, or null to clear its goal attribution'),
  // EI-20578964155166663: `null` CLEARS the stamp, matching `parent`/`goal`. Without
  // it a stamp could be set and re-pointed but never removed, so a mis-stamped item
  // was wired into the plan's terminal machinery (lane-sync holds it at the plan
  // item's lane; completing it flips the PLAN item; reconcile then closes siblings
  // sharing the stamp) with no escape but a force-close or raw SQL. The clear is an
  // UNSET, never a null-merge — see mergeWorkItemPayload's note.
  plan_item: z
    .object({ slug: z.string().min(1), item: z.string().min(1) })
    .nullable()
    .optional()
    .describe(
      'plan item this existing work-item implements (for example { slug:"my-plan", item:"P-003" }); stamps payload.plan_item so plan-scoped fleet lanes can admit it and writes the same coverage edge as work_items:create. Pass null to CLEAR the stamp when it asserts something untrue (the item does not implement that plan item) — this removes the payload key and retracts the coverage edge, releasing the item from the plan-item lane-sync hold and the sibling-close machinery.',
    ),
  confirmShrink: z
    .boolean()
    .optional()
    .describe(
      "EI-8497: a `body` edit that would replace a substantial existing body with something far shorter is REJECTED by default (a fat-finger guard — there's no body revision history to recover from a mis-call). Pass true to confirm a genuinely intended drastic shrink.",
    ),
  // EI-18151406094317010: tag/untag an item as needing a live ≥2-machine (Hetzner/
  // federation) rig to actually execute. scheduler:get_next / claim_next then EXCLUDE
  // it from single-box self-select (crossMachineRigExclusionSql) — without this, a
  // single-box fleet can only discover a rig-only item by claiming then releasing it,
  // which re-fires work-item:claimable and wakes every idle member on every churn
  // cycle. Sets/clears payload.needs_2_machine_rig; not a real column, so it's applied
  // via mergeWorkItemPayload rather than the updateIssue column patch.
  needsTwoMachineRig: z
    .boolean()
    .optional()
    .describe(
      'WI-2796: mark (true) or unmark (false) this item as requiring a live ≥2-machine / Hetzner federation rig to work — scheduler:get_next / claim_next then exclude it from single-box self-select instead of letting single-box agents claim-then-release it repeatedly (EI-18151406094317010). Sets payload.needs_2_machine_rig.',
    ),
  // Compatibility input retained for callers while the persisted route is split. `true`
  // writes payload.needsOwnerAction and removes legacy payload.needsHuman; `false` unsets
  // BOTH keys so rows from either era can be re-admitted without raw SQL.
  needsHuman: z
    .boolean()
    .optional()
    .describe(
      'Compatibility input for the owner-action gate: true writes payload.needsOwnerAction=true and removes legacy payload.needsHuman; false unsets BOTH keys and re-admits the row. Reserve true for a genuine credential, physical-device, or external-service action only — product decisions use agent review.',
    ),
  // WI-41509: before this, an existing work-item's payload was closed to agents except
  // through the fixed flags above — work_items:create was the only tool with a free-form
  // payload, and it only applies at creation. A plan that rules "stamp your verdict onto
  // payload.<key>" was therefore unsatisfiable, and the resulting zero read as a skipped
  // step rather than a missing capability (the learning-loop triage plan's D-004/D-058).
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'MERGE these keys into payload (shallow jsonb merge — sibling keys are preserved, never replaced). For durable per-item metadata a plan or rubric rules must live on the artifact. Admission/claim keys (plan_item, needs_2_machine_rig, needsOwnerAction, needsHuman, lane, claim_hold_*) and `_`-prefixed internal keys are REFUSED — use their dedicated args, which also apply the coverage edge and legacy-key unsets a bare merge would skip.',
    ),
};

// EI-6060: `status` / `state` are NOT update fields — a work-item's lifecycle state
// changes through work_items:set_state, not here. Zod's default object() SILENTLY
// STRIPS any unknown key, so `update({ id, state:'resolved' })` parsed clean, ran the
// handler with every field undefined, and returned ok:true with an UNCHANGED item — a
// silent no-op the caller reads as success (the exact reported defect). Keep both lifecycle
// names out of the declared shape and use strict objects so they are rejected as unknown
// keys instead of being silently stripped or advertised as supported update fields.
const itemSpec = z
  .object({
    id: z.string().min(1),
    harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
    ...FIELDS,
  })
  // WI-4492: strict so an unknown field name is a LOUD error naming it, never a silent
  // drop. Same for the body/summary alias.
  .strict()
  .superRefine((it, ctx) => {
    rejectBodySummaryConflict(it, ctx);
  });

export default defineTool({
  name: 'work_items:update',
  profile: 'engineer',
  description:
    "Edit one OR many work-items' title/body/severity/kind/found-during/linked feature/parent/goal/plan_item/needsTwoMachineRig/needsHuman; notifies subscribers. Single: { id, …fields }; many: items:[{ id, …fields }]. Returns per-item { ok, id, item? | error }; missing items do not fail the batch. Goal and plan_item are family-agnostic; parent is the duplicate/child relation and null clears it. Other field edits are issue-family-only (bug/change/task); features remain pipeline-owned. Body shrink is rejected unless confirmShrink:true (EI-8497). needsTwoMachineRig toggles payload.needs_2_machine_rig; compatibility input needsHuman:true writes the strict payload.needsOwnerAction gate, while false clears both legacy and strict keys. `payload` shallow-MERGES free-form keys onto an existing item (admission/claim and `_`-prefixed keys refused). (State → work_items:set_state; structural decisions → work_items:amend; tags → work_items:tag; comments → work_items:comment.)",
  guidance: {
    when: 'Refine filed work-items: clarify text, re-rate severity, correct kind (bug↔change controls lane), attach a feature, adopt/clear a goal, or backfill plan_item provenance for a plan-scoped lane. Batch via items:[…].',
    notWhen: 'Use set_state for lifecycle, amend for structural decisions, comment for notes, or tag for topics.',
    chaining: 'work_items:get → work_items:update { id, …fields }.',
    // EI-20281509195248260: `tags` is the measured case — the belief "nothing writes
    // tags" was filed 9x in 19h (see work_items/tag.ts's header) plus
    // EI-18669607533031012, because THIS tool's unrecognized-key rejection listed only
    // what it accepts and never named the writer. Costs zero prompt weight (not
    // rendered into the description) and is paid only on that failure path.
    argRedirects: {
      // EI-21771591408106167: assignment is intentionally not a mutable field on
      // work_items:update. Point callers at the ownership door instead of leaving
      // them to infer that "claim" also supports assigning a named agent.
      assignee: {
        tool: 'work_items:claim',
        args: { id: '<work-item-id>', assignee: '<assignee>' },
        note: 'assignment is performed by work_items:claim; pass the target agent as `assignee`',
      },
      tags: {
        tool: 'work_items:tag',
        args: { id: '<work-item-id>', topic: '<topic>' },
        note: 'the ONLY writer for the claim-spec-visible `tags` field; it mirrors the topic into exactly what a scheduler:set_claim_spec filter on `tags` reads',
      },
    },
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-update shorthand: the work-item id'),
      ...FIELDS,
      items: z
        .array(itemSpec)
        .min(1)
        .max(200)
        .optional()
        .describe(
          'update many work-items at once — each { id, …fields }. A top-level field (title/body/severity/kind/foundDuring/linkedFeatureId/parent/goal/plan_item/harness) is the DEFAULT applied to every item that omits its own (EI-7639) — pass it once instead of repeating it per item.',
        ),
      harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
    })
    .strict()
    .superRefine((a, ctx) => {
      if (!((a.items?.length ?? 0) > 0 || Boolean(a.id))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'pass { id, …fields } for one, or items:[{ id, …fields }] for many',
        });
      }
      rejectBodySummaryConflict(a, ctx);
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // EI-7639: a top-level field-edit (title/body/severity/kind/foundDuring/
    // linkedFeatureId/goal/harness) is the DEFAULT for every item in items:[] that
    // omits its own — previously it was silently dropped in the batch form (the
    // per-item value was used even when `undefined`, so a top-level `kind` with
    // items:[{id}, …] applied NO kind change while still reporting ok:true and
    // bumping updated_ts). `foundDuring`/`linkedFeatureId` are nullable, so an
    // explicit `null` on the item (clear the field) must NOT be overridden by
    // the top-level default — only a truly-omitted (`undefined`) field falls
    // back.
    const list = args.items?.length
      ? args.items.map((it) => ({
          id: it.id,
          title: it.title ?? args.title,
          // WI-4492: resolve body from either alias (per-item), then the top-level default.
          body: resolveBodyAlias(it) ?? resolveBodyAlias(args),
          severity: it.severity ?? args.severity,
          kind: it.kind ?? args.kind,
          foundDuring: clampText(
            it.foundDuring !== undefined ? it.foundDuring : args.foundDuring,
            LIMITS.LABEL,
          ),
          linkedFeatureId: it.linkedFeatureId !== undefined ? it.linkedFeatureId : args.linkedFeatureId,
          parent: it.parent !== undefined ? it.parent : args.parent,
          goal: it.goal !== undefined ? it.goal : args.goal,
          plan_item: it.plan_item !== undefined ? it.plan_item : args.plan_item,
          confirmShrink: it.confirmShrink ?? args.confirmShrink,
          needsTwoMachineRig: it.needsTwoMachineRig !== undefined ? it.needsTwoMachineRig : args.needsTwoMachineRig,
          // WI-5689: needsHuman was declared in the zod schema + documented, but never
          // threaded into `list` (nor applied in the handler below) — a genuine dead
          // field that always resolved to `undefined` regardless of caller input, so
          // work_items:update{needsHuman:true} was a silent no-op that still returned
          // ok:true. Wire it exactly like the sibling needsTwoMachineRig flag.
          needsHuman: it.needsHuman !== undefined ? it.needsHuman : args.needsHuman,
          payload: it.payload ?? args.payload,
          harness: it.harness ?? args.harness,
        }))
      : [
          {
            id: args.id as string,
            title: args.title,
            body: resolveBodyAlias(args), // WI-4492: `summary` is an accepted alias for `body`
            severity: args.severity,
            kind: args.kind,
            foundDuring: clampText(args.foundDuring, LIMITS.LABEL),
            linkedFeatureId: args.linkedFeatureId,
            parent: args.parent,
            goal: args.goal,
            plan_item: args.plan_item,
            confirmShrink: args.confirmShrink,
            needsTwoMachineRig: args.needsTwoMachineRig,
            needsHuman: args.needsHuman, // WI-5689
            payload: args.payload, // WI-41509
            harness: args.harness,
          },
        ];
    const env = await runBulk(
      list,
      async (it) => {
        // WI-41509: refuse a reserved payload key BEFORE any write. The column edit and the
        // payload merge are separate statements, so validating later would leave the title/
        // severity half applied under an error the caller reads as "nothing happened" — the
        // partial-write shape this tool's own okFalse/partial reporting exists to make legible.
        const reserved = reservedPayloadKeys(it.payload);
        if (reserved.length > 0) {
          return {
            ok: false as const,
            id: it.id,
            error:
              `payload: refused reserved key(s) ${reserved.join(', ')} — these carry admission ` +
              `identity or claim state that the scheduler and claim floors read as authority, and ` +
              `writing them without their side-effects (the plan-item coverage edge, the legacy-key ` +
              `unsets) produces a row that admits or holds on a stamp nothing else agrees with. Use ` +
              `the dedicated args instead: plan_item, needsTwoMachineRig, needsHuman. Keys prefixed ` +
              `"_" are system-written bookkeeping and are never caller-writable.`,
          };
        }
        const res = await updateWorkItem(
          it.id,
          {
            title: it.title,
            body: it.body,
            severity: it.severity,
            kind: it.kind,
            foundDuring: it.foundDuring,
            linkedFeatureId: it.linkedFeatureId,
            parent: it.parent,
            goal: it.goal,
            confirmShrink: it.confirmShrink,
          },
          ident.ownerId,
          { harness: it.harness },
        );
        if (res.ok) {
          let item = res.item;
          // EI-18151406094317010: needsTwoMachineRig isn't a real issue column, so it's
          // applied additively via mergeWorkItemPayload rather than the updateIssue patch
          // above (which would silently drop an unknown key).
          if (it.needsTwoMachineRig !== undefined) {
            const merged = await mergeWorkItemPayload(
              it.id,
              { needs_2_machine_rig: it.needsTwoMachineRig },
              { harness: it.harness },
            );
            if (merged) item = merged;
          }
          // WI-41509: the free-form merge, applied like its sibling flags above — additively
          // via mergeWorkItemPayload, never through the updateIssue column patch (which would
          // silently drop an unknown key). Reserved keys were already refused above.
          if (it.payload && Object.keys(it.payload).length > 0) {
            const merged = await mergeWorkItemPayload(it.id, it.payload, { harness: it.harness });
            if (merged) item = merged;
          }
          // P-005: keep the public compatibility input while writing only the strict
          // owner-action key. False unsets both eras; true also removes the legacy key.
          if (it.needsHuman !== undefined) {
            const merged = await mergeWorkItemPayload(it.id, payloadFlagPatch({ needsHuman: it.needsHuman }), {
              harness: it.harness,
              unset: payloadFlagUnset({ needsHuman: it.needsHuman }),
            });
            if (merged) item = merged;
          }
          // EI-20189734665644353: an existing item needs a member-writable plan stamp before
          // a plan-scoped fleet claim spec can admit it. Keep the public update shape aligned
          // with work_items:create { plan_item } and preserve the coverage edge as well.
          const planHarness = resolveConcreteHarnessSlug(item.harness ?? it.harness, ctx) ?? undefined;
          if (it.plan_item === null) {
            // Clear: capture the outgoing stamp BEFORE the unset, so the coverage
            // edge it asserted can be retracted too (the payload key is gone after).
            const outgoing = readExistingStamp(item);
            const merged = await mergeWorkItemPayload(it.id, {}, { harness: it.harness, unset: ['plan_item'] });
            if (merged) item = merged;
            await unlinkPlanItemCoverage(it.id, outgoing, planHarness);
          } else {
            const planPatch = planItemPayloadPatch(it.plan_item, planHarness);
            if (Object.keys(planPatch).length > 0) {
              const merged = await mergeWorkItemPayload(it.id, planPatch, { harness: it.harness });
              if (merged) item = merged;
            }
            await linkPlanItemCoverage(it.id, it.plan_item, planHarness, ident.ownerId);
          }
          // EI-19919820196426791: raising severity to critical/major is a silent no-op on
          // claimability when the item sits in a lane the claim path structurally never
          // serves (payload.lane='observation') or requires a strict owner capability
          // (payload.needsOwnerAction=true) — the write reports ok:true/written:1 exactly like a
          // real steer, with nothing anywhere flagging that the two facts conflict. Surface
          // it at the write, using the SAME floor oracle the real claim path (and its own
          // miss-diagnosis) reads, so this can't drift from what scheduler:get_next actually
          // enforces.
          let claimabilityWarning: string | undefined;
          if (it.severity === 'critical' || it.severity === 'major') {
            const harnessForCheck = item.harness ?? it.harness ?? undefined;
            if (harnessForCheck) {
              try {
                const [floor] = await explainIssueClaimFloors(harnessForCheck, [it.id]);
                if (
                  floor &&
                  (floor.refusedBy === 'observation-lane' ||
                    floor.refusedBy === 'needs-owner-action')
                ) {
                  claimabilityWarning =
                    `⚠ severity set to '${it.severity}', but this item is structurally UNCLAIMABLE and will stay ` +
                    `invisible to scheduler:get_next / claim_next regardless: ${floor.detail}. Raising severity ` +
                    `(or work_items:set_priority) does not change this. If it should actually be worked, clear the ` +
                    `blocking flag first — work_items:update { id, needsHuman:false } for an owner-action routing, or ` +
                    `re-file/relocate it out of the observation lane (it was captured via improvements:capture ` +
                    `{ lane:'observation' }, which by design never enters the work queue).`;
                }
              } catch {
                // Best-effort signal only — never fail the field-edit itself over it.
              }
            }
          }
          // EI-19455334047866968 / EI-20097514755548526: a work-item id written into this
          // edit is never checked for existence, so a PHANTOM ref reads identically to a
          // real one. `update` REWRITES the durable record — the same high-trust surface
          // class as `comment`/`complete`, and the version a later reader sees is this one,
          // not whatever it replaced.
          //
          // Uses the helper's DEFAULT (dynamic-import) probe rather than importing
          // getWorkItem statically: several suites here vi.mock '../../work-items' wholesale,
          // and a new static import from it is a known way to break them (EI-19395547021329946).
          // Advisory + fail-open + best-effort — the edit has already been written.
          let unresolvedRefsWarningText: string | undefined;
          try {
            const unresolved = await unresolvedRefsInBody([it.title, it.body].filter(Boolean).join('\n'), {
              known: [it.id],
            });
            if (unresolved) unresolvedRefsWarningText = unresolvedRefsWarning(it.id, unresolved.missing);
          } catch {
            /* the edit already landed — never fail it over an advisory */
          }
          return {
            ok: true as const,
            id: it.id,
            item,
            ...(claimabilityWarning ? { claimabilityWarning } : {}),
            ...(unresolvedRefsWarningText ? { unresolvedRefsWarning: unresolvedRefsWarningText } : {}),
          };
        }
        if (res.reason === 'body_shrink_guard') {
          return {
            ok: false as const,
            id: it.id,
            error: `work_item '${it.id}' body edit REJECTED (EI-8497 fat-finger guard): the existing body is ${res.existingLength} chars and the new one is only ${res.newLength} — a >85% shrink. If this is genuinely intended, resend with confirmShrink:true.`,
          };
        }
        if (res.reason === 'remote_origin_not_editable') {
          return {
            ok: false as const,
            id: it.id,
            error:
              `work_item '${it.id}' is remote-authored (origin=remote) and cannot be field-edited locally; ` +
              `its authoring peer owns the row and this node receives updates through federation. ` +
              `(work_items:get / work_items:comment still work on it — only field-edit is blocked.)`,
          };
        }
        // EI-18707466248332421: the rig-gate WRITE path for the FEATURE family. needsTwoMachineRig /
        // needsHuman are NOT pipeline-owned columns — they are claim-ADMISSION payload tags, and the
        // floors that READ them are ALREADY global across both families (crossMachineRigExclusionSql
        // via claimFloorsWhereSql, EI-14806); mergeWorkItemPayload likewise writes both families.
        // But this handler calls updateWorkItem FIRST unconditionally, so its issue-family-only
        // `unsupported_family` refusal short-circuited the flag merges above — leaving the global
        // read floor UNREACHABLE for a feature-family item: nothing could ARM it. So a leg the
        // repo's own committed scaffold declares rig-gated stayed claimable to every single-box cup
        // forever — WI-3500 (8 placements) + WI-3496 (6) burned 14 spawns on work no single box can
        // finish, and `state=blocked` was the only (coarse, un-re-admittable) mitigation available.
        if (res.reason === 'unsupported_family') {
          const planHarness = resolveConcreteHarnessSlug(it.harness, ctx) ?? undefined;
          const flagPatch = {
            // WI-41509: the caller's free-form keys go FIRST so the structural patches below
            // always win a collision. Reserved keys are refused before any write, so this is a
            // belt-and-braces ordering rather than the guard itself — but the feature path is
            // exactly where a future reserved key could be added to one list and not the other.
            ...(it.payload ?? {}),
            ...payloadFlagPatch(it),
            ...planItemPayloadPatch(it.plan_item, planHarness),
          };
          const flagUnset = payloadFlagUnset(it);
          // EI-20578964155166663: a clear is an UNSET, and planItemPayloadPatch emits
          // nothing for it — so without this the feature-family path would silently
          // no-op `plan_item: null` while reporting ok, the exact shape of miss this
          // fix exists to remove. Read the outgoing stamp before the unset lands.
          const clearingStamp = it.plan_item === null;
          // Dynamic import, not a new static one: several suites here vi.mock
          // '../../work-items' wholesale and a partial factory makes a newly-imported
          // name undefined at call time (EI-19395547021329946, per the note below).
          // Best-effort by design — the UNSET is the load-bearing half; retracting the
          // coverage edge is advisory, exactly as linkPlanItemCoverage already treats it.
          let outgoing: PlanItemArg | undefined;
          if (clearingStamp) {
            try {
              const { getWorkItem } = await import('../../work-items');
              outgoing = readExistingStamp(await getWorkItem(it.id, it.harness));
            } catch {
              /* leave the coverage edge; the stamp itself still clears below */
            }
          }
          if (Object.keys(flagPatch).length > 0 || flagUnset.length > 0 || clearingStamp) {
            const merged = await mergeWorkItemPayload(it.id, flagPatch, {
              harness: it.harness,
              ...((clearingStamp || flagUnset.length > 0)
                ? { unset: [...flagUnset, ...(clearingStamp ? ['plan_item'] : [])] }
                : {}),
            });
            if (merged) {
              if (clearingStamp) await unlinkPlanItemCoverage(it.id, outgoing, planHarness);
              else await linkPlanItemCoverage(
                it.id,
                it.plan_item,
                planHarness,
                ident.ownerId,
              );
              // A column edit requested ALONGSIDE the flag genuinely IS pipeline-owned: apply the
              // admission flag (it is family-agnostic) but still report that half honestly, rather
              // than claiming the whole patch landed.
              if (!hasColumnEdit(it)) return { ok: true as const, id: it.id, item: merged };
              return {
                ok: false as const,
                id: it.id,
                error:
                  `work_item '${it.id}' is feature-family: the admission flag(s) ${[
                    ...Object.keys(flagPatch),
                    ...flagUnset.map((key) => `unset:${key}`),
                  ].join(', ')} WERE applied, ` +
                  `but its other fields are owned by the pipeline — re-send the field edit without them.`,
              };
            }
          }
        }
        return {
          ok: false as const,
          id: it.id,
          error:
            res.reason === 'unsupported_family'
              ? `work_item '${it.id}' is feature-family — its fields are owned by the pipeline; field-edit applies to issue-family items (bug/change/task)`
              : `work_item '${it.id}' not found`,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
