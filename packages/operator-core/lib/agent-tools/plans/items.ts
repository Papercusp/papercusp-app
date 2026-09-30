/**
 * plans:items — item-level query across one or all plans.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 *
 *   actionable: true   → effectiveStatus === 'todo', no linked blocked work-item
 *                        (stored todo with all blockers done), and no LIVE holder
 *                        on it (EI-22174704695369849 — coverage 'partial'/'full'
 *                        are withheld; 'held-not-live' and 'held-stalled' stay
 *                        offered because both are pickable, see isLiveHeldCoverage)
 *   needsHuman: true   → storedStatus === 'needs-human'
 *                        (the human's inbox, §4.3)
 *   status: <token>    → filter by effectiveStatus (NOT storedStatus,
 *                        because the whole point of effectiveStatus
 *                        is it's the one callers should ask about)
 *
 * Legacy plans are excluded — they don't have parseable items.
 */

import { z } from "zod";
import { defineTool, SU_ROLES } from "@papercusp/agent-mcp";
import {
  listPlanIndexRows,
  getPlanRow,
  getPlanContentsBySlugs,
  getPlanSlugsWithSpecTriadDeclaration,
  planItemsForRow,
  isUnknownPlanScopeError,
  type PlanIndexRow,
  type PlanRow,
} from "./source";
import { isTerminalItemStatus } from "../../fleet-drained-events";
import { ctxToPlanSourceOpts } from "./_ctx-opts";
import { harnessArg, harnessScopedCtx, resolveHarnessScope } from "../_harness-scope";
import { harnessMismatchForMiss, recoverHarnessFromSlugs, slugScopeErrorResult } from "./slug-scope";
import {
  resolveEffectiveStatusForItems,
  type ResolvedItem,
} from "./effective-status";
import {
  getAllBlockedPlanItems,
  applyPlanItemBlocks,
  planItemRef,
} from "../../issue-blocks-merge";
import {
  extractWorkItemRefs,
  getWorkItemRefStates,
  type CitedWorkItemRefState,
} from "./cited-work-item-refs";
import {
  getAllPlanItemCoverage,
  compactCoverage,
  isCoverageDivergent,
  isLiveHeldCoverage,
  type CompactCoverage,
  type PlanItemCoverage,
} from "../../plan-item-coverage";
import { ITEM_STATUSES, IMPORTANCE_LEVELS, type Importance } from "./parser";
import { TERMINAL_PLAN_STATUSES } from "./plan-start-state";
import { shapePlansItems } from "./items-shape";
import { cachedRead, type CachedReadCtx } from "../../cache";
import {
  planInSpecTriadScope,
  specTriadGate,
  specTriadEpoch,
  type SpecTriadScopeReason,
} from "./spec-triad-policy";
import type { SpecTriadLegName } from "@papercusp/plan-parser";
import { getFlag } from "@papercusp/flags/server";
import { FLAGS } from "@papercusp/flags";

/**
 * SWR backstop for plans:items (cache-expensive-tool-reads-round2-2026-06-23 P-002).
 * Same family as plans:list/get: the plan tables (harness_plans/plan_revisions/plan_runs)
 * are trigger-covered so any plan write auto-invalidates via the cache-ECA; this short
 * soft TTL only bounds staleness for the un-triggered issue-block overlay (coord_links).
 */
const PLANS_ITEMS_SOFT_TTL_MS = 45_000;

/**
 * Cross-plan exclusion guard. A terminal-status plan (shipped/superseded) has no
 * pickable items and needs no human action — its non-terminal items are stale by
 * definition. So in a CROSS-plan query its items are hidden, which is what stops a
 * dead plan's `todo` item from being picked up: the fleet-federation-reanchor trap,
 * where the superseded plan's P-002 still surfaced in `plans:items actionable=true`
 * (EI-154). Two deliberate escapes keep it from over-hiding:
 *   - `args.slug` — an explicit single-plan query always returns that plan's items.
 *   - a terminal item-status filter (`status: 'done' | 'dropped'`) — e.g. auditing a
 *     shipped plan's completed items cross-plan.
 * Returns true when the plan's items should be EXCLUDED from the result.
 */
export function isTerminalPlanHiddenFromCrossPlan(
  planStatus: string | null,
  args: { slug?: string; status?: string },
): boolean {
  if (args.slug) return false;
  if (args.status && isTerminalItemStatus(args.status)) return false;
  return (
    planStatus != null &&
    (TERMINAL_PLAN_STATUSES as readonly string[]).includes(planStatus)
  );
}

/**
 * A stale or standalone harness has no Hive plan scope. Read tools treat that
 * condition as an empty result with warning metadata; resolver failures for
 * unrelated causes must still propagate to the caller.
 *
 * Re-exported from `./source`, which owns the single definition (P-014): the
 * predicate belongs beside `resolvePlanScope`, the function that throws the errors
 * it classifies, and plans:list needs the identical rule. Two hand-maintained
 * copies of one classifier is how the two tools came to disagree about what
 * "unknown harness" means — list.ts's copy had drifted looser and could swallow a
 * registry read FAULT as an absence.
 */
export { isUnknownPlanScopeError };

/**
 * EI-22387676408573400: a caller narrowing to one plan reached for `plan` and
 * hit invalid_args. On a tool named plans:items there is no second thing `plan`
 * could select, and the tool's own guidance/chaining prose says "one exact
 * plan" — so the name is a reasonable guess, not a caller error. Renamed
 * BEFORE parse (rather than added as a sibling optional field) because the
 * cross-plan `.refine` below and eight handler sites all read `args.slug`; a
 * sibling field would have to be resolved at every one of them, and the one
 * that got missed would fail as a confusing "itemIds requires an exact plan
 * slug" on a call that named the plan. `slug` wins if somehow both appear.
 */
const renamePlanToSlug = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (r.plan === undefined) return raw;
  const { plan, ...rest } = r;
  return r.slug === undefined ? { ...rest, slug: plan } : rest;
};

const argsSchema = z.preprocess(renamePlanToSlug, z.object({
  slug: z
    .string()
    .min(1)
    .optional()
    .describe("Restrict to one plan. Required with itemIds; omit for cross-plan. `plan` is accepted as an alias."),
  itemIds: z
    .array(z.string().regex(/^P-\d{3,}$/, "P-NNN form required"))
    .min(1)
    .max(200)
    .optional()
    .describe("Restrict the result to these items from the exact `slug` plan (homogeneous)."),
  // EI-21588504660347963: two independent callers reached for the singular
  // `item` (a P-NNN id) instead of the array-shaped `itemIds` and hit
  // invalid_args — the same single/plural mismatch other tools in this catalog
  // resolve with a compatibility alias (e.g. work_items:get's `id`/`ids`).
  // Accept it as a one-item shorthand; `itemIds` wins when both are supplied.
  item: z
    .string()
    .regex(/^P-\d{3,}$/, "P-NNN form required")
    .optional()
    .describe("Compatibility alias for itemIds (a single P-NNN id); itemIds wins when both are supplied. Requires `slug`, like itemIds."),
  // EI-21913867956922477: a caller reached for the plural `ids` (the
  // work_items:get id/ids naming convention) instead of this tool's
  // `itemIds` and hit invalid_args before any read ran. Accept it as a
  // second compatibility alias alongside the singular `item`; `itemIds`
  // wins when more than one of itemIds/item/ids is supplied.
  ids: z
    .array(z.string().regex(/^P-\d{3,}$/, "P-NNN form required"))
    .min(1)
    .max(200)
    .optional()
    .describe("Compatibility alias for itemIds (plural naming); itemIds wins when both are supplied. Requires `slug`, like itemIds."),
  // tool-contract-repair-2026-09-05 P-006: three further spellings of the SAME
  // exact-item selector were each filed as invalid_args after the `item`/`ids`
  // aliases already landed — `itemId` (3 filings, e.g. EI-21669556283807249),
  // `items` (2, e.g. EI-21382868747036184 / EI-21921093498350970) and
  // `item_ids` (1, EI-21856673460402354). Each is an unambiguous synonym for
  // this tool's one exact-item filter — there is no second meaning `itemId`
  // could carry here — so they alias rather than reject (plan D: ALIAS when the
  // caller's name is a genuine synonym; BETTER-ERROR only when accepting it
  // would fuse two meanings). Precedence is fixed and documented:
  // itemIds > item > ids > itemId > items > item_ids.
  itemId: z
    .string()
    .regex(/^P-\d{3,}$/, "P-NNN form required")
    .optional()
    .describe("Compatibility alias for itemIds (a single P-NNN id, camelCase singular); itemIds wins when both are supplied. Requires `slug`, like itemIds."),
  items: z
    .array(z.string().regex(/^P-\d{3,}$/, "P-NNN form required"))
    .min(1)
    .max(200)
    .optional()
    .describe("Compatibility alias for itemIds (this tool's result key reused as the filter name); itemIds wins when both are supplied. Requires `slug`, like itemIds."),
  item_ids: z
    .array(z.string().regex(/^P-\d{3,}$/, "P-NNN form required"))
    .min(1)
    .max(200)
    .optional()
    .describe("Compatibility alias for itemIds (snake_case); itemIds wins when both are supplied. Requires `slug`, like itemIds."),
  // EI-21670809954424164 — the snake_case SINGULAR, filed alongside the others.
  item_id: z
    .string()
    .regex(/^P-\d{3,}$/, "P-NNN form required")
    .optional()
    .describe("Compatibility alias for itemIds (a single P-NNN id, snake_case); itemIds wins when both are supplied. Requires `slug`, like itemIds."),
  status: z
    .enum([...ITEM_STATUSES] as [string, ...string[]])
    .optional()
    .describe("Filter by effectiveStatus."),
  actionable: z
    .boolean()
    .optional()
    .describe(
      'Return items pickable right now: effectiveStatus === "todo", no linked blocked work-item, and nobody live already on it. An item a LIVE peer holds is withheld and counted in `withheldLiveHeld`, so a short list is never mistaken for a drained plan; items whose holder is dead or stalled stay offered, because both are reclaimable.',
    ),
  needsHuman: z
    .boolean()
    .optional()
    .describe("Return items requiring a human decision (the human's inbox)."),
  includeArchived: z
    .boolean()
    .optional()
    .describe("Include items from plans under archive/. Default false."),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe(
      "Max items returned after importance ordering. Set this to keep a cross-plan read bounded; truncated:true reports when more matched.",
    ),
  harness: harnessArg,
})).refine(
  (args) =>
    !(
      args.itemIds ||
      args.item ||
      args.ids ||
      args.itemId ||
      args.items ||
      args.item_ids ||
      args.item_id
    ) ||
    Boolean(args.slug),
  "itemIds requires an exact plan slug; cross-plan item selection is not supported",
);

interface ItemRow {
  plan: string;
  archived: boolean;
  item: ResolvedItem;
  /** Open engineer-issue ids blocking this item (coord_links rel='blocks'), if any. */
  blockedByIssues?: string[];
  /** "Is anyone working this?" rolled up from linked work-items + any direct claim
   *  (plan-item-coverage). Present only when there's a signal (a link or a claim);
   *  absent ⇒ genuinely unworked (coverage 'none'). */
  coverage?: CompactCoverage;
  /** EI-18679411140143743: every linked work-item is DONE (coverage 'complete')
   *  but this item's own status is still non-terminal — a silent divergence
   *  (completion never propagated, or propagated then the item reopened without
   *  its work-item following). Present only when true, so a leader burn-down
   *  read / monitor loop can flag it instead of silently under-counting. */
  coverageDivergence?: true;
  /** okf-frontmatter-adoption H(b): this item's PLAN owes the spec triad
   *  (`## Requirements` / `## Design` / items), so the item is held back from
   *  `actionable`. Present only when the plan is IN SCOPE for the requirement —
   *  i.e. created after the epoch, or opted in — and missing a leg. Never set
   *  for a plan that predates the requirement, which is what keeps the rule
   *  from freezing the existing corpus. See spec-triad-policy.ts. */
  specTriadMissing?: SpecTriadLegName[];
  /** EI-22173576329267385: CURRENT state of any WI-/EI- refs cited in this
   *  item's text — a work-item's title/citation is frozen at report time and
   *  never rewritten on closure, so a nonzero-terminal ref here means
   *  re-check the cited work-item before trusting this item's premise as
   *  live. Computed OUTSIDE the plan-content cache (like `coverage`): a
   *  cited work-item's state changes independently of the plan that quotes
   *  it. Diagnostic only — never adjudicates whether the citation is
   *  load-bearing or background; that stays a reading task. Present only
   *  when ≥1 cited ref resolves. */
  citedWorkItems?: CitedWorkItemRefState[];
}

interface SpecTriadDiagnostic {
  plan: string;
  missing: SpecTriadLegName[];
  scopeReason: SpecTriadScopeReason;
  note: string;
}

export default defineTool({
  name: "plans:items",
  description:
    'Plan-item query across one or all plans. `item:"P-NNN"` (one) or `itemIds:[…]` (many, homogeneous — `ids`/`itemId`/`items`/`item_ids` all alias `itemIds`) restrict results to exact ids from the required `slug` plan; cross-plan item selection is rejected. actionable=true returns pickable items (todo, not live-held). needsHuman=true returns the human\'s inbox. status filters by effectiveStatus. Legacy plans excluded. With an exact `slug`, operator/superuser scope auto-resolves the owning harness within the caller\'s workspace. Cross-plan queries still require a concrete `harness`; `harness: \'all\'` is valid only in an unscoped (--all-workspaces) session.',
  guidance: {
    when: 'You want to find items by status across all plans — "what can I pick up", "what needs the human", or filter one exact plan\'s items. Use `item:"P-NNN"` (one, matching plans:get-item\'s convention) or `itemIds:[…]` (many) with `slug` for exact item selection. An UNSCOPED session\'s exact-slug reads can auto-resolve their harness; a session already scoped to a concrete harness stays scoped to it (a miss names the actual owner). Cross-plan reads must name one.',
    notWhen:
      "You want the full plan structure (Now block, decisions, prose) — use plans:get.",
    chaining:
      "plans:items { actionable: true, harness } → plans:get { slug } for context on the picked item; or plans:items { slug, itemIds:[…] } for an exact subset of one auto-resolved plan.",
  },
  capability: "plans:read",
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // + overwatch (overwatch-role-2026-06-15 B-01): reads plan items to detect stalled work.
  // + worker/cup (EI-939): a pipeline/hive worker needs a read path to a checkbox-style
  // roadmap plan's items before it can safely mark progress — see plans:get's ALL_ROLES
  // comment for the full rationale. Read-only (capability: plans:read).
  agentRoles: [...SU_ROLES, "kettle", "worker", "cup"],
  modality: ["text"],
  args: argsSchema,
  // context-trimming-tiers P-021: trimmed/standard sessions get flattened,
  // row-capped item rows (see items-shape.ts). The cache stores the UNSHAPED
  // rows; the UI (HTTP/sync path, no ctx_tier) reads full.
  shape: {
    standard: (data) => shapePlansItems(data, "standard"),
    trimmed: (data) => shapePlansItems(data, "trimmed"),
    // WI-2145871. `shapePlansItems` REBUILDS every row from the `base` object
    // literal (items-shape.ts), so a field dropped from that literal vanishes
    // from the tier agents get BY DEFAULT while the result still reads ok:true
    // — the field looks absent from the data rather than removed by the shaper.
    //
    // WHY THESE THIRTEEN, AND ONLY THESE. `project()` has two emission paths:
    // `base` (trimmed) and `{ ...base, blockedBy, … , archived }` (standard).
    // The keys emitted UNCONDITIONALLY by both are exactly `base`'s, and each is
    // an explicit key in that literal (`r.x ?? null` / `clip(...)` / a count),
    // never a conditional spread — so none can disappear merely by being falsy.
    // The standard-only extras are deliberately NOT pinned: this check runs the
    // TRIMMED shaper, so pinning them would assert nothing.
    //
    // SECOND EMISSION PATH, and why it is PROVEN rather than reasoned. Past
    // PLANS_ITEMS_TIER_CAPS.trimmed.rows (60) the shaper APPENDS an over-cap
    // sentinel row `{ ...project({}), plan: '(truncated)', text: 'showing N of M' }`.
    // checkTrimmedContract synthesises ONE row and inspects `rows[0]` only, so it
    // reaches neither the branch nor the appended row — a key pinned on its
    // evidence alone could be green here and missing from the row a capped reader
    // actually sees (the fleet:leader-brief budget-path trap, same wake). The
    // sentinel spreads `project({})` so it SHOULD be key-complete, but that is
    // the same "structurally guaranteed" reasoning that was wrong for
    // leader-brief. Verified instead:
    // `.papercusp/scratch/plans-items-contract-teeth.mts` runs a 1-row arm and a
    // 61-row arm, asserts the 61-row arm genuinely reached the sentinel
    // (`plan === '(truncated)'`), and carries `archived` as a NEGATIVE CONTROL
    // (standard-only, so it must be ABSENT from every trimmed row) — without
    // which "all 13 survived" would pass identically on a probe that cannot see
    // an absent key.
    //
    // `plan` and `text` are also the truncation guard — the sentinel row
    // overwrites exactly those two — so losing either leaves a capped list
    // looking complete.
    //
    // No `preserve`: the shaper returns `{ ...data, items: rows }`, so every
    // top-level key survives unconditionally and a preserve pin would be
    // decoration — green forever, guarding nothing, and counted as guarded by
    // the next reader. Rows-only is a legitimate opt-in (the contract's entry
    // test is the UNION of the two axes).
    contract: {
      rows: "items",
      fields: [
        "plan",
        "id",
        "status",
        "importance",
        "needsHuman",
        "text",
        "text_truncated",
        "phase",
        "blockers",
        "working",
        "diverged",
        "specTriadMissing",
        "citedTerminalRefs",
      ],
    },
  },
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    // The named-query/admin dispatch is a display-only scan feed. Its UI
    // projection drops coverage before serialization, so computing the live
    // coordination overlay there is pure discarded work (and was the dominant
    // measured latency on the 150ms sync-read budget). Agent/MCP callers keep
    // the full liveness-aware coverage contract.
    const uiDisplayRead = (ctx as { uiClientId?: string }).uiClientId === "pc-admin-plans-ui";
    // EI-21194994217912029: exact-slug scope recovery for single-plan reads —
    // a caller passing `slug` without any resolvable harness gets the owning
    // harness resolved from the PG index instead of a bare harness_required.
    // Cross-plan queries keep the unchanged gate below.
    const scope = resolveHarnessScope(args.harness, ctx);
    let sctx: typeof ctx & { harnessSlug: string };
    if (scope.kind === "none" && args.slug) {
      const decision = await recoverHarnessFromSlugs(ctx, [args.slug]);
      if (decision.status !== "resolved") return slugScopeErrorResult("plans:items", decision);
      sctx = { ...ctx, harnessSlug: decision.harnessSlug };
      ctxAny.metadata?.({
        harnessAutoResolved: decision.bySlug,
        ...(Object.keys(decision.ambiguous).length > 0
          ? { harnessAmbiguous: decision.ambiguous }
          : {}),
      });
    } else {
      sctx = harnessScopedCtx(args.harness, ctx);
    }
    const opts = await ctxToPlanSourceOpts(sctx);
    const ambientCallerHarness = !args.harness && scope.kind === "harness" ? scope.slug : null;
    const explicitCallerHarness = args.harness && scope.kind === "harness" ? scope.slug : null;
    // A concrete ambient harness is part of the read scope. If the exact slug
    // is known to live elsewhere, disclose the owning harness instead of
    // returning a bare not_found that looks like a missing plan.
    if (ambientCallerHarness && args.slug) {
      const mismatch = await harnessMismatchForMiss(ctx, ambientCallerHarness, args.slug, "ambient");
      if (mismatch) {
        ctxAny.metadata?.({
          slug: args.slug,
          searchedHarness: ambientCallerHarness,
          harnessMismatch: mismatch,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "not_found",
                slug: args.slug,
                harness: ambientCallerHarness,
                harnessMismatch: mismatch,
              }),
            },
          ],
          isError: true,
        };
      }
    }
    const includeArchived = args.includeArchived === true;
    // Resolve every exact-item alias spelling into the canonical `itemIds`
    // array. Precedence is fixed and documented on each argument:
    // itemIds > item > ids > itemId > items > item_ids. An explicit `itemIds`
    // always wins, so a caller who names the canonical field can never have it
    // silently overridden by a stray alias.
    const itemIds =
      args.itemIds ??
      (args.item ? [args.item] : undefined) ??
      args.ids ??
      (args.itemId ? [args.itemId] : undefined) ??
      args.items ??
      args.item_ids ??
      (args.item_id ? [args.item_id] : undefined);

    // okf-frontmatter-adoption H(b). Read OUTSIDE the cached closure so the flag
    // is part of the cache KEY — flipping the kill-switch must change the answer
    // on the next call, not 45s later. Fail-open on a flag-store error: a flags
    // outage must never gate items, because the failure it would produce
    // (everything non-actionable) is the exact fleet freeze this feature is
    // designed around.
    let specTriadFlag = false;
    try {
      specTriadFlag = await getFlag(FLAGS.SPEC_TRIAD_REQUIRED, "system:plans-items");
    } catch {
      specTriadFlag = false;
    }
    const specTriadOpts = { flagEnabled: specTriadFlag, epoch: specTriadEpoch() };

    // Cache the cross-plan plan/status aggregation (cache-expensive-reads-round2-2026-06-23
    // P-002). plans:items is the LARGEST read payload measured (37KB / p95 2s); its plan
    // projection is PURE + non-principal (depends only on workspace+harness+args —
    // `needsHuman` keys on the DERIVED item band, not the caller). The coverage overlay is
    // deliberately applied below, outside this cache: it folds fleet claims and liveness,
    // which change independently of the plan tables. Caching it made a stale
    // `held-not-live` verdict survive while coord:presence reported the holder live
    // (EI-20227161050679465).
    const cached = await cachedRead(
      ctx as CachedReadCtx,
      {
        tool: "plans:items",
        key: {
          slug: args.slug ?? null,
          status: args.status ?? null,
          actionable: args.actionable === true,
          needsHuman: args.needsHuman === true,
          includeArchived,
          limit: args.limit ?? null,
          itemIds: itemIds ?? null,
          harness: opts.harnessSlug,
          specTriad: specTriadFlag,
        },
        tags: ["harness_plans", "plan_revisions", "plan_runs"],
        softTtlMs: PLANS_ITEMS_SOFT_TTL_MS,
        // P-024/D-082: the portal can land on any operator worker. Share the
        // plan/status projection through the durable cache so a worker-local
        // cold start does not rebuild the same cross-plan index after another
        // worker already did; tag invalidation and the 45s SWR contract stay
        // identical to the L1 path.
        l2: true,
      },
      async () => {
        // PG-canonical: read the structured rows (no content-blob parse for plans that
        // carry the derived `items` index — Stage 3); planItemsForRow falls back to a
        // parse only when the index is absent.
        let planRows: PlanIndexRow[] = [];

        if (args.slug) {
          let one: PlanRow | null;
          try {
            one = await getPlanRow(args.slug, opts);
          } catch (error) {
            if (isUnknownPlanScopeError(error)) {
              return {
                rows: [] as ItemRow[],
                unknownHarnesses: [opts.harnessSlug],
                specTriadDiagnostics: [] as SpecTriadDiagnostic[],
              };
            }
            throw error;
          }
          if (!one) return { notFound: true as const, unknownHarnesses: [] };
          if (!one.archived || includeArchived) {
            planRows = [one];
          }
        } else {
          try {
            // `plans:items` consumes the normalized item index and never needs
            // the canonical markdown blob on the common path. The old full-row
            // reader detoasted/transferred every plan body before filtering,
            // which made this resolver pay for ~30 MB of unrelated content.
            planRows = await listPlanIndexRows({ includeArchived, ...opts, includeItems: true });
          } catch (error) {
            if (isUnknownPlanScopeError(error)) {
              return {
                rows: [] as ItemRow[],
                unknownHarnesses: [opts.harnessSlug],
                specTriadDiagnostics: [] as SpecTriadDiagnostic[],
              };
            }
            throw error;
          }
        }

        // Index rows intentionally omit content. Fetch markdown only for the
        // rows that need the parser fallback (projection gaps) or the enabled
        // spec-triad policy. The latter is a deliberate full candidate fetch:
        // explicit `specTriad: required|exempt` declarations override the epoch
        // and cannot be inferred from index metadata alone.
        let contentBySlug = new Map<string, string>();
        const contentSlugs = new Set(
          planRows
            .filter((row) => !Array.isArray(row.items) || row.items.length === 0)
            .map((row) => row.planSlug),
        );
        if (specTriadFlag) {
          try {
            const declared = await getPlanSlugsWithSpecTriadDeclaration({
              ...opts,
              includeArchived,
            });
            for (const row of planRows) {
              if (
                declared.has(row.planSlug) ||
                planInSpecTriadScope(
                  { content: "", created: row.created },
                  specTriadOpts,
                ).inScope
              ) {
                contentSlugs.add(row.planSlug);
              }
            }
          } catch {
            // Preserve declaration precedence if the metadata probe fails. A
            // slower full candidate fetch is safer than silently ignoring a
            // pre-epoch `specTriad: required` opt-in.
            for (const row of planRows) contentSlugs.add(row.planSlug);
          }
        }
        if (contentSlugs.size > 0) {
          try {
            contentBySlug = await getPlanContentsBySlugs([...contentSlugs], opts);
          } catch {
            // A projection-gap/content read failure degrades to the structured
            // index; spec-triad then fails open via its empty-content policy.
          }
        }

        const rows: ItemRow[] = [];
        const specTriadDiagnostics: SpecTriadDiagnostic[] = [];

        // engineer-issues D-005: one batch read of every open issue-block across all
        // plans (keyed '<slug>#<item>'), hoisted out of the plan loop. Overlaying it
        // onto effectiveStatus BEFORE the filters below means an item blocked by an
        // open issue correctly drops out of `actionable` (no longer `todo`) and is
        // found by `status:'blocked'`. Non-fatal — degrades to resolver-only on error.
        let allBlocked = new Map<string, string[]>();
        try {
          allBlocked = await getAllBlockedPlanItems();
        } catch {
          // Non-fatal — no issue-block overlay.
        }

        for (const row of planRows) {
          if (row.isLegacy) continue;
          if (isTerminalPlanHiddenFromCrossPlan(row.status, args)) continue;
          const planItems = planItemsForRow({
            ...row,
            content: contentBySlug.get(row.planSlug) ?? "",
          } as PlanIndexRow & { content: string });
          const { items: resolvedItems, blockingIssues } = applyPlanItemBlocks(
            resolveEffectiveStatusForItems(planItems).items,
            (id) => allBlocked.get(planItemRef(row.planSlug, id)),
          );

          // okf-frontmatter-adoption H(b): a plan IN SCOPE for the spec triad and
          // missing a leg holds its items back from `actionable`.
          //
          // Deliberately NOT expressed by rewriting effectiveStatus to 'blocked'.
          // effectiveStatus is read by `system:plan-item-lane-sync`, which HOLDS a
          // linked work-item open on a non-terminal item — so a plan-level
          // authoring gap would have stranded real work-items in a state
          // `work_items:complete` refuses (the EI-19412899868617052 shape, one
          // level up). The gate belongs to the `actionable` QUESTION, which is
          // exactly what the design asked for; the item's own status is untouched
          // and every other consumer sees it unchanged.
          const triad = specTriadGate(
            {
              planSlug: row.planSlug,
              content: contentBySlug.get(row.planSlug) ?? "",
              created: row.created,
              itemCount: planItems.length,
            },
            specTriadOpts,
          );

          // Surface the plan-level reason before item filters run. In particular,
          // actionable=true intentionally removes every gated row, so without
          // this diagnostic the empty result is indistinguishable from a drained
          // plan. Keep the row-level `specTriadMissing` below for non-actionable
          // reads, where the item itself remains visible.
          if (triad.gated) {
            specTriadDiagnostics.push({
              plan: row.planSlug,
              missing: triad.missing,
              scopeReason: triad.scope.reason,
              note: triad.note ?? "",
            });
          }

          for (const item of resolvedItems) {
            if (itemIds && !itemIds.includes(item.id)) continue;
            if (args.actionable && item.effectiveStatus !== "todo") continue;
            if (args.actionable && triad.gated) continue;
            // needsHuman keys on the DERIVED top band (B-12 / P-072), not the raw
            // stored token — so an authority=owner item gates the orchestrator DONE-gate
            // and, once the owner arms autonomy (P-092), a high-risk item above its
            // ceiling does too. Behavior-neutral today: `needsHuman` equals
            // `storedStatus === 'needs-human'` while unarmed (D-007).
            if (args.needsHuman && !item.needsHuman) continue;
            if (args.status && item.effectiveStatus !== args.status) continue;
            rows.push({
              plan: row.planSlug,
              archived: row.archived,
              item,
              ...(blockingIssues[item.id]
                ? { blockedByIssues: blockingIssues[item.id] }
                : {}),
              ...(triad.gated ? { specTriadMissing: triad.missing } : {}),
            });
          }
        }

        // Sort by importance (urgent→low); the array index in IMPORTANCE_LEVELS
        // is the rank. Array.sort is stable, so equal-importance rows keep their
        // collection order (≈ age within a plan) — the "then age" tiebreaker.
        const normalRank = IMPORTANCE_LEVELS.indexOf("normal");
        const impRank = (it: ResolvedItem): number => {
          const r = IMPORTANCE_LEVELS.indexOf(it.importance);
          return r === -1 ? normalRank : r;
        };
        rows.sort((a, b) => impRank(a.item) - impRank(b.item));

        return { rows, unknownHarnesses: [], specTriadDiagnostics };
      },
    );

    // not_found (explicit single-slug query for a missing plan) — cached too, so a
    // plan-create write busts it via the harness_plans tag.
    if ("notFound" in cached) {
      // An explicit harness is usually the right one, so only pay the exact-slug
      // index lookup when the scoped read actually misses.
      if (explicitCallerHarness && args.slug) {
        const mismatch = await harnessMismatchForMiss(ctx, explicitCallerHarness, args.slug, "explicit");
        if (mismatch) {
          ctxAny.metadata?.({
            slug: args.slug,
            searchedHarness: explicitCallerHarness,
            harnessMismatch: mismatch,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "not_found",
                  slug: args.slug,
                  harness: explicitCallerHarness,
                  harnessMismatch: mismatch,
                }),
              },
            ],
            isError: true,
          };
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "not_found", slug: args.slug }),
          },
        ],
        isError: true,
      };
    }
    const specTriadDiagnostics = cached.specTriadDiagnostics;
    // Coverage rollup (work→plan_item edges + direct plan-item claim) is a live
    // coordination read, not plan content. Refresh it on every call so a plan-table
    // cache hit cannot replay a liveness verdict from before a claim or heartbeat
    // changed. This also strips coverage fields from an entry created by an older
    // handler version before applying the fresh overlay.
    let coverage = new Map<string, PlanItemCoverage>();
    if (!uiDisplayRead && cached.rows.length > 0) {
      try {
        coverage = await getAllPlanItemCoverage({
          planItemRefs: cached.rows.map((row) => planItemRef(row.plan, row.item.id)),
        });
      } catch {
        // Non-fatal — no coverage overlay.
      }
    }
    // EI-22173576329267385: surface the CURRENT state of any WI-/EI- refs cited
    // in item prose, computed live (outside the plan-content cache) for the same
    // reason as coverage above — a cited work-item's state changes independently
    // of the plan that quotes it. One batch query for every distinct ref across
    // all rows; non-fatal on error (degrades to no citation overlay).
    const refsByRow = new Map<number, string[]>();
    let citedWorkItemStates = new Map<string, CitedWorkItemRefState>();
    if (!uiDisplayRead && cached.rows.length > 0) {
      const allRefs = new Set<string>();
      cached.rows.forEach((row, i) => {
        const refs = extractWorkItemRefs(row.item.text);
        if (refs.length > 0) {
          refsByRow.set(i, refs);
          for (const ref of refs) allRefs.add(ref);
        }
      });
      if (allRefs.size > 0) {
        try {
          citedWorkItemStates = await getWorkItemRefStates([...allRefs]);
        } catch {
          // Non-fatal — no citation overlay.
        }
      }
    }
    // The cached plan read can only filter the plan item's own effective status.
    // Linked work-item state is live coverage, so apply this claimability floor
    // after refreshing coverage; otherwise a todo plan item linked to a blocked
    // work-item is returned by actionable=true before the coverage overlay exists.
    // EI-22174704695369849: an item a LIVE peer is holding is not "pickable right
    // now". Counted, not just dropped — see `withheldLiveHeld` below.
    let withheldLiveHeld = 0;
    const rows = cached.rows.flatMap((row, i) => {
      const cov = coverage.get(planItemRef(row.plan, row.item.id));
      if (args.actionable && cov?.links.some((link) => link.blocked === true)) return [];
      // EI-22174704695369849: `actionable` asserted pickability off effectiveStatus
      // alone while the coverage computed three lines up — and returned to the
      // caller as `working` — already said a live agent held it. The refuting data
      // was never elsewhere or expensive; the filter simply did not consult it.
      // Same placement and same reason as the blocked-link floor directly above:
      // this is live state, so it must be applied after the coverage refresh, not
      // against the plan-content cache. Only the live-held bands are withheld —
      // `isLiveHeldCoverage` documents why held-not-live/held-stalled/complete
      // deliberately stay offerable.
      if (args.actionable && isLiveHeldCoverage(cov?.level)) {
        withheldLiveHeld += 1;
        return [];
      }
      const freshRow = { ...row };
      delete freshRow.coverage;
      delete freshRow.coverageDivergence;
      delete freshRow.citedWorkItems;
      const citedWorkItems = (refsByRow.get(i) ?? [])
        .map((ref) => citedWorkItemStates.get(ref))
        .filter((s): s is CitedWorkItemRefState => s !== undefined);
      return [{
        ...freshRow,
        ...(cov ? { coverage: compactCoverage(cov) } : {}),
        ...(cov && isCoverageDivergent(row.item.effectiveStatus, cov.level)
          ? { coverageDivergence: true as const }
          : {}),
        ...(citedWorkItems.length > 0 ? { citedWorkItems } : {}),
      }];
    });

    const truncated = args.limit !== undefined && rows.length > args.limit;
    const limitedRows = truncated ? rows.slice(0, args.limit) : rows;

    ctxAny.metadata?.({
      count: limitedRows.length,
      totalCount: rows.length,
      actionable: !!args.actionable,
      needsHuman: !!args.needsHuman,
      scope: args.slug ?? "all",
      ...(withheldLiveHeld > 0 ? { withheldLiveHeld } : {}),
      ...(cached.unknownHarnesses.length > 0
        ? { unknownHarnesses: cached.unknownHarnesses }
        : {}),
      ...(truncated ? { truncated: true } : {}),
    });

    // {data} envelope so the payload-tier shapers apply; HTTP/sync consumers
    // still read identical `{"items":[...]}` JSON text.
    return {
      data: {
        items: limitedRows,
        // A gated plan contributes no actionable rows by design, so keep its
        // plan-level explanation visible even when `items` is empty. Unknown
        // plan scopes explicitly carry an empty array to preserve the
        // diagnostic contract without inventing a plan-level reason.
        ...(specTriadDiagnostics.length > 0 || cached.unknownHarnesses.length > 0
          ? { specTriadDiagnostics }
          : {}),
        ...(truncated ? { truncated: true } : {}),
        // EI-22174704695369849: how many `todo` items this `actionable` query
        // withheld because a LIVE holder is on them. Returned to the CALLER, not
        // just telemetry, and deliberately so: silently dropping rows converts
        // this bug into its worse inverse, where a short (or empty) list reads as
        // a drained plan and stands a fleet member down (EI-20043747805764486).
        // A caller seeing `actionable: []` beside a nonzero count here knows the
        // plan has work and that the move is to coordinate, not to conclude it is
        // finished. Absent when nothing was withheld, so the common path is
        // unchanged.
        ...(withheldLiveHeld > 0 ? { withheldLiveHeld } : {}),
      },
    };
  },
});
