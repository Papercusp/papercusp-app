/**
 * plans:get — full parsed structure for one plan.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 * Returns frontmatter, ## Now, items (with both storedStatus AND
 * effectiveStatus), decisions, and (mode=full) the prose body. Resolves
 * both docs/plans/ and docs/plans/archive/ — archived doesn't make a plan
 * unreachable.
 *
 * Payload diet (token-usage-reduction-audit-2026-06-09 P-008): plans:get was
 * the #3 tool-result payload fleet-wide (mean 13.9KB/call). `full` no longer
 * returns `raw` next to `prose` (the same document twice — frontmatter is
 * already structured in the base; exact raw bytes live behind plans:export),
 * and `sections` strips per-item `rawLine` (duplicates text/status/phase;
 * same precedent as plans:items). `full` keeps rawLine for surgical edits.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { readPlanBySlug, resolvePlanScope } from './source';
import { ctxToPlanSourceOpts, resolveEffectiveHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx, resolveHarnessScope } from '../_harness-scope';
import { harnessMismatchForMiss, recoverHarnessFromSlugs, slugScopeErrorResult } from './slug-scope';
import { resolveEffectiveStatus } from './effective-status';
import { reconcileStartStatus } from './plan-start-state';
import { hashPlanContent } from './content-hash';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { computePlanItemTestStatus, type PlanItemTestStatus } from '../../harness-test-rollup';
import { overlayIssueBlocksForPlan } from '../../issue-blocks-merge';
import { planItemProvenanceFromRow } from '../../plan-item-provenance';
import { boundRowField } from '../_bound-output';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { cachedRead, type CachedReadCtx } from '../../cache';
import { shapePlansGet } from './get-shape';
import { decoratePlanNowBlock } from './liveness-decoration';
import { reconcileNowNext } from './now-next-derivation';
import { derivePlanLifecycleForRead, normalizeActivityTimestamp } from './plan-lifecycle-derivation';
import { markGrindingItems, readGrindingItems } from '../../verification-attempts/plan-grinding';
import { readIterationMetrics } from '../../verification-attempts/plan-iteration-metrics';
import type { PlanLifecycleReconciliation } from '@papercusp/plan-parser';
import { getAcceptanceRubricForPlan } from '../../rubrics';
import { getLatestPlanAudit } from '../../plan-audits';
import { splitPlanSections } from './plan-sections';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { getDoorConstantsSync } from '../../context-doors-config';
import { getStalePathRefsForSubjects, stalePathRefsNote } from '../../stale-path-hints-claim-port';
import { evidenceCurrentInputSchema } from './spec-evidence-store';
import { readPlanHistoryContext, resolvePriorAttemptRefs } from '../../prior-attempt-context';
import { resolveAgentIdentity } from '../coordination/identity';
import { previewPlanStartConsult } from './get-activation-readiness';
import { getBuildInfo } from '../../build-info';

/**
 * SWR backstop for plans:get (cache-expensive-tool-reads-round2-2026-06-23 P-001).
 * Mirrors plans:list: the plan tables
 * (harness_plans/plan_revisions/plan_runs/plan_audits) are
 * trigger-covered, so any plan write auto-invalidates the entry via the cache-ECA;
 * this short soft TTL only bounds staleness for the un-triggered DECORATIONS the
 * per-slug read folds in (issue-block overlay via coord_links, linkedFeatures via
 * harness_features_consolidated, planItemTests via harness_plan_assertions/tests).
 * The read is PURE + non-principal-scoped (depends only on workspace+harness+slug+mode).
 */
const PLANS_GET_SOFT_TTL_MS = 45_000;

/**
 * Harness-mismatch disclosure is implemented in the shared slug-scope helper.
 *
 * A resumed/cold loop can retain a concrete harness from an earlier task, and a
 * carried checkpoint can name the wrong one outright. Do not silently rebind the
 * read across a hive boundary, but do use the exact slug index to make the miss
 * actionable. The lookup is best-effort: if the index is unavailable, the
 * ordinary not_found result remains unchanged.
 *
 * EI-21449048020722730: this disclosure used to be withheld whenever the caller
 * passed `harness` explicitly, so the MORE specific call was told LESS — an
 * explicit miss returned a bare `not_found`, which reads as "this plan does not
 * exist" when the truth is "it exists, in another harness". Both sources get the
 * disclosure now; only the wording differs, because the fix differs (an explicit
 * caller re-passes the right harness or omits it to auto-resolve, while an
 * ambient caller has to name one to escape the inherited scope).
 */
// + overwatch (overwatch-role-2026-06-15 B-01): the system-health supervisor reads full
// plans to ground its nudges (read-only — its cap is plans:read, never plans:write).
// + worker/cup (EI-939): a pipeline worker or generic Hive worker told to "mark plan
// progress" on a checkbox-style roadmap plan had no read path at all — plans:set-status
// only flips the structured `- **P-NNN** \`status\`` line format, and plans:set-content
// needs the current version/contentHash from plans:get for its CAS, so a bee blind to
// this tool risked clobbering a peer's plan edit or hand-copying an untracked docs/plans
// mirror that lags PG. Read-only (capability: plans:read) — never grants a write path.
// The evidence-only gym judge also needs the plan itself to evaluate accepted specs;
// keep that role on the explicit allowlist rather than broadening the SU role set.
// `release-fixer` is on this allowlist because its runbook's attribution procedure
// mandates it: git blame is worthless here (git-sync commits the whole tree under one
// identity — WI-5111), so the persona directs the fixer to attribute a regression via
// "the commissioning work-item/plan-item (`work_items:list`/`plans:get` around the
// change's timestamp)". The `release-fix` blueprint declares `plans:get` in its
// `dependencies.tools` for the same reason. Read-only (capability: plans:read, granted
// to the role in role-principal-caps.ts) — never a write path. Derived + enforced by
// ../../release/release-fixer-tool-contract.test.ts.
const ALL_ROLES = [...SU_ROLES, 'promote', 'kettle', 'worker', 'cup', 'judge', 'release-fixer'] as const;

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z
      .string()
      .min(1)
      .optional()
      .describe('Plan slug (filename without .md). Resolves both docs/plans/ and docs/plans/archive/.'),
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .optional()
      .describe('Plan slugs to fetch in one call. Equivalent to calling this tool once per slug.'),
    items: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        'Return only these P-NNN records from the structured items array. Counts still describe the whole plan; itemSelection reports requested/matched/missing ids. Use this instead of pulling a large plan or querying harness_plans directly when you need one item.',
      ),
    // EI-22056792132086608: plans:items' selector is `itemIds`, so a caller
    // moving between the two tools writes `itemIds` here and hits invalid_args
    // ("Unrecognized key: itemIds; live schema accepts items"). Same one
    // meaning, different spelling; `items` wins when both are supplied.
    itemIds: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        "Compatibility alias for `items` (plans:items' spelling of the same selector); `items` wins when both are supplied.",
      ),
    decisionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Return one decision by id with its complete body from the plan named by slug (decision ids are plan-local, so slug or slugs is still required). This is a narrow selection/CAS read; decisionSelection reports the requested, matched, and missing ids.',
      ),
    decisions: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        'Return only these decision ids with complete bodies from the plans named by slug/slugs (decision ids are plan-local, so slug or slugs is still required). This is a narrow selection/CAS read; counts still describe the whole plan and decisionSelection reports requested/matched/missing ids.',
      ),
    // tool-contract-repair-2026-09-05 P-006: the plural `decisionIds` is the
    // name callers reach for by symmetry with `itemIds` elsewhere in the plans
    // family, and the singular `decisionId` already exists here — so the array
    // form reads as `decisionIds` and got filed as invalid_args (12 filings on
    // this shape, e.g. EI-21158047068641416 "Caller used decisionId:[D-039..D-042];
    // live schema requires decisions:[...]"). It is an unambiguous synonym for
    // `decisions`; `decisions` wins when both are supplied.
    decisionIds: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        'Compatibility alias for `decisions` (plural naming, matching `itemIds`); `decisions` wins when both are supplied.',
      ),
    mode: z
      .enum(['meta', 'sections', 'full'])
      .optional()
      .describe(
        'Response depth: meta = frontmatter, Now, counts, section headings; sections (default) adds structured items/decisions, excerpting long decision bodies with explicit truncation flags; full adds markdown prose, item rawLine, and complete decision bodies. Use plans:export for exact raw bytes.',
      ),
    // EI-21905561475819210: several generic plan readers use `detail` as the
    // read-depth control. Keep that established spelling executable here while
    // retaining `mode` as the canonical selector. `true`/`'full'` request the
    // full payload; `false`/`'summary'` retain plans:get's default sections
    // payload. When both are supplied, the explicit mode wins.
    detail: z
      .union([z.boolean(), z.enum(['summary', 'full'])])
      .optional()
      .describe(
        "Compatibility alias for `mode`: true or 'full' maps to mode:'full'; false or 'summary' maps to the default mode:'sections'. Explicit `mode` wins when both are supplied.",
      ),
    heading: z
      .string()
      .optional()
      .describe(
        "Return only the body of the section whose heading matches (case-insensitive), plus identity + the CAS baseline (contentHash/version) so you can edit what you just read — read one part of a long plan without pulling the whole body (like docs:get's heading-narrowing). Deliberately NOT the ## Now block, promotePolicy, or frontmatter.raw: EI-19478970139996135 measured those at 73% of a heading read, shipping the same prose three times over. `sectionIndex` comes back ONLY when the heading MISSES, which is when you need it to find the one you meant. Overrides mode.",
      ),
    includeHistory: z
      .boolean()
      .optional()
      .describe(
        'Include descendant work history on a full plan read (default true). Body-only UI readers may set false. An explicit History heading or priorAttemptRefs still retrieves the requested history.',
      ),
    includeEnrichments: z
      .boolean()
      .optional()
      .describe(
        'Live issue/feature/test/rubric/audit decorations (default true); false = fast body-first read.',
      ),
    includeRaw: z
      .boolean()
      .optional()
      .describe(
        'Also return the EXACT raw markdown file bytes as `raw` (full mode only). Off by default — the payload diet (P-008) drops `raw` because it duplicates `prose`+structured frontmatter, doubling agent tool-output. The plans admin UI sets this because it round-trips the whole document through plans:set-content (whose CAS hashes the raw bytes) and reconstructing raw from prose+frontmatter would not byte-match. Agents that just need the body should use `prose`; for a standalone dump use plans:export.',
      ),
    // EI-21913230259449717: a caller reached for the generic `include` (the
    // shape other read tools use for a boolean opt-in) instead of this tool's
    // specific `includeRaw` and hit invalid_args before any read ran. Accept
    // it as a compatibility alias, same precedent as plans:items' `item`/
    // `itemIds` and add-decision's `itemRefs`/`refs`; `includeRaw` wins when
    // both are supplied.
    include: z
      .boolean()
      .optional()
      .describe('Compatibility alias for `includeRaw`; `includeRaw` wins when both are supplied.'),
    // EI-21967410937471873: the ship-blocker verdict was already computed
    // read-only, but only the UI could reach it (the plans.acceptanceGate sync
    // resolver). An agent's sole route to the same answer was to ATTEMPT
    // plans:set-plan-status and read the refusal — so agents guessed the blocker
    // instead and wrote the guess into `## Now`, where successors inherited it
    // unverified. Measured cost on dead-target-routine-reaper-2026-08-30: ~11h
    // waiting on a green-checkpoint gate that was never the blocker (the real
    // one was audit_coverage_stale). This exposes the EXISTING evaluator; it
    // does not add a second definition of the verdict.
    priorAttemptRefs: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe('Recover exact raw refs from this plan history; missing refs remain explicit.'),
    operationalBrief: z
      .boolean()
      .optional()
      .describe(
        'Add `operationalBrief`: current phase, next executable item, blockers, authority, acceptance state and last verified evidence, projected from this same read. Fields not measured here are explicit `unknown` with a reason, never zero. Combine with shipReadiness:true for a measured ship verdict.',
      ),
    shipReadiness: z
      .boolean()
      .optional()
      .describe(
        "What blocks this plan's ship now, without the write: `shipReadiness` from the SAME evaluator plans:set-plan-status enforces (`satisfied`/`code` authoritative; the BAR snapshot's traces + `nextRepair` explain the rest). ⚠ ONE gate blocker at a time. ⚠ `satisfied:true` is not a clean pass until `skipped`, `forcedPast` and `unavailableReason` are read. Opt-in; not on heading/decisionId reads.",
      ),
    current: z
      .array(evidenceCurrentInputSchema)
      .max(2000)
      .optional()
      .describe(
        'shipReadiness proof: freshly measured evidence fingerprints, identical to plans:set-plan-status current. Missing comparisons remain unknown and cannot establish fulfillment.',
      ),
    activationReadiness: z
      .boolean()
      .optional()
      .describe(
        "Ask for the side-effect-free activation readiness preview. Returns `activationReadiness.consult` with the same selected candidates, evidence, selection provenance, and honest no-responder/degraded outcome that `plans:start` would evaluate — without opening a consult or changing the plan. Use this before `plans:audit { phase:'activation' }` or plans:start so feedback can shape first-class clauses early.",
      ),
    efficiency: z
      .boolean()
      .optional()
      .describe(
        "Add `efficiency`: the plan's agent MCP calls (goal_ref in its work items) by purpose, failed calls by class, calls on dropped items, holder changes, and holders' active/idle wall-clock. Counts are floors (native tools write no row).",
      ),
  })
  .refine((v) => !!v.slug || !!v.slugs?.length, {
    message: 'Provide slug or slugs; decisionId/decisions select within a plan because D-NNN ids are plan-local.',
  });

interface PlanSection {
  heading: string;
  level: number;
  chars: number;
}

/** Pure render seam so the plans:get advisory shape is regression-testable. */
export function decoratePlanItemStalePathRefs<T extends { id: string }>(
  item: T,
  stalePathRefsByItem: Readonly<Record<string, readonly string[]>>,
): T & { stalePathRefs?: readonly string[]; stalePathRefsNote?: string } {
  const refs = stalePathRefsByItem[item.id];
  return refs && refs.length > 0
    ? {
        ...item,
        stalePathRefs: refs,
        stalePathRefsNote: stalePathRefsNote([...refs]) ?? undefined,
      }
    : item;
}

// WI-274: bound decision bodies in plans:get `sections` mode so a decision-heavy
// plan can't overflow the agent tool-output cap (the round-4 plan hit 56KB on one
// line → spilled to a file). `full` mode keeps complete bodies. Per-decision cap =
// min(CAP, floor(BUDGET / n)) — the same budget-aware bound coord:inbox uses
// (EI-1752): total decision text stays bounded at ANY plan size, while normal plans
// keep most decisions in full (only the few long ones are excerpted).
export const DECISION_BODY_CAP = 1000;
export const DECISIONS_TOTAL_BUDGET = 15_000;

// EI-1597: a thin semantic wrapper over the shared budget-aware bound — single
// source of truth for the per-field excerpt (was an inlined copy of the loop).
export function boundDecisionBodies<T extends { body: string }>(decisions: T[]): T[] {
  return boundRowField(decisions, 'body', DECISION_BODY_CAP, DECISIONS_TOTAL_BUDGET);
}

/** Split a plan's markdown body into level-1/2 sections, tracking fenced code
 *  blocks so headings inside ``` aren't treated as section breaks. Powers the
 *  section index (mode meta/sections) + the `heading` narrowing without pulling
 *  the full prose. */
export const splitSections = (md: string): Array<PlanSection & { body: string }> =>
  splitPlanSections(md) as Array<PlanSection & { body: string }>;

/** Split ONE section body into its level-3 (`###`) subsections, tracking fenced
 *  code blocks so `###` lines inside ``` aren't treated as subsection breaks.
 *  Prose before the first `###` is not a subsection and is dropped.
 *
 *  Only used by the `heading` LOOKUP fallback below — deliberately NOT folded
 *  into splitSections(), so the section index, `counts.sections` and every
 *  existing payload stay byte-identical. */
function splitSubsections(body: string): Array<PlanSection & { body: string }> {
  const out: Array<PlanSection & { body: string }> = [];
  let cur: (PlanSection & { body: string }) | null = null;
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    if (cur) {
      cur.body = buf.join('\n').trim();
      cur.chars = cur.body.length;
      out.push(cur);
    }
  };
  for (const line of body.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (cur) buf.push(line);
      continue;
    }
    const m = !inFence ? /^###\s+(.*)$/.exec(line) : null;
    if (m) {
      flush();
      buf = [];
      cur = { heading: (m[1] ?? '').trim(), level: 3, chars: 0, body: '' };
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Resolve `heading` to a section — level 1/2 first, then level-3 subsections.
 *
 * EI-19459526252132133: decisions are `### D-NNN` subsections of `## Decisions`,
 * and splitSections indexes levels 1-2 only, so ONE decision was unreachable by
 * any read. `plans:add-decision`, `plans:ratify-decision` and
 * `plans:set-decision-body` all address a decision BY ID, so the store could be
 * written by id and not read back by id — the whole `## Decisions` section was
 * the smallest readable unit, and on a mature plan that section is exactly what
 * overflows the result door (measured: 16 decisions cut mid-D-002; a 30-decision
 * plan yielded D-001..D-004 while counts said 30). The truncation is honest
 * about WHAT it dropped (./shape-clip) but there was no call that recovers it.
 *
 * The fallback runs only when the level-1/2 lookup MISSES, so an existing call
 * can never change meaning: a plan with a `## Decisions` section still resolves
 * to that section, never to a subsection that happens to share the substring.
 */
export function findSection(
  sections: Array<PlanSection & { body: string }>,
  heading: string,
): (PlanSection & { body: string }) | null {
  const want = heading.trim().toLowerCase();
  const match = (list: Array<PlanSection & { body: string }>) =>
    list.find((s) => s.heading.toLowerCase() === want) ??
    list.find((s) => s.heading.toLowerCase().includes(want)) ??
    null;

  const top = match(sections);
  if (top) return top;

  // Flattened in section order so an ambiguous substring resolves to the first
  // match by document position — the same rule the level-1/2 lookup uses.
  return match(sections.flatMap((s) => splitSubsections(s.body)));
}

/**
 * Fields the `heading` narrowing drops from the meta envelope, because a caller
 * asking for ONE section demonstrably did not ask for them.
 *
 * EI-19478970139996135: `heading` used to spread the whole meta `base`, so a
 * heading read shipped the entire `## Now`, the parsed+raw frontmatter, the
 * promote policy and the full sectionIndex wrapped around the one section
 * requested. Measured on semantic-search-fingerprint-coverage-2026-08-03
 * (heading:'Now'): 7538 chars, of which the requested body was 2041 — a 73%
 * envelope shipping the same content THREE times (now.state + now.next ≈
 * now.raw ≈ section.body). Three of three heading reads blew the ~1500-token
 * result door and spilled to scratch.
 *
 * The perverse part, and the reason this is a real bug rather than a diet: the
 * `heading` form exists to AVOID a big read, so it is reached for exactly when a
 * plan is large — and a large plan has a large `## Now`, so the fixed envelope
 * was heaviest precisely in the case the feature exists to serve.
 */
const HEADING_DROPPED_FIELDS = new Set(['now', 'promotePolicy']);

/**
 * Build the `heading`-narrowed payload from the meta base. Shared by the legacy
 * and non-legacy branches so the two cannot drift (the legacy base simply
 * carries none of the dropped fields, making those rules no-ops there).
 *
 * `sectionIndex` is kept ONLY on a MISS: it is how a caller finds the heading
 * they actually meant, so it earns its ~750 chars when the lookup failed and is
 * dead weight when it succeeded.
 */
export function narrowHeadingPayload(
  base: Record<string, unknown>,
  heading: string,
  sec: (PlanSection & { body: string }) | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (HEADING_DROPPED_FIELDS.has(key)) continue;
    if (key === 'sectionIndex' && sec) continue;
    if (key === 'frontmatter' && value && typeof value === 'object') {
      // `raw` duplicates the parsed fields sitting beside it (measured 250 chars
      // of pure duplication). Filtered by key rather than destructured so this
      // holds whatever the parser adds later.
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => k !== 'raw'));
      continue;
    }
    out[key] = value;
  }
  out.heading = heading;
  out.section = sec ? { heading: sec.heading, level: sec.level, body: sec.body } : null;
  return out;
}

/**
 * The char budget one narrowed decision response may occupy, derived from the
 * SAME door computation the result-door will apply to this caller
 * (result-door.ts: `computeTurnDoors(0, getDoorConstantsSync(ownerId))`, then
 * `resultEach * CHARS_PER_TOKEN_ESTIMATE`). Deriving it rather than hardcoding
 * a constant is what keeps the two from drifting: a workspace or session that
 * widens its door widens the page with it, automatically.
 *
 * The budget is per RESPONSE while narrowing happens per PLAN, so a multi-slug
 * decision read splits it evenly. Even division is deliberately chosen over a
 * shared running remainder: the per-slug payloads are built inside a map whose
 * completion order is not guaranteed, and a budget that depended on that order
 * would page non-deterministically for identical inputs. Decision ids are
 * plan-local, so a multi-slug decision read is the rare case anyway.
 */
export function decisionPageBudgetChars(ownerId: string | null | undefined, planCount: number): number {
  const doors = computeTurnDoors(0, getDoorConstantsSync(ownerId));
  const perResponse = doors.resultEach * CHARS_PER_TOKEN_ESTIMATE;
  return Math.floor(perResponse / Math.max(1, planCount));
}

/**
 * Chars reserved, on top of the measured identity envelope, for the parts of
 * the response that do not exist yet when the page is chosen: the outer
 * `{ ok, results: [...] }` wrapper, the `decisionSelection` block (up to five
 * id arrays), the `decisionContinuation` block, and serialize-result's
 * advisory footer. Deliberately generous — under-reserving costs a spill (the
 * exact failure this pagination exists to prevent) while over-reserving costs
 * one extra page, so the asymmetry is priced in.
 */
const DECISION_PAGE_ENVELOPE_RESERVE_CHARS = 1_200;

/**
 * Choose how many of `selected` fit one response WITHOUT CLIPPING ANY BODY.
 *
 * The contract is all-or-nothing per decision: a decision is either returned
 * complete or named in `deferred`. A partially-returned body is the defect
 * this path exists to prevent (EI-21573289806322713), so it is not a state
 * this function can produce.
 *
 * PROGRESS GUARANTEE: the first decision is always returned, even when it
 * alone exceeds the budget. A single ruling larger than the door cannot be
 * made to fit by any paging strategy, and returning it (letting the door
 * spill it, with `deferred` naming the rest honestly) is strictly better than
 * returning an empty page — which would make the continuation non-terminating.
 */
export function pageDecisionsToBudget<T extends { id: string }>(
  envelope: Record<string, unknown>,
  selected: T[],
  budgetChars: number | undefined,
): { returned: T[]; deferred: string[] } {
  if (budgetChars == null || !Number.isFinite(budgetChars) || budgetChars <= 0 || selected.length <= 1) {
    return { returned: selected, deferred: [] };
  }
  const available = budgetChars - JSON.stringify(envelope).length - DECISION_PAGE_ENVELOPE_RESERVE_CHARS;
  const returned: T[] = [];
  let used = 0;
  for (const decision of selected) {
    // What this record ADDS to the serialized `decisions` array (+1 for the
    // separator) — not the body length alone.
    const cost = JSON.stringify(decision).length + 1;
    if (returned.length > 0 && used + cost > available) break;
    returned.push(decision);
    used += cost;
  }
  return {
    returned,
    deferred: selected.slice(returned.length).map((decision) => String(decision.id)),
  };
}

interface NarrowDecisionItemPayload {
  items: unknown[];
  itemSelection: {
    requested: string[];
    matched: string[];
    missing: string[];
  };
  linkedFeatures: Record<string, unknown>;
  planItemTests: Record<string, unknown>;
  blockingIssues: Record<string, unknown>;
}

/**
 * Build the decision-id-narrowed payload.
 *
 * A decision read exists specifically to recover a governing ruling whose
 * complete body did not fit in a plan read. Keep only identity/CAS fields
 * around the selected records; carrying the plan's prose, items, or
 * decorations here would recreate the overflow this selector is meant to
 * avoid. A combined item+decision selector opts into only its selected item
 * records and item-keyed decorations. `decisionSelection` is deliberately
 * in-band so a missing id cannot be mistaken for a complete read.
 *
 * EI-21573289806322713 — CONTINUATION, and why it is not truncation.
 *
 * Recovering a governing ruling is exactly the case where a partial answer is
 * worse than a smaller one: a clipped body still reads as the whole ruling,
 * and a plan Decision is the substrate other lanes are required to follow. So
 * when the selected bodies exceed one response's budget, they are split
 * ACROSS responses rather than shrunk within one.
 *
 * The continuation is STATELESS: `decisionContinuation.call` is a complete
 * plans:get argument set naming the deferred ids. Nothing expires, no
 * server-side page state has to survive a restart, and re-issuing it is
 * idempotent.
 *
 * `matched` keeps its established meaning — every requested id found in the
 * plan — so callers reading `matched`/`missing` are unaffected. `returned`
 * and `deferred` appear ONLY when a split actually happened, which is exactly
 * when `decisions.length < matched.length` would otherwise be an unexplained
 * discrepancy; their absence therefore means "complete". `missing` never
 * absorbs a deferred id: not-found and not-yet-sent are different answers and
 * stay in different fields.
 *
 * BOUNDARY, stated because it is easy to over-claim: sizing a response against
 * the caller's per-result door does NOT eliminate the reporter's
 * `aggregate-output-budget-exceeded`. That budget is shared across the sibling
 * tool calls in one hop (result-door.ts `reserveAggregateBytes`), and once a
 * cohort's budget is consumed every later result in it spills however small it
 * is. Paging shrinks each response — and a response under the per-result
 * ceiling is charged its true size instead of the ceiling — but a wide enough
 * fan-out still exhausts the cohort. Closing that gap needs the remaining
 * aggregate budget to be readable at payload-build time, which is a change to
 * the shared door and deliberately out of scope here.
 */
export function narrowDecisionPayload<T extends { id: string }>(
  base: Record<string, unknown>,
  requestedIds: string[],
  selected: T[],
  budgetChars?: number,
  itemPayload?: NarrowDecisionItemPayload,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const identityFields = new Set([
    'slug',
    'harness',
    'archived',
    'legacy',
    'frontmatter',
    'contentHash',
    'version',
    'filename',
    'forcedPast',
    'counts',
  ]);
  for (const [key, value] of Object.entries(base)) {
    if (!identityFields.has(key)) continue;
    if (key === 'frontmatter' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => k !== 'raw'));
      continue;
    }
    out[key] = value;
  }
  // A combined item+decision selector is still a narrow read: carry only the
  // explicitly selected item records and their item-keyed decorations. Keep
  // this opt-in so ordinary decision-only reads retain their identity/CAS-only
  // envelope and do not pay for the plan-item payload they did not request.
  if (itemPayload) {
    out.items = itemPayload.items;
    out.itemSelection = itemPayload.itemSelection;
    out.linkedFeatures = itemPayload.linkedFeatures;
    out.planItemTests = itemPayload.planItemTests;
    out.blockingIssues = itemPayload.blockingIssues;
  }
  // Page AFTER the complete narrow envelope is built, so the budget is measured
  // against what the response actually carries rather than an estimate. This
  // includes the optional item payload for combined selector reads.
  const { returned, deferred } = pageDecisionsToBudget(out, selected, budgetChars);

  out.decisions = returned;
  out.decisionSelection = {
    requested: requestedIds,
    matched: selected.map((decision) => String(decision.id)),
    missing: requestedIds.filter((id) => !selected.some((decision) => decision.id === id)),
    // Present only on a split — see the header note. Absence means every
    // matched id's complete body is in `decisions`.
    ...(deferred.length > 0 ? { returned: returned.map((decision) => String(decision.id)), deferred } : {}),
  };
  if (deferred.length > 0) {
    out.decisionContinuation = {
      deferred,
      note:
        `${deferred.length} more requested decision(s) did not fit this response and were ` +
        `DEFERRED, not truncated — every body in \`decisions\` above is complete. ` +
        `Re-issue plans:get with \`decisionContinuation.call\` to receive them.`,
      call: {
        ...(typeof out.slug === 'string' ? { slug: out.slug } : {}),
        ...(typeof out.harness === 'string' ? { harness: out.harness } : {}),
        decisions: deferred,
      },
    };
  }
  return out;
}

export default defineTool({
  name: 'plans:get',
  description:
    "Fetch the full parsed structure of one plan by slug: frontmatter, ## Now (state + next), items with effectiveStatus, decisions. Resolves archived plans too. An exact slug can auto-resolve its owning harness within the caller's workspace ONLY from an unscoped (operator/superuser) session; a session already scoped to a concrete harness stays scoped to it and reports which harness actually owns the slug on a miss. Pass a concrete `harness` (for example, 'papercusp') to disambiguate, constrain, or escape the ambient scope. `harness: 'all'` is only valid in an unscoped (--all-workspaces) session.",
  guidance: {
    when: "You have an exact slug and need the plan contents. In operator/superuser scope, the slug auto-resolves its owning harness within the caller's workspace; pass a concrete `harness` (for example, 'papercusp') when you need to constrain or disambiguate that lookup. `harness: 'all'` is only valid in an unscoped (--all-workspaces) session.",
    notWhen: "You don't know the slug — call plans:list first. Item-only queries across plans should use plans:items.",
    chaining:
      'plans:list → plans:get { slug } (or { slug, harness } to constrain scope) → optionally plans:items for cross-plan picks.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  // Freshness negotiation (agent-tool-delta-client-rollout-2026-06-23, P-002): plans:get
  // returns a single plan's full detail (content + items + decisions) — a COMPOSITE object,
  // NOT a keyed-row collection, so it opts into not_modified-ONLY (no semantic row-delta,
  // which would silently miss the non-collection fields). The framework's content-hash
  // revision suppresses the body when the plan for these args is byte-identical to the last
  // read — an 18KB unchanged plan re-read returns `not_modified` instead of replaying it.
  // NOT dormant (WI-3153, corrected 2026-08-04): the MCP transport's delta proxy
  // sends `_meta.delta` and reconstructs before the model sees anything. In-process
  // callers set no cursor, so `negotiateDelta` returns full (reason:'no_request').
  delta: {
    scope: (_args, ctx) => (ctx as { workspaceId?: string }).workspaceId ?? '',
    schemaVersion: 'plans-get-v1',
    maxDeltaAge: 5 * 60_000,
  },
  // context-trimming-tiers P-012: trimmed/standard sessions get a projected
  // envelope (prose/items/decisions capped with loud pointers — see get-shape.ts).
  // The cache stores the UNSHAPED result (shaping runs post-handler in defineTool
  // dispatch), so one cached read serves every tier; the UI (HTTP transport, no
  // ctx_tier) always reads full.
  shape: {
    standard: (data) => shapePlansGet(data, 'standard'),
    trimmed: (data) => shapePlansGet(data, 'trimmed'),
  },
  async handler(args, ctx) {
    // `ownerId` is not on UnifiedToolContext but is present on the papercusp
    // dispatch ctx; read it defensively rather than widening the shared type.
    // Its only use is resolving this caller's door width, and
    // getDoorConstantsSync fail-softs to the baked floor when it is absent —
    // so a miss costs one extra continuation page, never a lost decision.
    const ctxAny = ctx as {
      metadata?: (d: Record<string, unknown>) => void;
      ownerId?: string | null;
    };
    const slugs = mergeIds(args.slug, args.slugs);
    // EI-21913230259449717: resolve the `include` compatibility alias into the
    // canonical `includeRaw`; an explicit `includeRaw` always wins.
    const includeRaw = args.includeRaw ?? args.include ?? false;
    const includeEnrichments = args.includeEnrichments !== false;
    // EI-21905561475819210: normalize the generic `detail` compatibility
    // alias before cache-key construction and every output branch. Keeping one
    // canonical mode prevents alias/mode reads from diverging in cache.
    const mode = args.mode ?? (args.detail === true || args.detail === 'full' ? 'full' : 'sections');
    // EI-21194994217912029: exact-slug scope recovery. A recovery call often
    // carries an exact plan slug but NO resolvable harness; instead of failing
    // bare `harness_required`, resolve the owning harness from the slug itself
    // (PG-canonical index, caller's workspace). Explicit-harness calls and
    // harness-scoped sessions take the unchanged fast path below.
    const scope = resolveHarnessScope(args.harness, ctx);
    let sctx: typeof ctx & { harnessSlug: string };
    if (scope.kind === 'none') {
      const decision = await recoverHarnessFromSlugs(ctx, slugs);
      if (decision.status !== 'resolved') return slugScopeErrorResult('plans:get', decision);
      sctx = { ...ctx, harnessSlug: decision.harnessSlug };
      ctxAny.metadata?.({
        harnessAutoResolved: decision.bySlug,
        ...(Object.keys(decision.ambiguous).length > 0 ? { harnessAmbiguous: decision.ambiguous } : {}),
      });
    } else {
      sctx = harnessScopedCtx(args.harness, ctx);
    }
    const opts = await ctxToPlanSourceOpts(sctx);
    const ambientCallerHarness = !args.harness && scope.kind === 'harness' ? scope.slug : null;
    // An EXPLICIT harness is checked AFTER the read, not before it like the
    // ambient case: a named harness is usually the right one, so a hit must not
    // pay an extra slug-index round-trip. Only the miss is explained.
    const explicitCallerHarness = args.harness && scope.kind === 'harness' ? scope.slug : null;
    // `itemIds` is a compatibility alias for `items`; an explicit `items` wins
    // (tool-contract-repair-2026-09-05 P-006).
    const itemSelectors = args.items ?? args.itemIds;
    const requestedItemIds = itemSelectors ? [...new Set(itemSelectors)] : null;
    const requestedItemIdSet = requestedItemIds ? new Set(requestedItemIds) : null;
    // `decisionIds` is a compatibility alias for `decisions`; an explicit
    // `decisions` wins (tool-contract-repair-2026-09-05 P-006).
    const decisionSelectors = args.decisions ?? args.decisionIds;
    const requestedDecisionIds =
      args.decisionId || decisionSelectors?.length
        ? [...new Set([...(args.decisionId ? [args.decisionId] : []), ...(decisionSelectors ?? [])])]
        : null;
    // Keep diagnostics in the invocation ledger, outside the cached payload.
    // Stage times include awaited IO and synchronous work since the prior mark;
    // they are wall time, not database-only or CPU time.
    const readTimings: Array<Record<string, unknown>> = [];
    const env = await runBulk(
      slugs,
      async (slug) => {
        // A concrete ambient harness is part of the read scope. If the exact
        // slug is known to live elsewhere, return a loud, actionable miss
        // instead of a bare not_found or an implicit cross-hive read.
        if (ambientCallerHarness) {
          const mismatch = await harnessMismatchForMiss(ctx, ambientCallerHarness, slug, 'ambient');
          if (mismatch) {
            ctxAny.metadata?.({
              slug,
              searchedHarness: ambientCallerHarness,
              harnessMismatch: mismatch,
            });
            return {
              ok: false as const,
              slug,
              error: 'not_found',
              harness: ambientCallerHarness,
              harnessMismatch: mismatch,
            };
          }
        }

        const readStarted = performance.now();
        let stageStarted = readStarted;
        const stagesMs: Record<string, number> = {};
        const detailMs: Record<string, number> = {};
        let buildState: 'not-started' | 'running' | 'complete' = 'not-started';
        const markStage = (name: string) => {
          const now = performance.now();
          stagesMs[name] = Math.max(0, now - stageStarted);
          stageStarted = now;
        };
        // Parallel enrichments need their own clocks: intervals overlap and
        // must not be interpreted as an additive breakdown of total waitMs.
        const timeStage = async <T>(name: string, read: () => Promise<T>): Promise<T> => {
          const started = performance.now();
          try {
            return await read();
          } finally {
            stagesMs[name] = Math.max(0, performance.now() - started);
          }
        };
        const timeDetail = async <T>(name: string, read: () => Promise<T>): Promise<T> => {
          const started = performance.now();
          try {
            return await read();
          } finally {
            detailMs[name] = Math.max(0, performance.now() - started);
          }
        };
        return cachedRead(
          ctx as CachedReadCtx,
          {
            tool: 'plans:get',
            // Folds EVERY output-determining dimension: slug + resolved harness +
            // mode + heading + includeRaw + item/decision selection. workspace scope is added by cachedRead
            // from ctx. includeRaw MUST be here — else a slim agent-cached entry
            // (no `raw`) would be served to a UI caller that asked for raw, and
            // the editor would break intermittently on cache state.
            key: {
              slug,
              harness: opts.harnessSlug,
              mode,
              heading: args.heading ?? null,
              includeRaw,
              includeEnrichments,
              items: requestedItemIds,
              decisions: requestedDecisionIds,
            },
            tags: ['harness_plans', 'plan_revisions', 'plan_runs', 'plan_audits'],
            softTtlMs: PLANS_GET_SOFT_TTL_MS,
          },
          async () => {
            buildState = 'running';
            stageStarted = performance.now();
            const result = await readPlanBySlug(slug, { ...opts, prefetchAcceptance: true }, detailMs);
            markStage('source');
            // cachedRead caches every non-null result, so returning a `{ok:false}`
            // not_found object here would make a transient read miss sticky for
            // the full plans:get soft TTL. Let runBulk preserve the per-slug error
            // while the rejected factory result remains uncached.
            if (!result) throw new Error('not_found');

            const { parsed, archived, row } = result;
            ctxAny.metadata?.({ slug, archived, legacy: parsed.isLegacy });

            if (parsed.isLegacy) {
              const sections = splitSections(parsed.prose);
              // plans-list-windowing-cardinality-fix-2026-08-30 P-001/P-002: mirror
              // plans:list's `title`/`status`/`startStatus` triad here so a single-plan
              // fetch is sufficient for any list-row-equivalent lookup (e.g.
              // PlanDashboard's bucket derivation) without pulling the whole shared
              // index. `row` already carries these columns (PlanRow.title/status/
              // opStatus) for every plan including legacy ones — plans:list computes
              // them identically (list.ts: `row.status ?? 'draft'` +
              // `reconcileStartStatus(row.opStatus, status)`), so this is a projection
              // of an already-fetched row, not new plumbing.
              const legacyStatus = row.status ?? 'draft';
              const legacyBase = {
                slug: parsed.slug,
                harness: row.harnessSlug,
                archived,
                legacy: true as const,
                title: row.title,
                status: legacyStatus,
                startStatus: reconcileStartStatus(row.opStatus, legacyStatus),
                contentHash: hashPlanContent(parsed.raw),
                // version is the optimistic-CAS baseline (plans-pg-canonical D-005);
                // contentHash kept for callers that still pass expectedHash.
                version: row.version,
                filename: parsed.filename,
                sectionIndex: sections.map((s) => ({
                  heading: s.heading,
                  level: s.level,
                  chars: s.chars,
                })),
                counts: { sections: sections.length },
              };
              let payload: Record<string, unknown> = legacyBase;
              if (requestedDecisionIds) {
                payload = narrowDecisionPayload(legacyBase, requestedDecisionIds, []);
              } else if (args.heading) {
                payload = narrowHeadingPayload(legacyBase, args.heading, findSection(sections, args.heading));
              } else if (mode === 'full') {
                // Legacy plans are prose-only — full includes the body; meta/sections omit it.
                // (Raw is byte-identical to prose for a legacy plan; only surfaced when the
                // caller opts in via includeRaw — see the non-legacy branch below.)
                payload = {
                  ...legacyBase,
                  prose: parsed.prose,
                  ...(includeRaw ? { raw: parsed.raw } : {}),
                };
              }
              markStage('legacyShape');
              buildState = 'complete';
              return { ok: true as const, ...payload };
            }

            const resolved = resolveEffectiveStatus(parsed);

            // These reads depend only on the plan row. Start them alongside the
            // item enrichments so a slow rubric or audit lookup does not add a
            // second wait to a full plan read.
            const rubricAndAuditRead =
              !includeEnrichments || requestedDecisionIds || args.heading || mode === 'meta'
                ? Promise.resolve([null, null] as const)
                : timeStage('rubricAndAudit', () =>
                    Promise.all([
                      timeDetail('rubricAndAudit.rubric', () =>
                        getAcceptanceRubricForPlan(row.planSlug, { harnessSlug: row.harnessSlug })
                          .then((r) =>
                            r
                              ? {
                                  rubricId: r.rubricId,
                                  status: r.status,
                                  criteriaCount: r.criteria.length,
                                  ...(r.classRef ? { classRef: r.classRef } : {}),
                                }
                              : null,
                          )
                          .catch(() => null),
                      ),
                      // An audit's citation harness may differ from the plan's home.
                      timeDetail('rubricAndAudit.audit', () =>
                        getLatestPlanAudit(row.planSlug, {
                          workspaceId: row.workspaceId,
                        }),
                      ),
                    ]),
                  );

            // engineer-issues D-005: overlay OPEN issue blocks (coord_links rel='blocks',
            // dst=plan_item) onto effectiveStatus AFTER the pure resolver — an item blocked
            // by an open engineer-issue resolves to `blocked` + carries which EI(s) block it
            // (the closing of the issue unblocks every target atomically). The pure
            // @papercusp/plan-parser resolver is unchanged; the merge lives only here.
            const issueBlocksRead = includeEnrichments
              ? timeStage('issueBlocks', () => overlayIssueBlocksForPlan(slug, resolved.items))
              : Promise.resolve({ items: resolved.items, blockingIssues: {} });

            // P-006: Build a map of plan-item-id → { featureId, status } so the UI
            // can show live feature status badges next to each P-NNN item.
            const harnessSlug = resolveEffectiveHarnessSlug(sctx);
            const linkedFeaturesRead = includeEnrichments
              ? timeStage('linkedFeatures', async () => {
                  let linkedFeatures: Record<string, { featureId: string; status: string; harnessSlug: string }> = {};
                  // P-003: the newest transition across work-items linked to this
                  // plan — one of the two measurable freshness sources. Taken from
                  // the query below rather than a second one: it already selects
                  // exactly this plan's linked rows, so the signal costs one more
                  // column instead of a round-trip.
                  let linkedWorkItemUpdatedAt: string | null = null;
                  try {
                    const acquisitionStarted = performance.now();
                    let beganAt: number | null = null;
                    let callbackEndedAt: number | null = null;
                    const rows = await withWorkspace(
                      DEFAULT_WORKSPACE_ID,
                      async (tx) => {
                        try {
                          return await timeDetail(
                            'linkedFeatures.query',
                            () => tx<
                              {
                                feature_id: string;
                                status: string;
                                source_plan_slug: string | null;
                                source_plan_item_ids: string[] | null;
                                stamped_plan_slug: string | null;
                                stamped_item_id: string | null;
                                harness_slug: string;
                                updated_ts: string | number | null;
                              }[]
                            >`
                SELECT feature_id, status, source_plan_slug, source_plan_item_ids,
                       payload -> 'plan_item' ->> 'plan_slug' AS stamped_plan_slug,
                       payload -> 'plan_item' ->> 'item_id'   AS stamped_item_id,
                       harness_slug, updated_ts
                  FROM harness_shared.harness_features_consolidated
                 WHERE workspace_id = ${DEFAULT_WORKSPACE_ID}
                   AND (source_plan_slug = ${slug}
                        OR payload -> 'plan_item' ->> 'plan_slug' = ${slug})
              `,
                          );
                        } finally {
                          callbackEndedAt = performance.now();
                        }
                      },
                      {
                        onAcquisitionPhase: (phase) => {
                          const at = performance.now();
                          if (phase === 'begin') {
                            beganAt = at;
                            detailMs['linkedFeatures.waitForBegin'] = Math.max(0, at - acquisitionStarted);
                          } else {
                            detailMs['linkedFeatures.workspaceSetup'] = Math.max(
                              0,
                              at - (beganAt ?? acquisitionStarted),
                            );
                          }
                        },
                      },
                    );
                    if (callbackEndedAt !== null) {
                      detailMs['linkedFeatures.finishTransaction'] = Math.max(0, performance.now() - callbackEndedAt);
                    }
                    for (const row of rows) {
                      // P-003 freshness: newest linked work-item write. Taken over
                      // ALL linked rows, including ones whose plan-item provenance
                      // does not resolve to a P-NNN below — a linked work-item that
                      // moved is evidence of activity on this plan whether or not it
                      // can be attributed to a specific item.
                      const at = normalizeActivityTimestamp(row.updated_ts);
                      if (
                        at &&
                        (linkedWorkItemUpdatedAt === null || Date.parse(at) > Date.parse(linkedWorkItemUpdatedAt))
                      ) {
                        linkedWorkItemUpdatedAt = at;
                      }
                      // EI-19435123521651527: `source_plan_item_ids` is effectively unwritten
                      // (1 row workspace-wide vs 1,239 carrying the `payload.plan_item` stamp),
                      // so the old `WHERE source_plan_item_ids IS NOT NULL` predicate matched
                      // nothing and this badge map was always empty. Resolve via the shared
                      // precedence rule instead.
                      for (const itemId of planItemProvenanceFromRow(row).itemIds) {
                        linkedFeatures[itemId] = {
                          featureId: row.feature_id,
                          status: row.status,
                          harnessSlug: row.harness_slug,
                        };
                      }
                    }
                  } catch {
                    // Non-fatal — UI degrades to no badges.
                  }
                  return { linkedFeatures, linkedWorkItemUpdatedAt };
                })
              : Promise.resolve({ linkedFeatures: {}, linkedWorkItemUpdatedAt: null });
            // P-083: per-plan-item test coverage (the plan↔test rollup, through the
            // VAL). Mirrors linkedFeatures — computed server-side, decorated client-
            // side by decoratePlanItemTestBadges. Skips the tests query when the plan
            // has no inline-VAL assertions. Non-fatal.
            const testCoverageRead = includeEnrichments
              ? timeStage('testCoverage', async () => {
                  let planItemTests: Record<string, PlanItemTestStatus> = {};
                  try {
                    const acquisitionStarted = performance.now();
                    let beganAt: number | null = null;
                    let callbackEndedAt: number | null = null;
                    planItemTests = await withWorkspace(
                      DEFAULT_WORKSPACE_ID,
                      async (tx) => {
                        try {
                          const assertions = await timeDetail(
                            'testCoverage.assertionsQuery',
                            () => tx<
                              {
                                val_id: string;
                                item_id: string;
                                requires_test: boolean;
                              }[]
                            >`
                SELECT val_id, item_id, requires_test FROM harness_shared.harness_plan_assertions
                 WHERE workspace_id = ${DEFAULT_WORKSPACE_ID} AND harness_slug = ${harnessSlug} AND plan_slug = ${slug}
              `,
                          );
                          if (assertions.length === 0) return {};
                          const testRows = await timeDetail(
                            'testCoverage.testsQuery',
                            () => tx<{ status: string; payload: { coversVALs?: unknown } }[]>`
                SELECT status, payload FROM harness_shared.harness_tests
                 WHERE workspace_id = ${DEFAULT_WORKSPACE_ID} AND harness_slug = ${harnessSlug}
              `,
                          );
                          return computePlanItemTestStatus(
                            assertions,
                            testRows.map((r) => ({
                              status: r.status,
                              coversVALs: Array.isArray(r.payload?.coversVALs)
                                ? (r.payload.coversVALs as unknown[]).filter((v): v is string => typeof v === 'string')
                                : [],
                            })),
                          );
                        } finally {
                          callbackEndedAt = performance.now();
                        }
                      },
                      {
                        onAcquisitionPhase: (phase) => {
                          const at = performance.now();
                          if (phase === 'begin') {
                            beganAt = at;
                            detailMs['testCoverage.waitForBegin'] = Math.max(0, at - acquisitionStarted);
                          } else {
                            detailMs['testCoverage.workspaceSetup'] = Math.max(0, at - (beganAt ?? acquisitionStarted));
                          }
                        },
                      },
                    );
                    if (callbackEndedAt !== null) {
                      detailMs['testCoverage.finishTransaction'] = Math.max(0, performance.now() - callbackEndedAt);
                    }
                  } catch {
                    // Non-fatal — UI degrades to no coverage badges.
                  }
                  return planItemTests;
                })
              : Promise.resolve({});
            const sections = splitSections(parsed.prose);
            // WI-1442 fix (a): read-time liveness decoration — annotate any
            // su-* agent-id mention in the ## Now prose with its CURRENT
            // coord:presence session state, so a stale "actively worked by
            // su-X" claim self-discloses instead of silently outliving the
            // agent it names. Best-effort; never mutates the stored plan.
            const nowRead = timeStage('nowDecoration', () => decoratePlanNowBlock(parsed.now));
            const [
              { items: resolvedItems, blockingIssues },
              { linkedFeatures, linkedWorkItemUpdatedAt },
              planItemTests,
              decoratedNow,
              [acceptanceRubric, latestAudit],
            ] = await Promise.all([issueBlocksRead, linkedFeaturesRead, testCoverageRead, nowRead, rubricAndAuditRead]);
            stageStarted = performance.now();
            const responseItems = requestedItemIdSet
              ? resolvedItems.filter((item) => requestedItemIdSet.has(item.id))
              : resolvedItems;
            const responseItemIds = new Set(responseItems.map((item) => item.id));
            const itemSelection = requestedItemIds
              ? {
                  requested: requestedItemIds,
                  matched: responseItems.map((item) => item.id),
                  missing: requestedItemIds.filter((id) => !responseItemIds.has(id)),
                }
              : null;
            const selectItemMap = <T>(value: Record<string, T>): Record<string, T> =>
              requestedItemIdSet
                ? Object.fromEntries(Object.entries(value).filter(([id]) => responseItemIds.has(id)))
                : value;
            // deterministic-plan-state-derivation-2026-08-31 P-002 / D-002:
            // the `next:` pointer is a SECOND COPY of a fact the item graph
            // already owns, and nothing recomputed it when an item flipped
            // terminal — measured 2026-08-31, 208 papercusp plans (89 of them
            // still live) whose stored pointer names ONLY done/dropped items.
            // Derive it here instead of policing the stored copy on a schedule:
            // a read-time derivation cannot drift and has no failure window.
            //
            // The overlay supersedes the author's line ONLY when every plan
            // item it names is terminal — see now-next-derivation.ts for why
            // that jurisdiction rule is narrow. `now.raw` still carries the
            // stored bytes verbatim, and nothing here mutates the plan.
            const nowNext = decoratedNow ? reconcileNowNext(decoratedNow.next, parsed.items, row.planSlug) : null;
            const nowWithDerivedNext =
              decoratedNow && nowNext
                ? {
                    ...decoratedNow,
                    next: nowNext.next,
                    nextDerivation: {
                      disposition: nowNext.disposition,
                      storedNext: nowNext.storedNext,
                      staleStoredRefs: nowNext.staleStoredRefs,
                      contradictions: nowNext.contradictions,
                      itemId: nowNext.derived.itemId,
                      effectiveStatus: nowNext.derived.effectiveStatus,
                      reason: nowNext.derived.reason,
                      candidates: nowNext.derived.candidates,
                      candidatesTruncated: nowNext.derived.candidatesTruncated,
                      blockedOn: nowNext.derived.blockedOn,
                      counts: nowNext.derived.counts,
                    },
                  }
                : decoratedNow;
            // plans-list-windowing-cardinality-fix-2026-08-30 P-001/P-002: same
            // title/status/startStatus triad as the legacy branch above — see that
            // comment for the full rationale. `status` here intentionally reads
            // `row.status`, NOT `parsed.frontmatter.status`: `row` is the DB
            // projection plans:list already reads from, so the two response shapes
            // can never disagree on what "the plan's status" means.
            const status = row.status ?? 'draft';
            // deterministic-plan-state-derivation-2026-08-31 P-003 / D-004:
            // `status` above is a HAND-ASSERTED label that nothing recomputes
            // when the plan's items go terminal — the same second-copy defect
            // P-002 removed from the next-pointer, one level up. Derive the
            // lifecycle verdict from the item graph beside it so a reader can
            // see what the evidence says, not only what the label claims.
            //
            // `parsed.items` is deliberate: `resolved.items` may be NARROWED by
            // the caller's `items: [...]` selection, and censusing a narrowed
            // list would report a one-item plan as drained — a confidently
            // wrong verdict rather than a missing one.
            //
            // Best-effort and read-only: a failed signal lookup degrades to an
            // `unmeasured` axis (never to a fabricated value), and nothing here
            // writes to the plan.
            let lifecycle: Awaited<ReturnType<typeof derivePlanLifecycleForRead>> | null = null;
            try {
              lifecycle = await derivePlanLifecycleForRead({
                items: parsed.items,
                storedStatus: status,
                // expensive-verification-loops P-002 (R-3): mark items whose work item is
                // grinding (tripped loop rule, no audit note yet).
                readGrinding: readGrindingItems,
                // expensive-verification-loops P-007 (R-12): attempts-until-pass and the
                // product / harness / environment split of failed slow attempts, per item.
                readIterations: readIterationMetrics,
                signals: {
                  // EI-22103498805895390: scope the signal lookups to the PLAN
                  // ROW's workspace, not the legacy 'default' constant — the
                  // acceptance-rubric lookup filters harness_plans by
                  // workspace_id, so a plan under any other workspace read
                  // rubricActive:false while `acceptanceRubric` (resolved
                  // below from the same row) was populated.
                  workspaceId: row.workspaceId ?? DEFAULT_WORKSPACE_ID,
                  planSlug: row.planSlug,
                  planUpdatedAt: row.updatedAt,
                  linkedWorkItemUpdatedAt,
                  timings: detailMs,
                  acceptanceRubricRef: row.activeAcceptanceRubricRef,
                },
              });
            } catch {
              // Advisory overlay on an unrelated payload — it must never fail
              // the plan read. Absent means "not derived", which the schema
              // documents as distinct from any verdict.
            }
            markStage('lifecycle');
            // `meta`: frontmatter + ## Now + counts + section index. Never the body.
            const base = {
              // WI-7259 (sibling of WI-7246): a scheduled-run snapshot copies its
              // parent plan's body verbatim, frontmatter included — so
              // `parsed.frontmatter.slug` reads the PARENT's slug for every
              // snapshot. `row.planSlug` is the column this row was looked up
              // BY, so it is always the slug actually requested.
              slug: row.planSlug,
              harness: row.harnessSlug,
              archived,
              legacy: false as const,
              title: row.title,
              status,
              startStatus: reconcileStartStatus(row.opStatus, status),
              // P-003: the DERIVED counterpart to `status` above. Never
              // replaces it — a reader gets the label and the evidence side by
              // side, and `lifecycle.disposition` says whether they agree.
              ...(lifecycle
                ? {
                    lifecycle: {
                      verdict: lifecycle.derived.verdict,
                      disposition: lifecycle.disposition,
                      contradiction: lifecycle.contradiction,
                      // WI-2140735: the STATUS-AWARE line, not `derived.text`
                      // — over a shipped plan the graph-only sentence reads
                      // "the validation path has not begun" because the
                      // acceptance rubric retired on ship.
                      text: lifecycle.text,
                      counts: lifecycle.derived.counts,
                      liveItems: markGrindingItems(lifecycle.derived.liveItems, lifecycle.grinding),
                      ...(lifecycle.grinding !== undefined ? { grinding: lifecycle.grinding } : {}),
                      ...(lifecycle.iterations !== undefined ? { iterations: lifecycle.iterations } : {}),
                      liveItemsTruncated: lifecycle.derived.liveItemsTruncated,
                      idleDays: lifecycle.derived.idleDays,
                      stalledAfterDays: lifecycle.derived.stalledAfterDays,
                      unmeasured: lifecycle.derived.unmeasured,
                      acceptance: lifecycle.derived.acceptance,
                      freshness: lifecycle.derived.freshness,
                    },
                  }
                : {}),
              frontmatter: parsed.frontmatter,
              now: nowWithDerivedNext,
              contentHash: hashPlanContent(parsed.raw),
              version: row.version,
              // v2 P-001: the structured promote-policy ({ policy, warnings }) read from the row column —
              // agents read it here instead of parsing the `## Promote` markdown. null until mig-331 repopulate.
              promotePolicy: row.promotePolicy,
              // WI-40139 / D-005: permanent, bounded proof that this plan has
              // ever been shipped through an explicit code-truth waiver.
              forcedPast: row.forcedPast,
              sectionIndex: sections.map((s) => ({
                heading: s.heading,
                level: s.level,
                chars: s.chars,
              })),
              counts: {
                items: resolved.items.length,
                decisions: parsed.decisions.length,
                sections: sections.length,
              },
              ...(itemSelection ? { itemSelection } : {}),
            };

            // `heading`: the requested section plus IDENTITY/CAS fields only —
            // deliberately NOT the full `base` meta envelope (overrides mode).
            // Rationale + the measurement live on narrowHeadingPayload above.
            if (requestedDecisionIds) {
              const requestedDecisionIdSet = new Set(requestedDecisionIds);
              const selectedDecisions = parsed.decisions.filter((decision) => requestedDecisionIdSet.has(decision.id));
              markStage('shape');
              buildState = 'complete';
              return {
                ok: true as const,
                ...narrowDecisionPayload(
                  base,
                  requestedDecisionIds,
                  selectedDecisions,
                  decisionPageBudgetChars(ctxAny.ownerId, slugs.length),
                  requestedItemIds && itemSelection
                    ? {
                        items:
                          mode === 'full' ? responseItems : responseItems.map(({ rawLine: _rawLine, ...rest }) => rest),
                        itemSelection,
                        linkedFeatures: selectItemMap(linkedFeatures),
                        planItemTests: selectItemMap(planItemTests),
                        blockingIssues: selectItemMap(blockingIssues),
                      }
                    : undefined,
                ),
              };
            }
            if (args.heading) {
              markStage('shape');
              buildState = 'complete';
              return {
                ok: true as const,
                ...narrowHeadingPayload(base, args.heading, findSection(sections, args.heading)),
              };
            }

            if (mode === 'meta') {
              markStage('shape');
              buildState = 'complete';
              return { ok: true as const, ...base };
            }

            // `sections` (default): structured items/decisions + links — still WITHOUT
            // the prose blob (the 90KB overflow) and WITHOUT per-item rawLine (it
            // duplicates text/status/phase — P-008 payload diet). `full` adds both back.
            // WI-274: in `sections` (the default) excerpt long decision bodies so a
            // decision-heavy plan can't overflow the agent tool-output cap. `full` keeps
            // complete bodies (alongside the prose blob).
            const boundedDecisions = mode === 'full' ? parsed.decisions : boundDecisionBodies(parsed.decisions);
            const decisionBodiesTruncated = mode !== 'full' && boundedDecisions.some((d) => 'body_truncated' in d);
            // EI-20049758099997696: plan-item prose is the source of truth for many
            // promoted work-items, but promotion intentionally keeps those citations in
            // `summary` rather than `payload.paths`. Decorate the structured read with
            // the same advisory used at claim time so an agent can spot an unresolvable
            // repo-relative citation before it starts work. This is report-only: a plan
            // item may quite legitimately describe a file it intends to create, and a
            // resolvable path says nothing about semantic freshness.
            const stalePathsRead = timeStage('stalePaths', () =>
              getStalePathRefsForSubjects(
                responseItems.map((item) => ({
                  id: item.id,
                  summary: typeof item.text === 'string' ? item.text : null,
                })),
                undefined,
                detailMs,
              ).catch(() => ({})),
            );
            const stalePathRefsByItem = await stalePathsRead;
            stageStarted = performance.now();
            const decorateStalePathRefs = <T extends { id: string }>(item: T) =>
              decoratePlanItemStalePathRefs(item, stalePathRefsByItem);
            const structured = {
              ...base,
              ...(!includeEnrichments ? { enrichmentsDeferred: true as const } : {}),
              ...(acceptanceRubric ? { acceptanceRubric } : {}),
              ...(latestAudit ? { latestAudit } : {}),
              items:
                mode === 'full'
                  ? responseItems.map(decorateStalePathRefs)
                  : responseItems.map(({ rawLine: _rawLine, ...rest }) => decorateStalePathRefs(rest)),
              decisions: boundedDecisions,
              ...(decisionBodiesTruncated
                ? {
                    decisionBodiesTruncated: true as const,
                    decisionBodiesHint:
                      'Some decision bodies are excerpted (see each decision\'s body_truncated/body_full_chars). Use mode:"full" for complete bodies.',
                  }
                : {}),
              missingRefs: resolved.missingRefs,
              cycleMembers: resolved.cycleMembers,
              linkedFeatures: selectItemMap(linkedFeatures),
              planItemTests: selectItemMap(planItemTests),
              blockingIssues: selectItemMap(blockingIssues),
            };
            const payload =
              mode === 'full'
                ? {
                    ...structured,
                    prose: parsed.prose,
                    // Opt-in EXACT raw bytes (P-008 drops these by default to keep
                    // agent payloads slim). The plans admin UI sets includeRaw so its
                    // Edit mode round-trips the whole document through set-content,
                    // whose CAS hashes the raw bytes — prose+frontmatter reconstructed
                    // would not byte-match.
                    ...(includeRaw ? { raw: parsed.raw } : {}),
                  }
                : structured;
            markStage('shape');
            buildState = 'complete';
            return { ok: true as const, ...payload };
          },
        ).finally(() => {
          // Snapshot now: SWR can finish its factory after this request returns.
          // A cache hit must never inherit an earlier call's build timings.
          readTimings.push({
            slug,
            waitMs: Math.max(0, performance.now() - readStarted),
            buildState,
            stagesMs: { ...stagesMs },
            detailMs: { ...detailMs },
          });
        });
      },
      { keyOf: (slug) => ({ slug }) },
    );
    // Descendant history can change without a plan revision. Keep it outside the
    // plan-body cache, and off narrow member/item and metadata reads.
    const historyOnly = args.heading?.toLowerCase() === 'history';
    if (
      historyOnly ||
      args.priorAttemptRefs?.length ||
      (args.includeHistory !== false && mode === 'full' && !args.heading && !requestedDecisionIds && !requestedItemIds)
    ) {
      const historyResults = env.results as Array<Record<string, unknown>>;
      for (const [index, result] of historyResults.entries()) {
        if (result.ok !== true || typeof result.slug !== 'string' || typeof result.harness !== 'string') continue;
        const history = await readPlanHistoryContext(result.slug, result.harness);
        const priorAttemptRecords = args.priorAttemptRefs?.length
          ? await resolvePriorAttemptRefs({
              harness: result.harness,
              target: { kind: 'plan', ref: result.slug, harness: result.harness },
              rawRefs: args.priorAttemptRefs,
            })
          : undefined;
        // Do not mutate the cached base: history is fresh for this invocation only.
        historyResults[index] = {
          ...(historyOnly
            ? {
                ok: true,
                slug: result.slug,
                harness: result.harness,
                version: result.version,
                contentHash: result.contentHash,
              }
            : result),
          history,
          ...(args.priorAttemptRefs?.length ? { priorAttemptRecords } : {}),
        };
      }
    }
    // EI-21967410937471873: the opt-in ship-blocker verdict — what would refuse
    // this plan's ship RIGHT NOW, without attempting the write.
    //
    // POST-READ, and OUTSIDE cachedRead, for two independent reasons:
    //  1. Staleness. A gate verdict is TIME-VARYING in a way the plan body is
    //     not — on a shared tree that many agents commit to, audit citations go
    //     stale with nobody touching the plan, so `audit_coverage_stale` can
    //     appear (or clear) with no plan revision at all. A cached verdict could
    //     therefore serve a stale `satisfied:true`, which is the exact failure
    //     this field exists to prevent: an agent reading a green that is not.
    //  2. Key contamination. cachedRead's key folds every output-determining
    //     dimension, and adding one there is easy to forget (see the includeRaw
    //     comment on that key). Computing here means the verdict can never be
    //     served from an entry that was populated without it.
    // The plan read itself stays cached, so a hit still pays nothing for this.
    //
    // Delegates to the SAME resolver the UI reads (which calls
    // evaluatePlanAcceptanceGate) rather than re-deriving the verdict: a second
    // definition of "may this ship" could drift from the one set-plan-status
    // enforces, and a read that disagrees with the real refusal is worse than
    // no read at all.
    if (args.shipReadiness) {
      for (const result of env.results as Array<Record<string, unknown>>) {
        if (result.ok !== true) continue;
        const slug = typeof result.slug === 'string' ? result.slug : null;
        if (!slug) continue;
        try {
          const { resolvePlanAcceptanceGateVerdict } = await import('../../sync-resolver/plan-acceptance-gate-verdict');
          const rows = await resolvePlanAcceptanceGateVerdict({
            // Workspace rides for subscription identity; the resolved subject
            // harness below scopes BOTH the gate and BAR snapshot. Never borrow
            // a same-slug sibling while following a refusal's diagnostic read.
            workspaceId: 'default',
            planSlug: slug,
            ...(typeof result.harness === 'string' ? { harnessSlug: result.harness } : {}),
            ...(args.current ? { current: args.current } : {}),
          });
          result.shipReadiness = rows[0];
        } catch (error) {
          // Fail-soft: this is an ADVISORY field hanging off an unrelated
          // payload, so a gate that cannot run must never fail the plans:get.
          // But it must not silently vanish either — an ABSENT field would be
          // read as "nothing is blocking", so the failure is reported AS a
          // verdict whose unavailableReason keeps "could not evaluate" and
          // "passed" distinguishable.
          result.shipReadiness = {
            planSlug: slug,
            buildProvenance: getBuildInfo(),
            satisfied: false,
            unavailableReason: 'resolver-unavailable',
            message: `Ship readiness could not be evaluated (${
              error instanceof Error ? error.message : String(error)
            }).`,
          };
        }
      }
    }
    // review-system-rework-reduction-2026-09-23 P-032: the opt-in per-plan efficiency read.
    // Time-varying (it reads the call ledger), so like shipReadiness it stays outside cachedRead,
    // and it fails soft into an explicit unavailableReason rather than an absent field.
    if (args.efficiency) {
      const { readPlanEfficiency } = await import('../../plan-efficiency');
      for (const result of env.results as Array<Record<string, unknown>>) {
        if (result.ok !== true) continue;
        const slug = typeof result.slug === 'string' ? result.slug : null;
        if (!slug) continue;
        try {
          const scope = await resolvePlanScope({
            harnessSlug: typeof result.harness === 'string' ? result.harness : undefined,
          });
          result.efficiency = await readPlanEfficiency({ ...scope, planSlug: slug });
        } catch (error) {
          result.efficiency = {
            planSlug: slug,
            unavailableReason: 'reader-unavailable',
            message: `Plan efficiency could not be read (${error instanceof Error ? error.message : String(error)}).`,
          };
        }
      }
    }
    // use-existing-router-for-review-requests-2026-09-08 P-007 (D-008/D-009):
    // the opt-in plan operational brief. A pure projection over the result
    // record just assembled — AFTER shipReadiness so a requested ship verdict
    // feeds the brief's acceptance state instead of a second evaluation — and
    // outside cachedRead for the same staleness reason as shipReadiness.
    if (args.operationalBrief) {
      const { projectPlanOperationalBrief, renderOperationalBrief } = await import('../../operational-brief');
      for (const result of env.results as Array<Record<string, unknown>>) {
        if (result.ok !== true) continue;
        const brief = projectPlanOperationalBrief(result, { itemsComplete: !requestedItemIds });
        result.operationalBrief = { ...brief, text: renderOperationalBrief(brief) };
      }
    }
    // EI-22638466916646751: the plan-start consult used to be visible only as a
    // late `plans:start` refusal, after activation/BAR/spec-quality work had
    // already been committed. Keep the preview opt-in because routing embeds
    // transcript history and resolves live liveness; unlike the plan body it is
    // time-varying and must never be cached with the ordinary read.
    if (args.activationReadiness) {
      const requesterId = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
      for (const result of env.results as Array<Record<string, unknown>>) {
        if (result.ok !== true) continue;
        const slug = typeof result.slug === 'string' ? result.slug : null;
        if (!slug) continue;
        try {
          const previewRead = await readPlanBySlug(slug, opts);
          if (!previewRead?.row.content) {
            result.activationReadiness = {
              consult: {
                outcome: 'unavailable',
                error: 'consult_preview_unavailable',
                message: 'Consult candidate preview could not be evaluated because the canonical plan content was unavailable.',
              },
            };
            continue;
          }
          result.activationReadiness = {
            consult: await previewPlanStartConsult({
              workspaceId: previewRead.row.workspaceId,
              requesterId,
              planSlug: slug,
              planContent: previewRead.row.content,
            }),
          };
        } catch (error) {
          // Keep the advisory read useful if a plan disappears between the
          // cached detail read and this explicitly requested live preview.
          result.activationReadiness = {
            consult: {
              outcome: 'unavailable',
              error: 'consult_preview_unavailable',
              message: `Consult candidate preview could not be evaluated (${error instanceof Error ? error.message : String(error)}).`,
            },
          };
        }
      }
    }
    // EI-21449048020722730: explain an explicit-harness miss the same way the
    // ambient one is explained. A bare `not_found` for a slug that exists in
    // another harness reads as "no such plan" and gets filed as a broken tool;
    // the slug index knows better and says so. Post-read so hits pay nothing,
    // and only for results the read itself missed.
    if (explicitCallerHarness) {
      for (const result of env.results as Array<Record<string, unknown>>) {
        if (result.ok !== false || result.error !== 'not_found') continue;
        if (result.harnessMismatch) continue;
        const slug = typeof result.slug === 'string' ? result.slug : null;
        if (!slug) continue;
        const mismatch = await harnessMismatchForMiss(ctx, explicitCallerHarness, slug, 'explicit');
        if (!mismatch) continue;
        ctxAny.metadata?.({ slug, searchedHarness: explicitCallerHarness, harnessMismatch: mismatch });
        result.harness = explicitCallerHarness;
        result.harnessMismatch = mismatch;
      }
    }
    ctxAny.metadata?.({ plansGetRead: { unit: 'ms', timing: 'wall-time-per-stage-overlapping', reads: readTimings } });
    return bulkContent(env);
  },
});
