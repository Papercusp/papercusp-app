/**
 * work_items:create — create a work-item of any kind on the unified surface
 * (unify-work-items-2026-06-04, D-001/D-002/D-007). One `work_item` type; `kind`
 * discriminates. Mints a kind-independent WI-NNN id (D-008). Dispatches by kind:
 * bug/change/task file an issue (engineer_issues); feature/chunk land in
 * the harness work queue (harness_features_consolidated). A `chunk` carries a
 * `parent` (D-004).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): create ONE inline
 * ({ kind, title, … }) or MANY (items:[{ kind, title, … }] + batch-level harness /
 * workspace / assign_all_to_self) → { ok, results:[{ ok, id, title, workItem } |
 * { ok:false, title, error, message?, existing? }], counts }. This RETIRES the old
 * `work_items:create_batch` multiplexer (D-002): every item still runs the SAME
 * per-item core (`createOneWorkItem`) — the EI-316 mirror-guard, EI-728 workspace
 * resolution, the D-019/D-020 hive-scope gate, and the B-LOOP-4 atomic create+claim.
 *
 * Emits (start-hive-wake-orchestration-2026-06-09 P-001 / D-001): a successful
 * create fires a `coord:emit` lifecycle notification scoped to the item's tagged
 * topics — new demand surfaces as an event. With the bulk envelope it fires PER
 * created item via the D-007 event-layer fan-out (so a bulk create no longer
 * silently drops the demand signal — D-003). The Queen's default wake subscription
 * rides the same tool event (lib/hive/wake-defaults), per item; the `urgent` flag
 * remains the immediate-bypass (requestUrgentHiveWake) for fire-now cases.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { potArg } from '../_pot-scope';
import {
  createOneWorkItem,
  type CreateOneWorkItemArgs,
  type CreateOneWorkItemResult,
} from './_create-core';
import { looksLikeResidualClosure } from '../../plan-items/convert';
import { TERMINAL_WORK_ITEM_STATES } from '../../work-items';
import { LINK_RELS } from './link';
import { PLAN_ITEM_KIND, planItemRef } from '../../issue-blocks-merge';
import { derivePlanSlug } from '../coordination/derived-plan-slug';
import { runBulk, bulkContent } from '../_bulk';
import { hardText, LIMITS } from '../limits';
import { rejectBodySummaryConflict, resolveBodyAlias } from './_body-alias';
import {
  admitSubjectForFleetTarget,
  notifyFleetScopeRefusal,
  fleetScopeLeaderRemedy,
} from '../../scheduler/fleet-scope-admission';
import type { ClaimSpecSubject } from '../../scheduler/claim-spec-match';
import { ROUTING_GATE_INTENTS } from '../../routing-gate-hints';
import { getModes } from '../../modes/store';
import { withDrainBugAdmission } from './drain-flow';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveGoalContext } from '../../modes/goal-context';
import { gateWorkScope } from '../../work-scope-policy';

/**
 * Inline typed-link spec (WI-3956) — one edge written from the NEW work-item to a
 * target right after creation. Shared by the single-create args and the bulk itemSpec
 * so the shape never drifts. `rel` is pinned to the LINK_RELS vocabulary (imported
 * from the link tool — one source of truth); the target is another work-item
 * (target_id) or any coord ObjectRef (target_kind + target_ref). Best-effort in the
 * core: an unresolvable target is skipped, never failing the create.
 */
/**
 * EI-10897 — the `state` you may set AT CREATION.
 *
 * Non-terminal only, and deliberately so. Creating an item straight into a terminal
 * state would walk right past the completion-integrity gate (setWorkItemState /
 * setIssueState demand an owner + a completionRef for any terminal transition, and
 * P-004 stamps the `authority` judgement from the evidence that gate collects) — i.e. it would be a
 * one-call way to manufacture a "done" item with no evidence, the exact laundering
 * EI-10867 exists to stop. If it is genuinely already finished, create it and then
 * work_items:complete it, so the evidence is recorded.
 */
const stateOnCreate = z
  .string()
  .min(1)
  .max(40)
  .refine((s) => !TERMINAL_WORK_ITEM_STATES.includes(s), {
    message:
      'a work-item cannot be CREATED in a terminal state — that would bypass the completion-integrity gate (no owner, no evidence). Create it, then work_items:complete { id, completion, state } so the verification evidence is recorded.',
  })
  .describe(
    "initial lifecycle state (EI-10897) — e.g. 'wip' to open an ad-hoc unit you are starting RIGHT NOW (pair with assign_to:'self'), or 'blocked'. Defaults to the kind's normal entry state (todo). Terminal states are rejected: complete the item instead, so its evidence is recorded.",
  );

/**
 * Owner-directive provenance (directive-visibility-and-ownership-2026-09-22, P-005).
 * Shared by the inline-create and per-item shapes so the two schemas cannot drift.
 *
 * The turn-start Orientation banner TELLS agents to pass this — "to take it,
 * work_items:create { directiveRef: N } first" — so the parameter and that
 * instruction ship together or the instruction points at nothing.
 */
const directiveRefArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'owner-directive provenance: the orders id this work-item is being created to carry out (harness_shared.owner_directives.id). Late-binding and one-directional — the directive is never written back. Omit for ordinary work; a directive with zero linked work-items is healthy, not degenerate.',
  );

const linkSpec = z.object({
  rel: z.enum(LINK_RELS).describe('the relationship: blocks | relates | duplicates | fixes | investigates | about | caused-by | revises'),
  target_id: z.string().max(120).optional().describe('a target work-item id'),
  target_kind: z.string().max(40).optional().describe('explicit coord ObjectRef kind (e.g. plan_item, event) — use with target_ref'),
  target_ref: z.string().max(160).optional().describe('explicit coord ObjectRef ref — use with target_kind'),
  target_harness: z.string().max(80).optional().describe('harness for a feature target_id (disambiguation)'),
  satisfaction: z.enum(['settled', 'success']).optional().describe('blocks-only outcome requirement; omitted defaults to settled'),
});

function rejectMissingScheduleCadence(
  value: { routing_intent?: string; cadence?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.routing_intent === 'schedule-recurrence' && !value.cadence?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['cadence'],
      message:
        "cadence is required when routing_intent='schedule-recurrence' — e.g. 'daily at 09:00' or a cron expression",
    });
  }
}

/**
 * Heuristic: does this work-item text smell like CODE work? Used ONLY for a
 * NON-BLOCKING nudge when kind='task' (which is non-code only, WI-2874). A false
 * positive is harmless — it's a suggestion the creator can ignore — so we bias
 * toward a few reliable STRUCTURAL signals (a repo source path, a code file
 * extension, a backticked camelCase identifier) plus a short set of code-edit
 * verbs, rather than a fragile generic-verb net. Pure + exported for its test.
 */
export function codeSmellsLikeCode(title: string, summary?: string): boolean {
  const text = `${title ?? ''}\n${summary ?? ''}`;
  return (
    /\b(packages|libs|apps|src|scripts)\/[\w./-]+/i.test(text) || // a repo source path
    /\.(ts|tsx|rs|mjs|cjs|js|jsx|sql|py|go|sh)\b/.test(text) || // a code file extension
    /`[^`]*[a-z][A-Z][^`]*`/.test(text) || // a backticked camelCase identifier
    /\b(implement|refactor|re-?kind|patch|hotfix|typecheck|recompile|null-?check|regression test|stack ?trace|zod schema|unit test|integration test|code path|endpoint|migration)\b/i.test(
      text,
    )
  );
}

function describeDedupCoverageWarning(
  coverage: NonNullable<CreateOneWorkItemResult['dedupCoverage']>,
): string {
  return (
    `⚠ dedup coverage is degraded (lexical=${coverage.lexical}, semantic=${coverage.semantic}) — ` +
    'a differently-worded duplicate may not have been found. Read dedupCoverage before treating ' +
    'this create as checked clean.'
  );
}

/**
 * EI-22457131413761799: a valid 50-item create took longer than the tool's
 * foreground transport budget because the shared bulk helper ran every item
 * serially. These creates already use independent per-item transactions and
 * keyed results, so a small worker pool removes the impossible serial latency
 * without turning a caller-controlled batch into an unbounded PG fan-out.
 */
export const WORK_ITEMS_CREATE_MAX_CONCURRENCY = 4;

function createAdmissionSubject(spec: CreateOneWorkItemArgs): ClaimSpecSubject {
  const payload = spec.payload ?? {};
  const numberOrNull = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return {
    // An id-pinned fleet is a closed cohort: a not-yet-minted item cannot be
    // silently placed into it merely because its eventual WI id is unknown.
    id: null,
    title: spec.title,
    // EI-20240035377782004: same shape as `title` — the create-time spec is the only
    // source (no row exists yet to read a column from). `body` is an accepted alias
    // for `summary` at the tool-schema boundary but is normalized onto `summary`
    // before this function ever sees `spec` (see the `_body` destructure at the
    // items-array call site), so only `spec.summary` needs reading here.
    summary: spec.summary ?? null,
    kind: spec.kind,
    priority: null,
    tags: spec.topics ?? [],
    paths: Array.isArray(payload.paths) ? payload.paths.filter((p): p is string => typeof p === 'string') : [],
    plan: spec.targetPlanItem?.slug ?? null,
    planItem: spec.targetPlanItem ? [spec.targetPlanItem.itemId] : [],
    fleet: null,
    triageGate: null,
    age: Date.now(),
    riskTier: typeof payload.risk_tier === 'string' ? payload.risk_tier : null,
    redundancy: numberOrNull(payload.redundancy),
    estCost: numberOrNull(payload.est_cost ?? payload.expected_cost_cents),
    assignee: spec.assign_to ?? null,
    // WI-6675: the severity the item is being created WITH. Create-time admission runs
    // before the row exists, so it has no `_ei` fold to read — the spec's own field is
    // the only source, and omitting it would make a severity-scoped fleet silently
    // refuse every newly-created item (subject.severity === null never matches
    // `severity in [critical,major]`), i.e. a lane that drains the existing backlog but
    // goes blind to new arrivals. Feature-family creates carry no severity ⇒ null, which
    // is the correct non-match for an issue-family-only notion.
    severity: spec.severity ?? null,
    // WI-37711: ALWAYS null here, deliberately — unlike `severity` above, the goal is NOT
    // knowable at create-time admission. stampGoalProvenance writes goal_id in an UPDATE
    // *after* the row is inserted (_create-core.ts), so no goal exists to read while this
    // subject is being built. Mirrors `id: null`'s reasoning: a goal-pinned cohort is
    // closed, and an item cannot be placed into it on the strength of a goal it has not
    // been stamped with yet. This fails CLOSED (a `goal = X` leaf refuses an unstamped
    // subject), which is the intended direction — the goal-scoped drain fleet claims the
    // item later, through scheduler:get_next, once the stamp is on the row.
    goal: null,
  };
}

/** One per-item create spec — the same per-item shape as the single-call fields. */
const itemSpec = z.object({
  // Built-in kind OR a workspace-registered generic-kind datatype (P-001) — validated
  // per item in createOneWorkItem; an unregistered kind is rejected there as `unknown_kind`.
  kind: z.string().min(1).max(80).describe("built-in kind (feature, bug, change, task); 'chunk' is deprecated (historical rows remain readable) OR a workspace-registered generic-kind datatype (declared via meta:define-datatype)"),
  title: hardText(LIMITS.SHORT_TITLE),
  summary: hardText(8000).optional().describe('body / summary text'),
  // WI-4492: `body` is an ACCEPTED ALIAS for `summary` (the SAME field). work_items:update
  // names it `body`, so a caller who learned that name used to have it silently dropped here.
  body: hardText(8000).optional().describe('alias for `summary` — the item body text (work_items:update names it `body`). Pass either; both-with-different-values is rejected (WI-4492).'),
  harness: z.string().max(80).optional().describe('harness slug — required for feature/chunk; sets scope for bug/change. Falls back to the batch `harness` default.'),
  pot: potArg,
  severity: z.enum(['critical', 'major', 'minor', 'nit']).optional().describe('issue-family (bug/change) only'),
  parent: z.string().max(80).optional().describe('parent work-item id (feature-family; required-shape for a chunk)'),
  topics: z.array(z.string().min(1)).max(8).optional().describe('topic slugs to tag (topics:list)'),
  payload: z.record(z.string(), z.unknown()).optional().describe('kind-specific data (feature-family)'),
  routing_intent: z.enum(ROUTING_GATE_INTENTS).optional().describe('explicit papercusp-way routing intent. Body/summary prose is never classified. schedule-recurrence also requires cadence.'),
  cadence: hardText(200).optional().describe('explicit cadence for routing_intent=schedule-recurrence, e.g. "daily at 09:00" or a cron expression'),
  urgent: z.boolean().optional().describe('URGENT enqueue: wake the brain immediately (floor-debounced). Reserve for a production fire.'),
  force: z.boolean().optional().describe('Override the dupe guards (EI-316 mirror, semantic cosine, exact identity) for this item.'),
  assign_to: z.string().max(120).optional().describe('Atomically CLAIM this item for this agent id in the SAME create (B-LOOP-4) — pass a concrete ownerId, or the literal "self" to resolve to the caller. Overrides assign_all_to_self for this item.'),
  // EI-10897: the su persona itself documents `work_items:create { title, assign_to:'self',
  // state:'wip' }` as THE way to open an ad-hoc unit you are starting right now — and the
  // tool rejected `state` as an unrecognized key. A prompt that teaches an arg the tool
  // refuses is a contract break; the arg is cheaper to add than the instruction is to
  // unteach. Terminal states are refused on purpose (see stateOnCreate below).
  state: stateOnCreate.optional(),
  plan_item: z
    .object({ slug: z.string().min(1), item: z.string().min(1) })
    .optional()
    .describe('Plan item this work-item IMPLEMENTS ({ slug, item:"P-003" }): writes a work→plan_item coverage edge so it rolls up into that item; completing the item can auto-resolve it as residue. A bug merely DISCOVERED while working an item is NOT implementing it — file it unlinked (EI-19460536530145188).'),
  links: z.array(linkSpec).max(20).optional().describe('inline typed links (WI-3956) written from the new item to targets on create — e.g. [{ rel:"investigates", target_id:"EI-9250" }]. Best-effort: a bad target is skipped, never fails the create.'),
  conditionKey: hardText(200).optional().describe('recurring-detector filing identity (WI-39604): an OPEN item already holding this key is refreshed and returned (see conditionUpsert on the result) instead of a sibling being filed — single-host system filers only.'),
  directiveRef: directiveRefArg,
})
  // WI-4492: strict — an unknown field name is a LOUD error naming it, never a silent drop
  // (the defect that filed WI-4491/WI-4492 as empty shells: a `body` arg was stripped).
  .strict()
  .superRefine(rejectBodySummaryConflict)
  .superRefine(rejectMissingScheduleCadence);

export default defineTool({
  name: 'work_items:create',
  profile: 'engineer',
  description:
    "Create ONE or MANY work-items. bug/change/task file tracked issues; feature enters the harness queue; chunk is retired (rejected). If creation requests an assignment to a fleet MEMBER outside that member's claim scope, the finding is retained as an explicitly unassigned, claim-held filing with a visible downgrade — it never grants an out-of-scope claim. Single: { kind, title, … }; many: items:[…]. Returns per-item outcomes, including a visible warning when dedup coverage is degraded.",
  guidance: {
    when: 'Track a unit of work an agent will do. Pick the kind by what it IS: bug (code is broken), change (a code change / fix / refactor / DX ask — the DEFAULT for coding work-items), feature (a pipeline-sized coding work-unit), or task (NON-CODE work only — research, a decision, an ops step). A suspected bug is filed (kind:bug) the MOMENT you notice it — filing is unconditional; fixing is the judgment call. File several via items:[…]; inline links:[{ rel, target_id }] beats a follow-up link call.',
    notWhen: 'NEVER use `task` for anything that edits code — that is `change` (or `feature` if pipeline-sized); `task` is non-code only. A passing peer question → coord:send with expects:"answer". A validator finding inside a live pipeline run → the validator pipeline, not here.',
    chaining: 'work_items:list (dedup) → work_items:create → work_items:claim/claim_next when you start → work_items:set_state on progress; work_items:promote to give a bug/change a pipeline run.',
    // WI-38059: `paths` was the eighth instance in that item's measured rejection burst,
    // and it is the ONE the item's own two remedies cannot reach. `payload` is declared
    // `z.record(z.string(), z.unknown())`, which renders as
    // `{ type:'object', additionalProperties:{} }` with NO `properties` — so
    // `nestedArgPaths` has nothing to walk (verified: it returns an empty map for this
    // shape while still resolving `observation.refs` for a TYPED nested object), and
    // `suggestArgName('paths', <declared keys>)` returns null because no declared key is
    // within edit distance. The caller therefore gets no pointer at all and reads the
    // rejection as "this tool has no paths concept" — but `paths` is real and load-bearing
    // (improvements:capture's own guidance says "Include `paths` — the auto-implement risk
    // gate reads them", and create.ts reads payload.paths when it builds the row). An
    // authored redirect is the only rung that fires for a free-form record. Zero prompt
    // weight, paid only on the failure.
    argRedirects: {
      paths: 'payload.paths',
      // EI-21828065229363197: `goal` is a REAL work-item field, just not a create-time
      // one — stampGoalProvenance writes goal_id in an UPDATE after the insert (WI-37711),
      // so there is nothing here to accept it into. suggestArgName finds no near-miss
      // among the declared keys, so without this the caller reads the rejection as "this
      // system has no goal concept" while a goal-scoped drain lane is exactly what they
      // were reaching for.
      goal: {
        tool: 'work_items:update',
        args: { id: '<work-item-id>', goal: '<goal-id>' },
        note: 'a goal cannot be set while the row is being created: it is stamped in an UPDATE after the insert (WI-37711), which is also why a goal-pinned cohort refuses an unstamped subject. Adopt the item into the goal with work_items:update { goal } once it exists; `goal: null` there clears it. If you meant the item\'s own one-line objective rather than a goal cohort, that is `title`, with `summary` for the body.',
      },
    },
    seeAlso: [
      'work_items:list (dedup against existing items before filing)',
      'work_items:link (add typed edges to an EXISTING item — create’s links:[…] is the at-birth shorthand)',
      'work_items:promote (give a filed bug/change a pipeline run)',
      'work_items:claim (self-assign the new item at creation via { assignee })',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  // New demand surfaces as an EVENT (start-hive-wake P-001 / D-001). Scoped to the
  // item's tagged topics ([] when untagged ⇒ a recorded lifecycle row with no inbox
  // delivery). Fires PER created item through the D-007 fan-out (the per-item event's
  // result.data is { ok, workItem, … } and args carries that item's `topics`).
  emits: [
    {
      fire: 'coord:emit',
      // WI-39604: a condition-key ADOPTION is not new demand — the incumbent's
      // demand event already fired when it was created, so re-announcing it per
      // detector re-fire would be the very flood the upsert exists to stop.
      when: (e) => {
        const data = e.result?.data as
          | { ok?: boolean; conditionUpsert?: { adopted?: boolean } }
          | undefined;
        return Boolean(data?.ok) && data?.conditionUpsert?.adopted !== true;
      },
      render: (e) => {
        const data = e.result.data as {
          workItem?: { id?: string; kind?: string; title?: string; harness?: string | null };
        };
        const wi = data.workItem ?? {};
        const topics = Array.isArray((e.args as { topics?: unknown }).topics)
          ? ((e.args as { topics: string[] }).topics)
          : [];
        return {
          category: 'demand',
          summary: `work item created: ${wi.id ?? '?'} (${wi.kind ?? '?'}) — ${wi.title ?? ''}`,
          ...(wi.harness ? { body: `harness: ${wi.harness}` } : {}),
          to: topics.map((t) => `@topic:${t}`),
        };
      },
    },
  ],
  args: z
    .object({
      // ── single-create shorthand (n=1) ──
      // Built-in kind OR a workspace-registered generic-kind datatype — validated in
      // createOneWorkItem (P-001). Relaxed from z.enum so a registered kind passes; an
      // unregistered one is rejected there with `unknown_kind` (was a zod enum error).
      kind: z.string().min(1).max(80).optional().describe("built-in kind (feature, bug, change, task); 'chunk' is deprecated (historical rows remain readable) OR a workspace-registered generic-kind datatype (declared via meta:define-datatype)"),
      title: hardText(LIMITS.SHORT_TITLE).optional(),
      summary: hardText(8000).optional().describe('body / summary text'),
      body: hardText(8000).optional().describe('alias for `summary` — the item body text (work_items:update names it `body`). Pass either; both-with-different-values is rejected (WI-4492).'),
      harness: z.string().max(80).optional().describe('harness slug — required for feature; sets scope for bug/change. Also the DEFAULT harness for items that omit one.'),
      pot: potArg,
      severity: z.enum(['critical', 'major', 'minor', 'nit']).optional().describe('issue-family (bug/change) only'),
      parent: z.string().max(80).optional().describe('parent work-item id (historical feature-family compatibility)'),
      topics: z.array(z.string().min(1)).max(8).optional().describe('topic slugs to tag (topics:list)'),
      payload: z.record(z.string(), z.unknown()).optional().describe('kind-specific data (feature-family)'),
      routing_intent: z.enum(ROUTING_GATE_INTENTS).optional().describe('explicit papercusp-way routing intent. Body/summary prose is never classified. schedule-recurrence also requires cadence.'),
      cadence: hardText(200).optional().describe('explicit cadence for routing_intent=schedule-recurrence, e.g. "daily at 09:00" or a cron expression'),
      urgent: z.boolean().optional().describe('URGENT enqueue: wake the brain immediately (floor-debounced). Reserve for a production fire, not routine filing.'),
      force: z.boolean().optional().describe('Override the dupe guards (EI-316 mirror, semantic cosine, exact identity).'),
      assign_to: z.string().max(120).optional().describe('Atomically CLAIM the new item for this agent id in the SAME create (B-LOOP-4) — pass a concrete ownerId, or the literal "self" to resolve to the caller. Omit ⇒ unclaimed.'),
      state: stateOnCreate.optional(), // EI-10897
      plan_item: z
        .object({ slug: z.string().min(1), item: z.string().min(1) })
        .optional()
        .describe('Plan item this work-item IMPLEMENTS ({ slug, item:"P-003" }): writes a work→plan_item coverage edge so it rolls up into that item; completing the item can auto-resolve it as residue. A bug merely DISCOVERED while working an item is NOT implementing it — file it unlinked (EI-19460536530145188).'),
      links: z.array(linkSpec).max(20).optional().describe('inline typed links (WI-3956) written from the new item to targets on create — e.g. [{ rel:"investigates", target_id:"EI-9250" }]. Best-effort: a bad target is skipped, never fails the create.'),
      conditionKey: hardText(200).optional().describe('recurring-detector filing identity (WI-39604): an OPEN item already holding this key is refreshed and returned (see conditionUpsert on the result) instead of a sibling being filed — single-host system filers only.'),
      directiveRef: directiveRefArg,
      // ── bulk-create (n≥1) ──
      items: z.array(itemSpec).min(1).max(100).optional().describe('create many work-items at once — each is a full create spec.'),
      assign_all_to_self: z.boolean().optional().describe('Claim every created item for YOU (your ownerId) — unless an item carries its own assign_to.'),
      // batch-level routing default for all items
      workspace: z.string().max(120).optional().describe('target workspace id — defaults to the request workspace (MCP ?workspace=). EI-728 routing for the inline create / every item.'),
    })
    // WI-4492: strict so an unknown field name (e.g. a stripped `body`) is a LOUD error.
    .strict()
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.kind) && Boolean(a.title)), {
      message: 'pass { kind, title } for one, or items:[{ kind, title }] for many',
    })
    .superRefine(rejectBodySummaryConflict)
    .superRefine(rejectMissingScheduleCadence),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const createCtx = {
      ownerId: ident.ownerId,
      workspaceId: ctx.workspaceId,
      harnessSlug: ctx.harnessSlug,
      projectDir: ctx.projectDir,
    };
    const list: CreateOneWorkItemArgs[] = args.items?.length
      ? args.items.map((it) => {
          // WI-4492: `body` is an accepted alias for `summary`. Drop the raw `body` key
          // (createOneWorkItem takes `summary`) and resolve the single value from either.
          const { body: _body, ...rest } = it;
          return {
            ...rest,
            summary: resolveBodyAlias(it),
            harness: it.harness ?? args.harness,
            workspace: args.workspace,
            assign_to: resolveSelfLiteral(it.assign_to, ident.ownerId) ?? (args.assign_all_to_self ? ident.ownerId : undefined),
            ...(it.plan_item ? { targetPlanItem: { slug: it.plan_item.slug, itemId: it.plan_item.item } } : {}),
            ...(it.links ? { links: it.links } : {}),
          };
        })
      : [
          {
            kind: args.kind as string,
            title: args.title as string,
            summary: resolveBodyAlias(args), // WI-4492: `body` is an accepted alias for `summary`
            harness: args.harness,
            pot: args.pot,
            workspace: args.workspace,
            severity: args.severity,
            parent: args.parent,
            topics: args.topics,
            payload: args.payload,
            routing_intent: args.routing_intent,
            cadence: args.cadence,
            state: args.state, // EI-10897
            urgent: args.urgent,
            force: args.force,
            conditionKey: args.conditionKey, // WI-39604 (items[] path carries it via ...rest)
            directiveRef: args.directiveRef, // P-005 (items[] path carries it via ...rest)
            assign_to: resolveSelfLiteral(args.assign_to, ident.ownerId) ?? (args.assign_all_to_self ? ident.ownerId : undefined),
            ...(args.plan_item ? { targetPlanItem: { slug: args.plan_item.slug, itemId: args.plan_item.item } } : {}),
            ...(args.links ? { links: args.links } : {}),
          },
        ];
    const drainMode = list.some((spec) => spec.kind === 'bug')
      ? (await getModes(ident.workspaceId ?? ctx.workspaceId ?? 'default', ident.ownerId)).find(
          (mode) => mode.mode === 'drain',
        )
      : undefined;
    // P-004 (goal-mode-design-intent-hardening-2026-08-16): derive the goal dedup
    // rail SERVER-SIDE from the creator's RESOLVED goal context — never a tool
    // argument (the zod schema above is untouched on purpose; same operative rule
    // as the goal-provenance stamps, whose whole point is replacing self-report).
    // Resolved ONCE per call, not per item. A resolved goal with the flag ON
    // arms the fail-CLOSED dedup contract in the core (see _create-core.ts
    // goalDedupGate). Authority errors themselves are fail-CLOSED regardless
    // of the optional flag; the resolver is also the mutation fence below.
    // WI-1139512: resolve authority BEFORE any item is created, even while the
    // optional dedup flag is off. The resolver is also the expired-holder fence;
    // hiding it behind the flag (and catch-to-null) let a superseded GOAL holder
    // keep filing mutations whenever the feature flag was disabled or PG failed.
    const resolvedGoalContext =
      ident.workspaceId && ident.workspaceId !== '*' && ident.ownerId
        ? await resolveGoalContext(ident.workspaceId, ident.ownerId)
        : null;
    const goalDedupGate =
      (await getFlag(FLAGS.GOAL_CREATE_DEDUP_GATE, 'system')) &&
      Boolean(resolvedGoalContext);
    const env = await runBulk(
      list,
      async (spec) => {
        spec.requireCompleteDedupCoverage = Boolean(drainMode) && spec.kind === 'bug';
        // P-004 gates code-work kinds, but `task` is explicitly NON-CODE (WI-2874)
        // and is also the kind used for plan-audit/ops filings. Keep those filings
        // available when the semantic probe is unavailable; feature/chunk/bug/change
        // still inherit the resolved GOAL fail-closed rail.
        spec.goalDedupGate = goalDedupGate && spec.kind !== 'task';
        // EI-18784357226895330: a claim spec governs what a member may PULL from the
        // shared claimable pool. It must NOT govern what a member may FILE. This block
        // used to refuse the whole create, which meant a member who discovered an
        // out-of-lane defect could not register it AT ALL — the escape hatch of "file
        // it and carry it yourself" was closed too. The observed cost: a CRITICAL
        // fleet-wide bug (EI-18779962385972529, the entire operator-core integration
        // tier dead) sat root-caused, with a designed fix, and no owner and no path to
        // one, surviving only as prose in a coord message — the exact silent-drop the
        // work-item ledger exists to prevent. Filing costs the fleet nothing and creates
        // the accountability trail; only the CLAIM is lane-contended.
        //
        // So the refusal is now a DOWNGRADE, not a rejection: the item is always filed,
        // UNASSIGNED, with the requester recorded as reporter, and the caller is told
        // plainly that they do not hold it. The safety rationale is fully preserved —
        // no out-of-scope claim is ever created — while the diagnosis survives even
        // when the ownership does not. Applies to `fleet_winding_down` too: a paused
        // fleet's member must not acquire NEW work, but recording a finding is not
        // acquiring work.
        let workScopeDowngrade: Record<string, never> | { workScopeDowngrade: string } = {};
        let fleetScopeDowngrade: Record<string, never> | { fleetScopeDowngrade: string } = {};
        if (spec.assign_to) {
          // workspace-work-scope-policy-2026-09-04 D-002/P-006: filing is allowed,
          // but an explicit assignment is a hand-out of work and must not create a
          // claim outside the workspace allow-list. Keep the finding durable and
          // pending, then let a later in-scope claim adopt it when policy permits.
          const workScope = await gateWorkScope('work_items:create', {
            harness: spec.harness ?? createCtx.harnessSlug,
            plan: spec.targetPlanItem?.slug ?? null,
            actor: ident.ownerId,
          });
          if (!workScope.allowed) {
            const requestedAssignee = spec.assign_to;
            spec.payload = {
              ...(typeof spec.payload === 'object' && spec.payload !== null ? spec.payload : {}),
              workScopeDowngrade: {
                requestedAssignee,
                reportedBy: ident.ownerId,
                harness: workScope.harness,
                code: workScope.code,
                at: new Date().toISOString(),
              },
            };
            // Do not set admissionBypass here: D-002 requires out-of-scope work to
            // remain pending/parked. The assignment is removed before persistence,
            // so no out-of-scope claim can be minted.
            spec.assign_to = undefined;
            workScopeDowngrade = {
              workScopeDowngrade:
                `FILED UNASSIGNED — the item exists on the ledger, but the requested ` +
                `assignment was refused by the workspace work-scope policy: ${workScope.message} ` +
                `No out-of-scope claim was created; the item remains pending until an ` +
                `allowed harness/exception can claim it.`,
            };
          }
        }
        if (spec.assign_to) {
          const admission = await admitSubjectForFleetTarget({
            target: spec.assign_to,
            subject: createAdmissionSubject(spec),
            // EI-18732199386440540: server-derived, never caller-supplied. Lets a
            // fleet member atomically create+claim its own out-of-spec fallout bug;
            // peer assignments and non-bugs still take the normal downgrade path.
            createdBy: ident.ownerId,
            // EI-203723: the same server-derived identity is the durable delegator
            // used to prove a leader-dispatched assignment. It is never read from
            // the caller's payload or treated as an authorization claim.
            assignedBy: ident.ownerId,
            workspaceId: ident.workspaceId,
          });
          if (!admission.allowed) {
            // WI-6326: reuse the SAME liveness read the leader notification just performed
            // (never a second lookup) so the caller-facing downgrade note's "route
            // elsewhere" advice is code-conditional too.
            const { liveRouteTarget, classRefusal } = (await notifyFleetScopeRefusal(
              ident,
              admission,
              `work_items:create+assign '${spec.title}' → ${spec.assign_to}`,
              // EI-19484346966003625 (R1): hand the refused subject's harness over so the
              // notice can say whether this spec is refusing a CLASS rather than only this
              // row — the per-row widen it otherwise recommends is what drove one leader
              // through 6 spec revisions in 42h without unblocking its member.
              { harness: spec.harness ?? createCtx.harnessSlug },
            )) ?? {};
            const requestedAssignee = spec.assign_to;
            spec.payload = {
              ...(typeof spec.payload === 'object' && spec.payload !== null ? spec.payload : {}),
              // The downgraded filing is deliberately unassigned, but it must remain
              // adoptable by a lane that can actually own it. Do not add `_claimHold`
              // here: stripping the refused assignment already protects the fleet
              // boundary, while a hold would make the durable fallback unclaimable
              // from both directions.
              fleetScopeDowngrade: {
                requestedAssignee,
                reportedBy: ident.ownerId,
                fleet: admission.scope.fleetSlug,
                code: admission.code,
                at: new Date().toISOString(),
              },
            };
            // EI-22430840507398884: stripping the refused assignment protects the
            // fleet lane, but must not also erase the explicit-assignment admission
            // bypass. The row remains unassigned + claim-held; this marker only keeps
            // it from entering the duplicate-screening pending dead end.
            spec.admissionBypass = 'bypass:explicit-assignment';
            spec.assign_to = undefined;
            fleetScopeDowngrade = {
              // EI-18673501896258575: the same concrete remedy fleetScopeLeaderRemedy
              // already sent to the fleet leader (via notifyFleetScopeRefusal), echoed to
              // the CALLER too, so a member can see the exact scheduler:set_claim_spec
              // shape needed instead of waiting, blind, for the leader to notice.
              fleetScopeDowngrade:
                `FILED UNASSIGNED — the item exists on the ledger, but you do NOT hold it: ` +
                `${admission.reason}. No out-of-scope claim was created. You are recorded as the ` +
                `reporter, so the finding is durable and attributable while it waits for an owner. ` +
                // EI-21906739799895413: the row is not persisted yet, so there is no id to
                // render — pass a placeholder so the notice still shows the fence-preserving
                // COMBINATOR shape (the part nobody can guess) with an obvious fill-in,
                // rather than degrading to prose that sends the reader inventing syntax.
                `${fleetScopeLeaderRemedy(admission, liveRouteTarget, classRefusal, null, '<the filed work-item id>')}`,
            };
          }
        }
        const persist = () => createOneWorkItem(spec, createCtx);
        const drainHarness = spec.harness ?? createCtx.harnessSlug;
        if (drainMode && spec.kind === 'bug' && !drainHarness) {
          return {
            ok: false as const,
            title: spec.title,
            error: 'drain_flow_unavailable',
            message:
              'DRAIN bug admission failed closed because no concrete harness was available for the exact flow oracle.',
          };
        }
        const gated = drainMode && spec.kind === 'bug'
          ? await withDrainBugAdmission(
              {
                workspaceId: ident.workspaceId ?? ctx.workspaceId ?? 'default',
                harness: drainHarness!,
                ownerId: ident.ownerId,
                drainStartedAt: drainMode.setAt,
              },
              () => persist(),
            )
          : null;
        if (gated && !gated.allowed) {
          return {
            ok: false as const,
            title: spec.title,
            error: gated.code,
            message: gated.message,
            ...('flow' in gated ? { drainFlow: gated.flow } : {}),
          };
        }
        const res = gated ? gated.value : await persist();
        if (!res.ok) {
          return {
            ok: false as const,
            title: spec.title,
            error: res.error,
            ...(res.message !== undefined ? { message: res.message } : {}),
            ...(res.existing !== undefined ? { existing: res.existing } : {}),
            // P-008 (P-002: dedup refusals are goal-gate-only now): carries the
            // cosine-matched OPEN items when the refusal had them.
            ...(res.similarOpen !== undefined ? { similarOpen: res.similarOpen } : {}),
            ...(res.admissionIdentity !== undefined ? { admissionIdentity: res.admissionIdentity } : {}),
            ...(res.dedupCoverage !== undefined ? { dedupCoverage: res.dedupCoverage } : {}),
            ...(res.queueAdmission !== undefined ? { queueAdmission: res.queueAdmission } : {}),
          };
        }
        // WI-2874 non-blocking nudge: `task` is NON-CODE only. If a fresh task smells
        // like code, attach a warning (never block) so the creator can re-kind it.
        const codeTaskWarning =
          spec.kind === 'task' && codeSmellsLikeCode(spec.title, spec.summary)
            ? 'This looks like CODE work, but `task` is NON-CODE only (research / a decision / manual verification / ops). If it edits code, re-kind to `change` (or `feature` if pipeline-sized) via work_items:update.'
            : undefined;
        // EI-21764742458768014: a successful create used to expose degraded
        // coverage only in the nested `dedupCoverage` object. That made the
        // normal-looking `{ ok:true }` result easy to read as "checked clean",
        // especially when the semantic embedder was unavailable. Keep the
        // machine-readable coverage and add the visible `warning` channel.
        const dedupCoverageWarning = res.dedupCoverage?.degraded
          ? describeDedupCoverageWarning(res.dedupCoverage)
          : undefined;
        const warnings = [codeTaskWarning, dedupCoverageWarning, ...(res.inlineLinkWarnings ?? [])].filter(
          (value): value is string => Boolean(value),
        );
        // EI-18655063958515097 non-blocking nudge: a title/summary that reads like an
        // unmet-acceptance residual split off a plan item, created with no plan link
        // (targetPlanItem/plan_item), is the exact "bare residual, no plan link, not
        // claimable by the fleet working that plan" failure the bug describes. Advisory
        // only — a false positive costs nothing; a missed link is how the work gets lost.
        const residualLinkNudge =
          !spec.targetPlanItem && looksLikeResidualClosure(`${spec.title} ${spec.summary ?? ''}`)
            ? {
                residualLinkNudge:
                  'This reads like a residual split off a plan item, but no plan_item/targetPlanItem was set — ' +
                  'pass plan_item: { slug, item } so this stays linked to (and claimable within) that plan\'s ' +
                  'fleet lane instead of surfacing later as an orphaned, untracked item.',
              }
            : {};
        // EI-20450339646861882 non-blocking nudge: a high-severity issue filed while the
        // caller holds a declared plan lane, carrying NO plan-item edge of any kind, is
        // the exact failure that item describes — such a row is invisible in BOTH
        // directions at once (the plan-scoped claim spec will not admit it, AND a
        // mechanical enumeration of the plan's open blockers omits it, so the release
        // criteria read greener than reality), and both silences are total: nothing
        // errors and the filer gets no signal. It was caught only by a leader's manual
        // census — a detector that does not scale.
        //
        // ⚠ THIS ADVISES THE `blocks` EDGE, DELIBERATELY NOT `plan_item:{slug,item}`.
        // That stamp is the one-live-row-per-lane COVERAGE surface (D-046, enforced at
        // write by findOpenPlanItemCollision), and finishPlanStamp flips the stamped
        // plan item to `done` when the row completes. So steering a BLOCKER there would
        // (a) collide with the lane's real row and refuse the filing outright, and
        // (b) arm EI-20576535595925497's false-close on every such row. The blocker
        // population is a MANY-to-one relation, already modelled as coord_links
        // rel='blocks' → plan_item and already read by getBlockingIssuesForPlan /
        // getAllBlockedPlanItems (issue-blocks-merge.ts) into plans:items. That edge
        // carries no uniqueness constraint and no completion propagation, so N blockers
        // may point at one plan item safely. The original convention this bug reports
        // ("stamp every fix-loop bug with {plan, P-009}") picked the wrong field; it is
        // unimplementable as stated, because the second concurrent filing is refused.
        //
        // NOT auto-derived, on purpose: "filed while on lane X" does not entail
        // "blocks X", and a spurious `blocks` edge marks that plan item blocked in
        // plans:items — reading the plan RED where it is not, which is the mirror image
        // of the false-green this exists to fix. Deriving the SLUG is safe (it is fixed
        // at write time); asserting the RELATION is the caller's call. So we tell them.
        //
        // Gated to critical/major so the hot path pays the presence read only for the
        // population the rule was written for (`severity` is issue-family-only, so this
        // also excludes features/tasks and the high-volume observation lane).
        const hasPlanItemEdge =
          Boolean(spec.targetPlanItem) ||
          Boolean((spec.payload as { plan_item?: unknown } | undefined)?.plan_item) ||
          (spec.links ?? []).some((link) => link.target_kind === PLAN_ITEM_KIND);
        let planItemBlockerNudge: Record<string, never> | { planItemBlockerNudge: string } = {};
        if ((spec.severity === 'critical' || spec.severity === 'major') && !hasPlanItemEdge) {
          // ⚠ DYNAMIC IMPORT, DELIBERATELY (EI-19281789650149592) — a STATIC import of
          // the presence module from a hot tool path transitively reaches
          // `presence-wakeability`, whose module-scope constant makes any suite that
          // PARTIALLY mocks presence fail at COLLECTION, naming a constant this change
          // never mentions. Same remedy the coord send seam uses for the same reader.
          const lane = await derivePlanSlug({
            ownerId: ident.ownerId,
            readPlanSlug: async (id) =>
              (await (await import('../coordination/presence')).getPresence(id))?.currentPlanSlug ?? null,
          });
          if (lane) {
            planItemBlockerNudge = {
              planItemBlockerNudge:
                `Filed with NO plan-item edge while you hold plan lane '${lane}'. If this blocks that plan, ` +
                `link it so it joins the plan's blocker population (plans:items reads rel='blocks' edges) — ` +
                `otherwise it is invisible both to the plan-scoped claim spec and to any enumeration of that ` +
                `plan's open blockers, silently: work_items:link { id: '${res.workItem.id}', rel: 'blocks', ` +
                `target_kind: '${PLAN_ITEM_KIND}', target_ref: '${planItemRef(lane, '<P-NNN>')}' }. ` +
                `Do NOT use plan_item: { slug, item } for a blocker — that is the one-live-row-per-lane ` +
                `COVERAGE stamp (D-046), and completing this item would flip that plan item to done.`,
            };
          }
        }
        return {
          ok: true as const,
          id: res.workItem.id,
          title: spec.title,
          workItem: res.workItem,
          ...(warnings.length > 0 ? { warning: warnings.join('\n') } : {}),
          ...residualLinkNudge,
          // EI-20450339646861882: filed, but nothing links it to the plan lane the
          // caller is on — advisory, never fatal (a filing must not fail over an edge).
          ...planItemBlockerNudge,
          // EI-18784357226895330: filed, but the requested self-assignment was refused
          // by the fleet lane — the caller must see this on an ok:true result.
          ...workScopeDowngrade,
          ...fleetScopeDowngrade,
          // work-queue-admission-and-bulk-dedup-2026-08-24 P-002 (item d): the P-008
          // soft-band advisory `similarOpen` NO LONGER comes back on a successful
          // create. Handing a filing agent an unresolved candidate list is the exact
          // shape this plan replaced: the item is born PENDING and the promoter
          // adjudicates it against corpus-wide evidence 30 minutes later, so the
          // candidates are persisted to harness_shared.dedup_edges instead. This
          // count is what remains visible — the mechanism, not a to-do list.
          // (`similarOpen` is still returned on the REFUSAL branch above, where it
          // names the item the caller should work instead.)
          ...(res.dedupEdges !== undefined ? { dedupEdges: res.dedupEdges } : {}),
          ...(res.explicitPathsWarning !== undefined ? { explicitPathsWarning: res.explicitPathsWarning } : {}),
          ...(res.inlineLinkWarnings !== undefined ? { inlineLinkWarnings: res.inlineLinkWarnings } : {}),
          // EI-20075667133396690: goal attribution, and its failure. This row is
          // REBUILT from an allowlist rather than spread from `res`, so a new core
          // outcome field reaches the agent only if it is named here — `goalId` was
          // returned by the core since P-002 and never surfaced for exactly that
          // reason. `goalStampError` means the item was created but its goal
          // attribution was NOT recorded (see _create-core.ts): a fail-open that is
          // now visible instead of silent.
          ...(res.goalId !== undefined ? { goalId: res.goalId } : {}),
          ...(res.goalStampError !== undefined
            ? {
                goalStampError:
                  `filed, but goal attribution was NOT recorded — this item will not count ` +
                  `toward its goal's spend/rollup: ${res.goalStampError}`,
              }
            : {}),
          ...(res.admissionIdentity !== undefined ? { admissionIdentity: res.admissionIdentity } : {}),
          ...(res.dedupCoverage !== undefined ? { dedupCoverage: res.dedupCoverage } : {}),
          ...(res.queueAdmission !== undefined ? { queueAdmission: res.queueAdmission } : {}),
          // WI-39604: the conditionKey routed this create onto an OPEN incumbent —
          // `workItem`/`id` are that incumbent, refreshed; no new row was filed.
          ...(res.conditionUpsert !== undefined ? { conditionUpsert: res.conditionUpsert } : {}),
        };
      },
      {
        keyOf: (spec) => ({ title: spec.title }),
        maxConcurrency: WORK_ITEMS_CREATE_MAX_CONCURRENCY,
      },
    );
    // Create-time dedup port (memory-delivery-unification-2026-07-12 P-009 /
    // D-006): the work-items-corpus leg is the semantic-dupe guard (which ships as
    // `similarOpen` on a REFUSAL and as persisted dedup edges on a successful create —
    // work-queue-admission D-010); this is the MEMORY-POOLS leg — surface fuzzy prior
    // knowledge about what's being filed, at exactly the moment a duplicate
    // could be created. Deadline-bounded, epoch-deduped (port 'create'),
    // never-throws. Queries the item titles + summaries (top 3 per D-005).
    const memory = await import('../../memory/claim-port')
      .then((m) =>
        m.buildClaimRecallBlock({
          sessionId: ident.ownerId,
          workspaceId: ctx.workspaceId ?? null,
          items: list.map((s) => ({
            id: s.title,
            title: s.title,
            summary: s.summary,
            harness: s.harness ?? ctx.harnessSlug ?? null,
          })),
          port: 'create',
          heading:
            'Related prior knowledge (fuzzy memory — check before filing: we may already know about this)',
        }),
      )
      .catch(() => null);
    // EI-19398967670466001 — hoist a SINGLE-item create's id to the TOP LEVEL. The bulk
    // envelope ({ ok, results, counts }) is not guessable from a SINGULAR create, and the
    // singular arg form invites a singular result read — so `const { id } = await
    // work_items.create({...})` silently yields undefined. That fails in the expensive
    // direction: the create SUCCEEDS (ok:true, counts.ok=1), so only the SECOND half of a
    // scripted create→complete / →claim / →comment chain no-ops, leaving a real work-item
    // parked in `wip` AND assigned — claimed, so no peer picks it up; unfinished, so
    // nothing progresses it. An invisible stall rather than a visible error (measured
    // 2026-08-03: stranded WI-7301, recovered only because code:run's fieldMisses guard
    // flagged the undefined read).
    //
    // Purely additive and single-item ONLY: `results` is untouched, and a genuine BATCH
    // hoists nothing — so no caller can start reading `id` on a multi-item create, where
    // it would be ambiguous.
    const sole = env.results.length === 1 ? (env.results[0] as { ok?: boolean; id?: string }) : undefined;
    const soleId = sole?.ok === true ? sole.id : undefined;
    const withSoleId = soleId ? { ...env, id: soleId } : env;
    return bulkContent(memory ? { ...withSoleId, memory } : withSoleId);
  },
});
