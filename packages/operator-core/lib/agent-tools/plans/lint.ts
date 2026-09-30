/**
 * plans:lint — validate plan files against the format spec.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.5 + §5.
 *
 * **Legacy files are exempt from the structural checks below.** Day-one CI
 * MUST pass against the ~33 legacy plans in docs/plans/. Conversion happens
 * via P-304, one plan at a time. The ONE exception (EI-18793956567250851): a
 * legacy plan that still carries non-terminal items IS flagged as an error —
 * scheduler:get_next serves those items regardless of frontmatter validity,
 * but every structured write refuses `legacy_plan` on them, so the item is
 * unresolvable by construction unless the plan is repaired.
 *
 * Per-plan checks (when frontmatter present + valid):
 *   - slug matches filename stem
 *   - required sections present (## Now, ## Decisions)
 *   - item IDs unique + well-formed (P-NNN)
 *   - decision IDs unique + well-formed (D-NNN)
 *   - blocked-by refs resolve to known item IDs
 *   - decision refs resolve to known decision IDs
 *   - status tokens in vocabulary
 *   - ASCII-only IDs
 *   - item-line-like text (bold **P-NNN**, checkbox, or under a ## Phase
 *     heading) that did NOT parse as an item — most commonly a missing
 *     `status` backtick token (EI-480)
 *   - supersession recorded (`superseded-by:` frontmatter / a "superseded by
 *     [[X]]" Now note) but status not `superseded` → warn (EI-154)
 *   - terminal status (shipped/superseded) but non-terminal items remain
 *     (todo/wip/blocked/needs-human) → warn (EI-21843057910518424)
 *
 * Returns { errors, warnings } per plan + overall pass/fail.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { listPlanFiles, readPlanBySlug, type PlanSourceOpts } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveEffectiveStatus } from './effective-status';
import { IMPORTANCE_LEVELS } from './parser';
import type { ParsedPlan } from './parser';
import { parsePromotePolicy, type ParsePromoteResult } from './promote-policy';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import { detectUnparsedItemLines } from './item-parse-feedback';
import { TERMINAL_NOW_STAMP_MARK } from './terminal-now-stamp';
import { analyzePlanDagParallelism } from './plan-dag-parallelism';
import type { DependencyPolicyFinding } from '../../scheduler/dependency-invariants';
import {
  detectNowItemContradictions,
  detectNowItemOmissions,
} from './now-item-contradictions';
export { detectNowItemContradictions, detectNowItemOmissions } from './now-item-contradictions';

const argsSchema = z.object({
  slug: z.string().optional().describe('Lint one plan (full report: errors + warnings). Omit for all plans (bounded summary).'),
  slugs: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .optional()
    .describe('Plan slugs to lint in one call. When set, output uses the standard bulk envelope.'),
  includeArchived: z.boolean().optional().describe('Lint plans under archive/. Default false.'),
  full: z
    .boolean()
    .optional()
    .describe(
      'All-plans mode only: return the COMPLETE per-plan reports (every error AND warning message) instead of the bounded summary. The complete dump can exceed the agent result-size cap on a real workspace (hundreds of plans × hundreds of warnings → 170KB+), so it is OFF by default — prefer the summary, then lint a single `slug` for a plan’s full warning detail. Safe for HTTP/in-process callers that can handle the size.',
    ),
  harness: harnessArg,
});

export interface LintFinding {
  level: 'error' | 'warning';
  code: string;
  message: string;
  itemId?: string;
  decisionId?: string;
  dependencyFinding?: DependencyPolicyFinding;
}

export interface PlanLintReport {
  slug: string;
  archived: boolean;
  legacy: boolean;
  exempt: boolean;
  errors: LintFinding[];
  warnings: LintFinding[];
}


/** Count features in harness_features_consolidated whose metadata
 *  records this plan slug as their source. Returns 0 when PG is
 *  unreachable so the lint never breaks on infra blips. */
async function countFeaturesFromPlan(planSlug: string): Promise<number> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    // P-041: scope to the caller's workspace (ALS-populated for tool calls,
    // P-022). getOrgPg bypasses RLS, and post-091 a plan slug is unique only
    // per (workspace_id, slug), so an unscoped count would fold in another
    // workspace's features for a colliding slug.
    const workspaceId = activeWorkspaceId();
    const rows = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId}
         AND source_plan_slug = ${planSlug}
    `;
    return rows[0]?.n ?? 0;
  } catch {
    // PG offline / column missing — fail open. The lint surfacing a
    // false negative is strictly better than a false positive
    // (which is the very issue we're fixing).
    return 0;
  }
}

export async function lintPlan(
  slug: string,
  opts: PlanSourceOpts = {},
): Promise<PlanLintReport | null> {
  const result = await readPlanBySlug(slug, opts);
  if (!result) return null;
  const { parsed, archived, row } = result;
  // v2 P-001: pass the structured promote-policy (parsed at write-time) so lint reads it instead of
  // re-parsing the markdown; lintParsed falls back to parsing for a not-yet-repopulated row.
  const report = await lintParsed(parsed, slug, archived, row.promotePolicy);
  // The stored index may predate the current parser. A nonempty index that no
  // longer agrees with the canonical markdown must be visible during lint;
  // otherwise read surfaces can show items that no structured write can reach.
  const divergence = itemIndexDivergence(row.items, parsed);
  if (divergence) {
    report.warnings.push({
      level: 'warning',
      code: 'plan_item_index_divergence',
      message: `Stored item index differs from parsed plan body (${divergence}). Move misplaced item lines under ## Phase and rewrite the plan to refresh its index.`,
    });
  }
  return report;
}

export function itemIndexDivergence(indexed: readonly { id: string }[], parsed: ParsedPlan): string | null {
  if (indexed.length === 0) return null; // legacy/unmaterialized index
  const indexIds = indexed.map((item) => item.id).sort();
  const bodyIds = parsed.items.map((item) => item.id).sort();
  if (indexIds.length === bodyIds.length && indexIds.every((id, i) => id === bodyIds[i])) return null;
  return `${indexed.length} indexed item(s), ${parsed.items.length} parsed item(s)`;
}

/**
 * Apply the lint rules to an already-parsed plan. Split out of
 * `lintPlan` so `plans:set-content` can lint a *proposed* document
 * body in-memory — before writing it. Pure now (plans are PG-canonical;
 * no filesystem round-trip).
 */
export async function lintParsed(
  parsed: ParsedPlan,
  slug: string,
  archived: boolean,
  // v2 P-001: the structured promote-policy from the plan row (when available); absent for a
  // proposed-body lint (plans:set-content lints in-memory before writing) → parse parsed.raw.
  promotePolicy?: ParsePromoteResult | null,
): Promise<PlanLintReport> {
  const report: PlanLintReport = {
    slug,
    archived,
    legacy: parsed.isLegacy,
    exempt: parsed.isLegacy,
    errors: [],
    warnings: [],
  };

  if (parsed.isLegacy) {
    // EI-18793956567250851: a legacy plan is otherwise exempt from lint entirely
    // (§ top-of-file) — but a legacy plan that STILL carries non-terminal items is
    // a real trap, not merely unstructured: scheduler:get_next happily serves
    // those items (item parsing runs regardless of frontmatter validity), while
    // every structured write (plans:add-decision, plans:set-now,
    // plans:set-frontmatter-field, plans:transfer-owner, plans:set-initiative,
    // plans:set-template-data, plans:ratify-decision) refuses with `legacy_plan`
    // — so a decision-gated item served from a legacy plan is UNRESOLVABLE by
    // construction, and nothing previously flagged it. This is an ERROR (not
    // exempt-and-silent): CI should catch the NEXT occurrence before an agent
    // burns a claim on it, the way this one was only caught by a live repro.
    const nonTerminal = parsed.items.filter(
      (i) => i.storedStatus !== 'done' && i.storedStatus !== 'dropped',
    );
    if (nonTerminal.length > 0) {
      const ids = nonTerminal.slice(0, 5).map((i) => i.id);
      const suffix = nonTerminal.length > 5 ? `, … +${nonTerminal.length - 5} more` : '';
      const reasonMsg =
        parsed.legacyReason === 'frontmatter_displaced'
          ? 'a well-formed frontmatter block exists but is displaced (not at file position 0) — see the parse notice for the exact line to move'
          : `frontmatter is missing/malformed (${parsed.legacyReason ?? 'unknown reason'})`;
      report.errors.push({
        level: 'error',
        code: 'legacy_plan_with_live_items',
        message:
          `This plan is LEGACY (${reasonMsg}) but still carries ${nonTerminal.length} non-terminal ` +
          `item(s) (${ids.join(', ')}${suffix}) — scheduler:get_next serves these, but every structured ` +
          `write (plans:add-decision, plans:set-now, plans:set-frontmatter-field, plans:transfer-owner, ` +
          `plans:set-initiative, plans:set-template-data, plans:ratify-decision) refuses with 'legacy_plan', ` +
          `making them unresolvable by construction (EI-18793956567250851). Repair the frontmatter (see ` +
          `parse notices) with plans:set-content, or move/drop the item(s).`,
      });
    }
    return report;
  }

  const fmSlug = parsed.frontmatter.slug;
  if (fmSlug && fmSlug !== parsed.slug) {
    report.errors.push({
      level: 'error',
      code: 'slug_mismatch',
      message: `Frontmatter slug "${fmSlug}" doesn't match filename stem "${parsed.slug}".`,
    });
  }

  if (!parsed.now) {
    // §4.5: `## Now` is required — it is the cold-resume anchor, the
    // single most-read field of a plan. Every plan was backfilled with
    // a Now block, so a non-legacy plan missing one is malformed: hard
    // error, not a warning. (Legacy plans returned early above.)
    report.errors.push({
      level: 'error',
      code: 'missing_now_section',
      message: 'No `## Now` section — every plan needs one (the cold-resume anchor); add it with plans:set-now.',
    });
  }
  const nowItemContradictions = detectNowItemContradictions(parsed);
  for (const contradiction of nowItemContradictions) {
    report.errors.push({
      level: 'error',
      code: 'now_item_status_contradiction',
      itemId: contradiction.id,
      message:
        `Item ${contradiction.id} is stored as '${contradiction.status}', but the ` +
        `\`## Now\` block presents it as current or future work ("${contradiction.mention}"). ` +
        'Rewrite Now from the current item statuses; a terminal item must be described as done/closed, not assigned another pass.',
    });
  }
  const nowItemOmissions = detectNowItemOmissions(parsed);
  for (const omission of nowItemOmissions) {
    for (const itemId of omission.omitted) {
      report.errors.push({
        level: 'error',
        code: 'now_item_omission',
        itemId,
        message:
          `The \`## Now\` block makes an exhaustive remaining-item claim ("${omission.mention}") ` +
          `listing ${omission.listed.join(', ')} but omitting non-terminal item ${itemId}. ` +
          'Rewrite Now so every non-terminal structured item remains represented.',
      });
    }
  }
  if (parsed.decisions.length === 0 && parsed.items.length > 0) {
    report.warnings.push({
      level: 'warning',
      code: 'missing_decisions_section',
      message: 'No `## Decisions` section / no decisions recorded.',
    });
  }

  // EI-154: a plan that RECORDS its own supersession — via the `superseded-by:`
  // frontmatter field OR a "superseded by [[X]]" note in its `## Now` block — but
  // whose STATUS is not `superseded` is a trap. The next agent reads it as a live
  // `ready`/`active` plan and may build the design that was already rejected. This
  // is the fleet-federation-reanchor case (2026-06-09): its NULL=fleet-domain
  // federation design sat `ready` for days after `shared-hive-federation` shipped
  // the opposite (Hive-pubkey) approach, and an assigned agent nearly built the
  // rejected design before a code-grounded read caught the supersession. Flipping
  // the status makes the supersession machine-visible (it drops out of
  // plans:items actionable/needs-human) instead of buried in prose.
  //
  // WARNING, never error: supersession state is transiently inconsistent mid-edit
  // (you record it in prose, then flip the status), and plan lints advise rather
  // than gate (CLAUDE.md). The prose signal requires a `[[wikilink]]` after
  // "superseded by" so a passing narrative mention can't false-positive; the
  // frontmatter signal is exact. Tightly scoped to the `## Now` state (the
  // self-referential cold-resume anchor), so it never fires on a decision that
  // merely discusses some *other* plan's supersession.
  const status = parsed.frontmatter.status;
  if (status && status !== 'superseded') {
    // Strip markdown emphasis (`**bold**` / `_italic_` / `` `code` ``) so the
    // natural Now phrasing "**SUPERSEDED** by [[X]]" still matches `superseded by`.
    const nowState = (parsed.now?.state ?? '').replace(/[*_`]/g, '');
    const fmSupersededBy =
      typeof parsed.frontmatter.supersededBy === 'string'
        ? parsed.frontmatter.supersededBy.trim()
        : '';
    const proseLink = /\bsuperseded\s+by\b[^[\n]*\[\[([^\]]+)\]\]/i.exec(nowState)?.[1]?.trim();
    if (fmSupersededBy || proseLink) {
      const by = fmSupersededBy || proseLink || 'another plan';
      const where = fmSupersededBy ? 'its `superseded-by:` frontmatter' : 'its `## Now` block';
      report.warnings.push({
        level: 'warning',
        code: 'superseded_status_mismatch',
        message:
          `This plan records that it is superseded by ${by} (in ${where}) but its status is '${status}'. ` +
          `Flip it with plans:set-plan-status status=superseded — a stale '${status}' plan whose design was ` +
          `superseded misleads the next agent into building the rejected approach (the fleet-federation-reanchor trap).`,
      });
    }
  }

  // EI-205: the completion reflex never flips plan status. A 2026-06-09 audit
  // found ~45 plans whose status (draft/ready/active) contradicted their own
  // reality — e.g. a `## Now` saying "PLAN COMPLETE / nothing outstanding" still
  // at status=draft, or every item closed out while status stayed 'ready'.
  // Agents faithfully update the Now block + item statuses at completion but
  // never call plans:set-plan-status, so a finished plan reads as live work.
  // Fire when a non-terminal plan looks DONE — either ALL its items are closed
  // (storedStatus done/dropped, ≥1 item) OR its `## Now` state uses strong
  // whole-plan completion language. WARNING, never error (lints advise — CLAUDE.md).
  // Low-FP: the structural "all items closed" signal is exact; the prose signal
  // is scoped to the self-referential Now state with strong multi-word phrases
  // (a bare "done"/"complete" — common in Next/State prose — does NOT fire).
  if (status === 'draft' || status === 'ready' || status === 'active') {
    const closedItems = parsed.items.filter(
      (i) => i.storedStatus === 'done' || i.storedStatus === 'dropped',
    );
    const allItemsClosed = parsed.items.length > 0 && closedItems.length === parsed.items.length;
    const nowStateForDone = (parsed.now?.state ?? '').replace(/[*_`]/g, '');
    const strongCompletionProse =
      /\b(?:plan\s+(?:is\s+)?(?:fully\s+)?complete|fully\s+complete|fully\s+done|nothing\s+(?:outstanding|left|remaining)|all\s+(?:items?\s+)?(?:done|complete|shipped))\b/i.test(
        nowStateForDone,
      );
    if (allItemsClosed || strongCompletionProse) {
      const why = allItemsClosed
        ? `all ${parsed.items.length} of its items are closed (done/dropped)`
        : 'its `## Now` state reads as complete';
      report.warnings.push({
        level: 'warning',
        code: 'completion_status_mismatch',
        message:
          `This plan looks complete (${why}) but its status is '${status}'. ` +
          `If it is finished, flip it with plans:set-plan-status status=shipped; otherwise record what is still ` +
          `outstanding in the \`## Now\` block. A finished plan left '${status}' keeps reading as live work (EI-205).`,
      });
    }
  }

  // WI-38303: the MIRROR of the rule above. That one fires when the Now reads
  // done but the status is still draft/ready; this one fires when the status is
  // TERMINAL but the `## Now` still issues instructions. Measured 2026-08-12:
  // 277 non-archived papercusp plans (224 shipped + 53 superseded) still carry a
  // `**Next:**` that directs work, and two agents were sent to redo finished work
  // by exactly that in one session — the work-item title, the Now block and the
  // Next all agreed with each other, and only the frontmatter was true.
  //
  // plans:set-plan-status now stamps the Now block on a terminal flip, so a
  // freshly-shipped plan self-silences (the stamp is the falsifier below). This
  // rule covers what the stamp cannot: the pre-existing corpus, and the
  // whole-document writers (plans:set-content / set-content-chunk) that can set a
  // terminal status without going through the status verb. Those two already gate
  // writes on lint, which is why the guard belongs HERE rather than as a
  // post-hoc rewrite of content the caller deliberately authored.
  //
  // Low-FP by the same construction as its mirror: it reads only the
  // self-referential `next`, and any of the ordinary ways of writing "nothing
  // left" suppress it.
  if (status === 'shipped' || status === 'superseded') {
    const nowNext = (parsed.now?.next ?? '').replace(/[*_`]/g, '').trim();
    const alreadyStamped = (parsed.now?.raw ?? '').includes(TERMINAL_NOW_STAMP_MARK);
    // ANCHORED AT THE OPENER, deliberately. A bare keyword search anywhere in
    // the string is wrong in the one case that matters most: the real sentence
    // that misled an agent was "Grade the rubric, then flip the plan to
    // shipped." — an INSTRUCTION that happens to contain "shipped". Matching it
    // as closure suppressed the warning on precisely the defect this rule
    // exists to catch (caught by this rule's own test). Closure language only
    // counts when the Next OPENS by declaring the plan finished.
    const readsAsClosed =
      /^(?:none|nothing|n\/a|nil|no\s|[—–-]\s*$|[—–-]\s)/i.test(nowNext) ||
      /^(?:the\s+)?plan\s+is\s+(?:shipped|complete|completed|closed|superseded)/i.test(nowNext) ||
      /^(?:shipped|complete|completed|closed|superseded|done)\b/i.test(nowNext);
    if (nowNext && !alreadyStamped && !readsAsClosed) {
      report.warnings.push({
        level: 'warning',
        code: 'terminal_status_stale_now',
        message:
          `This plan is '${status}' but its \`## Now\` block still directs work ("${nowNext.slice(0, 80)}${nowNext.length > 80 ? '…' : ''}"). ` +
          `The Now block is the most-read field on a plan, so a finished plan that still issues instructions sends the ` +
          `next agent to redo work that is already done. Rewrite it with plans:set-now, or re-run the terminal flip via ` +
          `plans:set-plan-status, which stamps the block automatically (WI-38303).`,
      });
    }
  }

  // EI-21843057910518424: the plan-level lifecycle label (shipped/superseded)
  // is an author-declared field that is never reconciled against the child
  // ITEM graph. A daily-digest census (a dozen-plus independently-worded
  // filings across many cycles, all naming the same mechanism) found live
  // plans carrying a terminal status while most — in several cases ALL — of
  // their items are still stored todo/wip/blocked/needs-human. The `shipped`
  // path is *partly* guarded going forward (evaluatePlanAcceptanceGate checks
  // unfinished items on a NEW ship attempt), but `superseded` has no such
  // check at all, and neither direction is ever RE-checked after the fact: an
  // item reopened post-terminal, or added to an already-terminal plan, leaves
  // no trace. The drift corrupts every "is this plan done" query and hides
  // real work from burn-down.
  //
  // WARNING, never error (lints advise — CLAUDE.md). Fires on the terminal
  // frontmatter status alone — cheap and exact, since item storedStatus is
  // structured data with no prose heuristics needed. Deliberately does not
  // auto-drop anything: which open items are genuinely abandoned vs. still
  // owed is a judgment call for whoever reads the warning, not a lint.
  if (status === 'shipped' || status === 'superseded') {
    const openItems = parsed.items.filter(
      (i) => i.storedStatus !== 'done' && i.storedStatus !== 'dropped',
    );
    if (openItems.length > 0) {
      const shown = openItems.slice(0, 12).map((i) => i.id);
      const more = openItems.length > shown.length ? `, +${openItems.length - shown.length} more` : '';
      report.warnings.push({
        level: 'warning',
        code: 'terminal_status_open_items',
        message:
          `This plan is '${status}' but ${openItems.length} of its ${parsed.items.length} item(s) are still ` +
          `non-terminal (todo/wip/blocked/needs-human): ${shown.join(', ')}${more}. A terminal plan label with open ` +
          `items corrupts is-this-done queries and hides real work from burn-down (EI-21843057910518424). Finish ` +
          `or deliberately drop each one (\`plans:set-status { slug, item, status:'dropped', note:'<why>' }\`), or ` +
          `flip the plan back to draft/ready with plans:set-plan-status if the work is genuinely still live.`,
      });
    }
  }

  // EI-44: owner-gated asks written as `## Now` PROSE ("Owner: decide D-002",
  // "human greenlights a phase", "Owner: provide FCM/APNS creds") are invisible
  // to every inbox surface — only a `needs-human` ITEM is queryable by
  // plans:items {needsHuman:true} and projected into the attention feed. An
  // audit of 100 non-shipped plans found ~12 owner asks that lived ONLY as Now
  // prose, so the owner could discover them only by reading every Now line.
  // When the Now block phrases an owner/human action-gate but the plan carries
  // NO `needs-human` item, the ask is stranded: warn, nudging conversion to a
  // needs-human item (plans:set-status status=needs-human) so it reaches the
  // human inbox.
  //
  // WARNING, never error (plan lints advise rather than gate — CLAUDE.md).
  // Scoped to the `## Now` block and — for the verb idioms — bound to an action
  // verb in close proximity so a generic mention ("the owner only discovers
  // them by reading the Now line", "the human reads the Now line") can't
  // false-positive. Mirrors the EI-154 supersession guard. Emphasis is stripped
  // first so "**Owner:** decide" still matches.
  if (parsed.now) {
    const nowText = parsed.now.raw.replace(/[*_`]/g, '');
    const ownerGatePatterns: RegExp[] = [
      // Label form — the literal "Owner:" / "human:" signals the issue named.
      /\bowner\s*:/i,
      /\bhuman\s*:/i,
      // Verb idioms with no colon ("human greenlights a phase", "owner to
      // decide"): bind owner/human to an action verb within ~40 chars.
      /\bowner\b[^.\n]{0,40}?\b(?:decide|decision|provide|approve|approval|sign-?off|signs?\s+off|greenlight|greenlights|must|needs?\s+to)\b/i,
      /\bhuman\b[^.\n]{0,40}?\b(?:greenlight|greenlights|approve|approval|sign-?off|signs?\s+off|decide|decision|must)\b/i,
      /\b(?:awaiting|blocked\s+on|blocked\s+by|gated\s+on|waiting\s+on|waiting\s+for)\s+(?:the\s+|an?\s+)?(?:owner|human)\b/i,
    ];
    const hasOwnerGateProse = ownerGatePatterns.some((re) => re.test(nowText));
    const hasNeedsHumanItem = parsed.items.some((it) => it.storedStatus === 'needs-human');
    if (hasOwnerGateProse && !hasNeedsHumanItem) {
      report.warnings.push({
        level: 'warning',
        code: 'owner_ask_not_needs_human',
        message:
          'The `## Now` block phrases an owner/human action-gate (e.g. "Owner: decide…", "human greenlights…") ' +
          'but the plan has no `needs-human` item — so the ask is invisible to every inbox surface ' +
          '(only `needs-human` items reach plans:items {needsHuman:true} and the attention feed). ' +
          'Encode it as a needs-human item with plans:set-status status=needs-human (or plans:add-item) ' +
          'so it reaches the owner inbox instead of being buried in Now prose.',
      });
    }
  }

  for (const w of parsed.parseWarnings) {
    report.errors.push({ level: 'error', code: 'parse_warning', message: w });
  }
  // Notices are observations, not violations — they must stay WARNINGS.
  // Every entry in `parseWarnings` becomes an error two lines above, and an
  // error rejects every subsequent write to the plan, so routing a notice
  // there would wedge the plan it is merely describing (EI-18804290731494084).
  for (const n of parsed.parseNotices) {
    report.warnings.push({ level: 'warning', code: 'parse_notice', message: n });
  }

  const itemIds = new Set(parsed.items.map((i) => i.id));
  const itemById = new Map(parsed.items.map((i) => [i.id, i]));

  // EI-251: checkbox-style item lines (`- [ ] P-NNN — text`) are NOT the
  // canonical item syntax (`- **P-NNN** \`status\` text`) and parse as ZERO
  // items — plans:set-status returns item_not_found, plans:items can't see
  // them, and claims never auto-release. This bit all 15 agents of the
  // 2026-06-10 closeout dispatch on the audit plan (81 invisible items,
  // lint silently green). Surface every checkbox-form id the parser did
  // not register. WARNING, not error: lint advises rather than gates, and
  // the regex is line-anchored so a prose mention can't fire it, but a
  // quoted example block legitimately could.
  const checkboxItemRe = /^[ \t]*-\s*\[(?: |x|X)\]\s*\*{0,2}([A-Z]-\d{3,})\b/gm;
  const ghostIds: string[] = [];
  for (const m of parsed.raw.matchAll(checkboxItemRe)) {
    const id = m[1];
    if (id && !itemIds.has(id)) ghostIds.push(id);
  }
  if (ghostIds.length > 0) {
    const sample = ghostIds.slice(0, 5).join(', ');
    const suffix = ghostIds.length > 5 ? `, … +${ghostIds.length - 5} more` : '';
    report.warnings.push({
      level: 'warning',
      code: 'checkbox_item_syntax',
      message:
        `${ghostIds.length} checkbox-style item line(s) (${sample}${suffix}) are INVISIBLE to the plan parser — ` +
        'plans:set-status fails item_not_found on them and they never appear in plans:items. ' +
        'Rewrite as the canonical form `- **P-NNN** `status` text` (spec/plan-format).',
    });
  }

  // EI-480: a line that LOOKS like an attempted item (bold **P-NNN**, or a
  // bullet under a ## Phase heading) but did not parse — most commonly because
  // it is missing the required `status` backtick token entirely, e.g.
  // `- **P-001** some text` with no `` `todo` `` — is invisible to the parser
  // exactly like the checkbox case above, yet was previously invisible to lint
  // too: a plan authored via plans:set-content without the status token linted
  // clean while shipping ZERO claimable items. Reuse the same detector the
  // write-time tools (plans:new / plans:set-content / plans:set-content-chunk,
  // item-parse-feedback.ts) already use, so a plan lints the same signal
  // whenever/however it was written. Skip lines already reported by the
  // checkbox-specific warning above (same root cause — one warning is enough).
  const unparsedItemLines = detectUnparsedItemLines(
    parsed.raw,
    new Set(parsed.items.map((i) => i.rawLine)),
  ).filter((u) => !/^[ \t]*-\s*\[(?: |x|X)\]\s*\*{0,2}[A-Z]-\d{3,}\b/.test(u.text));
  // A fully formed item line outside the parser's item-bearing sections is
  // lost from the execution graph. Treat that as an error so whole-body writes
  // cannot persist a dangling blocked-by reference while merely warning about
  // the missing item. Keep malformed attempted items advisory as before.
  const misplacedCanonicalItems = unparsedItemLines.filter((line) =>
    /^[ \t]*-\s+\*\*P-\d{3,}\*\*\s+`[^`]+`\s+\S/.test(line.text),
  );
  for (const line of misplacedCanonicalItems) {
    report.errors.push({
      level: 'error',
      code: 'unparsed_canonical_item',
      message: `Canonical item at line ${line.line} did not parse (${line.text}). Move it under a ## Phase heading.`,
    });
  }
  const malformedItemLines = unparsedItemLines.filter((line) => !misplacedCanonicalItems.includes(line));
  if (malformedItemLines.length > 0) {
    const sample = malformedItemLines
      .slice(0, 5)
      .map((u) => `L${u.line}: ${u.text}`)
      .join('; ');
    const suffix = malformedItemLines.length > 5 ? `, … +${malformedItemLines.length - 5} more` : '';
    report.warnings.push({
      level: 'warning',
      code: 'unparsed_item_line',
      message:
        `${malformedItemLines.length} line(s) look like plan items but did NOT parse (${sample}${suffix}) — ` +
        'most commonly a missing `status` backtick token. An item MUST be `- **P-NNN** `status` text`. ' +
        'Rewrite with plans:set-content, or append correctly with plans:add-item.',
    });
  }
  for (const it of parsed.items) {
    for (const dep of it.blockedBy) {
      const depItem = itemById.get(dep);
      if (!depItem) {
        report.errors.push({
          level: 'error',
          code: 'unknown_blocked_by',
          message: `Item ${it.id} has blocked-by: ${dep} that doesn't resolve.`,
          itemId: it.id,
        });
        continue;
      }
      // §3.4 / D-005: a `dropped` blocker never completes, so the
      // resolver treats the dependent as unblocked. Surface it so the
      // dependency gets re-evaluated rather than silently un-gating.
      if (depItem.storedStatus === 'dropped') {
        report.warnings.push({
          level: 'warning',
          code: 'blocker_dropped',
          message: `Item ${it.id} is blocked-by ${dep}, which is dropped — ${dep} will never complete, so ${it.id} is treated as unblocked; re-evaluate the dependency.`,
          itemId: it.id,
        });
      }
    }
    const decisionIds = new Set(parsed.decisions.map((d) => d.id));
    for (const dref of it.decisionRefs) {
      if (!decisionIds.has(dref)) {
        report.warnings.push({
          level: 'warning',
          code: 'unknown_decision_ref',
          message: `Item ${it.id} references unknown decision ${dref}.`,
          itemId: it.id,
        });
      }
    }
    if (!/^[A-Z]-\d{3,}$/.test(it.id)) {
      report.errors.push({
        level: 'error',
        code: 'malformed_item_id',
        message: `Item id ${it.id} is not in P-NNN form.`,
        itemId: it.id,
      });
    }
    // An `importance:` value the parser didn't recognise was degraded to
    // `normal` (silently — a parseWarning would become an error above).
    // Surface it here as a soft WARNING so a typo'd level is visible
    // without failing CI. Mirrors the parser's `[a-z]+` token boundary.
    const impRaw = /\bimportance\s*:\s*([a-z]+)/i.exec(it.rawLine);
    if (impRaw && !(IMPORTANCE_LEVELS as readonly string[]).includes((impRaw[1] ?? '').toLowerCase())) {
      report.warnings.push({
        level: 'warning',
        code: 'unknown_importance',
        message: `Item ${it.id} has importance: ${impRaw[1]} which isn't one of ${IMPORTANCE_LEVELS.join('/')} — treated as normal.`,
        itemId: it.id,
      });
    }
  }

  // EI-101: a decision recording landed/shipped work whose referenced items are
  // still `todo`. Repro: archive-legacy-orchestrator-deadcode — D-007 recorded a
  // thorough completion (itemRefs P-001..P-013) but the items kept storedStatus=
  // todo, so the brief-index generator (plans:items effectiveStatus=todo)
  // re-dispatched the whole plan as fresh work, burning an agent slot re-verifying
  // landed work. Fire when a decision body reads as completed AND ≥1 of its
  // itemRefs is still `todo`: flip the items (or note why they remain open) so the
  // completed work isn't re-briefed. WARNING, never error (lints advise — CLAUDE.md).
  // Low-FP: needs BOTH a completion verb in the body AND a referenced item at todo.
  // A completion verb in a decision is only evidence when it is affirmative.
  // Keep the negation guard bounded to the same clause so an earlier sentence
  // such as "the prior attempt was not accepted. The migration completed" does
  // not suppress the later affirmative completion.
  const DECISION_DONE_RE =
    /\b(?:landed|shipped|executed|merged|deployed|implemented|completed|all\s+done|fully\s+done)\b/gi;
  const DECISION_DONE_NEGATION_RE =
    /\b(?:not|never|no|doesn['’]t|didn['’]t|isn['’]t|wasn['’]t|aren['’]t|weren['’]t)\b(?:\W+\w+){0,4}\W*$/i;
  const readsAsCompleted = (body: string): boolean => {
    for (const match of body.matchAll(DECISION_DONE_RE)) {
      const start = match.index ?? 0;
      const prefix = body.slice(Math.max(0, start - 96), start);
      const clause = prefix.split(/[.!?;:\n]/).at(-1) ?? prefix;
      if (!DECISION_DONE_NEGATION_RE.test(clause)) return true;
    }
    return false;
  };
  for (const d of parsed.decisions) {
    if (!readsAsCompleted(d.body ?? '')) continue;
    const todoRefs = (d.itemRefs ?? []).filter((ref) => itemById.get(ref)?.storedStatus === 'todo');
    if (todoRefs.length > 0) {
      report.warnings.push({
        level: 'warning',
        code: 'decision_done_items_todo',
        message:
          `Decision ${d.id} reads as completed but its referenced item(s) ${todoRefs.join(', ')} are still 'todo'. ` +
          `Flip them with plans:set-status (or note why they remain open) — items left 'todo' under a "done" decision ` +
          `get re-dispatched as fresh work by the brief/work-list generators (EI-101).`,
      });
    }
  }

  const resolved = resolveEffectiveStatus(parsed);
  for (const m of resolved.missingRefs) {
    report.errors.push({
      level: 'error',
      code: 'missing_blocker',
      message: `Item ${m.itemId} blocked-by ${m.ref}, which doesn't exist.`,
      itemId: m.itemId,
    });
  }
  for (const cid of resolved.cycleMembers) {
    report.errors.push({
      level: 'error',
      code: 'cycle',
      message: `Item ${cid} is part of a blocked-by cycle.`,
      itemId: cid,
    });
  }

  // WI-40832: plans are execution graphs, not ordered prose. Surface the graph
  // shapes that make a fleet look provisioned while only one (or zero) member
  // can actually pull work. Keep these as authoring warnings: a deliberately
  // serial plan is valid, but the shape must be visible before launch.
  const dag = analyzePlanDagParallelism(parsed.items);
  for (const dependencyFinding of dag.findings) {
    if (dependencyFinding.classification !== 'advisory' || dependencyFinding.suppressedBy) continue;
    report.warnings.push({
      level: 'warning',
      code: dependencyFinding.code,
      message:
        `${dependencyFinding.code}: ${JSON.stringify(dependencyFinding.evidence)}. ` +
        `${dependencyFinding.suggestedAction ?? 'Review the exact nodes and edges.'}`,
      itemId: dependencyFinding.nodes[0],
      dependencyFinding,
    });
  }

  const resolvedById = new Map(resolved.items.map((i) => [i.id, i]));
  for (const it of parsed.items) {
    // §3.4: the stored `blocked` token is reserved for *external*
    // blockers (upstream PR, vendor). Internal dependencies use
    // blocked-by and are computed — so a stored `blocked` that also
    // carries blocked-by is a contradiction; the token should be `todo`.
    if (it.storedStatus === 'blocked' && it.blockedBy.length > 0) {
      // EI-19397307303043951: when every blocked-by dependency has ALREADY
      // resolved, this is no longer merely a contradiction to clean up
      // eventually — it is the live trap: effectiveStatus is stuck 'blocked'
      // RIGHT NOW (resolveEffectiveStatusForItems's staleBlockedHint),
      // hiding real claimable work from scheduler:get_next behind a queue
      // that reads as drained. Escalate the message so it stops looking like
      // routine authoring advice.
      const staleHint = resolvedById.get(it.id)?.staleBlockedHint ?? null;
      report.warnings.push({
        level: 'warning',
        code: 'stored_blocked_with_blocked_by',
        message: staleHint
          ? `Item ${it.id} is stuck 'blocked' RIGHT NOW: ${staleHint} (this is not just an authoring nit — it is currently hiding claimable work from scheduler:get_next).`
          : `Item ${it.id} is stored as 'blocked' and also has blocked-by — 'blocked' is for external blockers only; internal deps are computed from blocked-by, so the stored token should be 'todo'.`,
        itemId: it.id,
      });
    }
    // §3.3: every item lives under a `## Phase` heading.
    if (it.phase === null) {
      report.warnings.push({
        level: 'warning',
        code: 'unphased_item',
        message: `Item ${it.id} is not under a '## Phase' heading — §3.3 expects every item to live in a phase section.`,
        itemId: it.id,
      });
    }
  }

  // P-004 / D-005: if this plan ACTUALLY promoted features (i.e.
  // harness_features_consolidated has rows with
  // metadata.source_plan === <this slug>), the plan body should have
  // a ## Promoted block recording them.
  //
  // The trigger is semantic, not syntactic. The earlier version
  // regex-scanned the plan body for F-NNN-shaped strings, which
  // false-positived on any plan that mentioned a feature id in
  // *prose* — even purely as documentation ("here's how F-FIX-024
  // works"). Querying PG for features that claim this slug as their
  // source asks the right question: did this plan actually mint
  // features?
  //
  // Severity is date-gated against the migration ship date. Plans
  // CREATED before then won't have the block until backfilled — emit
  // a WARNING. Plans created AFTER should always have it — emit an
  // ERROR. Backfill state takes precedence: a plan with the block
  // already silences the check regardless of created-date.
  const PROMOTED_BLOCK_ENFORCEMENT_DATE = '2026-05-24';
  const hasPromotedBlock = /^## Promoted\b/m.test(parsed.raw);
  if (!hasPromotedBlock) {
    const planSlug = parsed.frontmatter.slug ?? parsed.slug;
    const promotedCount = await countFeaturesFromPlan(planSlug);
    if (promotedCount > 0) {
      const createdStr = parsed.frontmatter.created;
      const isPostMigration =
        typeof createdStr === 'string' && createdStr >= PROMOTED_BLOCK_ENFORCEMENT_DATE;
      const finding: LintFinding = {
        level: isPostMigration ? 'error' : 'warning',
        code: 'missing_promoted_block',
        message: isPostMigration
          ? `Plan promoted ${promotedCount} feature(s) (metadata.source_plan == ${planSlug}) but the body has no \`## Promoted\` block — run plans:promote apply=true to regenerate it.`
          : `Plan promoted ${promotedCount} feature(s) (metadata.source_plan == ${planSlug}) but the body has no \`## Promoted\` block — run plans:promote apply=true (or the backfill script) to generate it.`,
      };
      if (isPostMigration) {
        report.errors.push(finding);
      } else {
        report.warnings.push(finding);
      }
    }
  }

  // (The former `updated_lags_mtime` warning compared frontmatter `updated:`
  // against the plan FILE's git mtime. Plans are PG-canonical now — there is no
  // file, and the row's `updated_at` is auto-bumped on every write, so there's
  // no faithful equivalent. Dropped with plans-pg-canonical-migration-2026-06-03.)

  // P-002 (promote-spawn-child-harness, D-001): a `## Promote` wave that declares
  // `spawn_child` creates a NEW child harness rather than promoting into the
  // current one — a heavier act only justified at a repo/worktree boundary or for
  // work needing its own lifecycle. That boundary is never mechanically
  // detectable, so this is a WARNING (never an error): prompt the author to
  // confirm the justification. A sharper warning fires when neither `repo` nor
  // `template` is given (the child's target tree is ambiguous). Only spawn_child
  // findings are surfaced here — a malformed/absent `## Promote` block yields a
  // null policy and is left alone (it's not this check's remit).
  const promote = promotePolicy ?? parsePromotePolicy(parsed.raw);
  if (promote.policy) {
    for (const w of promote.policy.waves) {
      const child = w.spawn_child;
      if (!child) continue;
      report.warnings.push({
        level: 'warning',
        code: 'spawn_child_wave',
        message:
          `Wave "${w.id}" declares spawn_child "${child.slug}", which creates a NEW child harness. ` +
          `Per D-001, spawn_child is only justified for cross-repo / own-worktree work or work needing its own ` +
          `lifecycle — same-repo sub-work should stay as features in the current harness. Confirm the boundary justification.`,
      });
      if (!child.repo && !child.template) {
        report.warnings.push({
          level: 'warning',
          code: 'spawn_child_ambiguous_target',
          message:
            `Wave "${w.id}" spawn_child "${child.slug}" gives neither repo nor template — the child's target tree is ` +
            `ambiguous. Set spawn_child.template (a spawnable template) or spawn_child.repo (a git URL).`,
        });
      }
    }
  }

  // EI-12150 (rubric-system-hardening P-005): the DERIVED-VERDICT guard. A `## Now`
  // claiming GREEN / GO / release-ready is PROSE — it does not re-derive when the
  // gating rubric's scorecards move, so it silently goes stale and the next reader
  // treats a days-old claim as the current verdict (the 2026-07-14 GO stall: a
  // "PUBLIC RELEASE GREEN" Now contradicted by three newer at-risk scorecards).
  // When the Now claims green AND the plan references an ACTIVE releaseGating
  // rubric, compare against that rubric's NEWEST COMPLETE scorecard and WARN
  // (advisory, never an error — lints advise) when the evidence disagrees.
  // Fail-open like countFeaturesFromPlan: a PG/rubrics blip must never break lint.
  // Cost-gated: the rubric/scorecard reads run ONLY when the claim regex hits.
  if (parsed.now && hasReleaseClaim(parsed.now.raw)) {
    try {
      const gating = await gatingRubricScorecardSummaries();
      report.warnings.push(...evaluateDerivedVerdict(parsed.raw, gating));
    } catch {
      /* fail open — the guard is advisory */
    }
  }

  return report;
}

// ─── EI-12150: derived-verdict guard (pure decider + fail-open PG gather) ────────

/**
 * PURE: does this prose CLAIM a green/GO/release-ready verdict? The bare tokens are
 * matched UPPERCASE-ONLY (a lowercase "go"/"green" is everyday prose — "go to",
 * "green button"), phrase-forms case-insensitively, and a NO-GO never reads as GO.
 */
export function hasReleaseClaim(text: string): boolean {
  return (
    /(?<!NO[- ])\b(?:GO|GREEN)\b/.test(text) ||
    /release[- ]ready|ready for (?:public )?release|public[- ]release green/i.test(text)
  );
}

/** One active releaseGating rubric + its newest COMPLETE scorecard (null when none). */
export interface GatingRubricScorecardSummary {
  rubricRef: string;
  newestComplete: {
    issueId: string;
    createdAt: string;
    ratings: Record<string, { rating: string }>;
  } | null;
}

/** Ratings that COUNT as passing for the all-pass read. Anything else — fail, broken,
 *  degraded, partial, at-risk, unknown — means the newest complete evidence does not
 *  support a green claim. */
const PASSING_RATINGS = new Set(['pass', 'healthy']);

/**
 * PURE: the derived-verdict comparison. For each gating rubric the plan REFERENCES
 * (its rubricRef appears in the plan text), a green claim must be backed by the
 * newest COMPLETE scorecard being all-pass; a missing complete scorecard is called
 * out distinctly (an UNVERIFIED claim, not merely a failing one). Rubrics the plan
 * never mentions are ignored — this guard checks claims against THEIR OWN evidence,
 * it does not make every plan answer for every rubric.
 */
export function evaluateDerivedVerdict(
  planRaw: string,
  gating: GatingRubricScorecardSummary[],
): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const g of gating) {
    if (!planRaw.includes(g.rubricRef)) continue;
    if (!g.newestComplete) {
      findings.push({
        level: 'warning',
        code: 'derived_verdict_unverified',
        message:
          `\`## Now\` claims GREEN/GO/release-ready and references release-gating rubric '${g.rubricRef}', ` +
          `but NO complete scorecard exists for it — the claim is unverified prose. File one ` +
          `(improvements:capture { lane:'observation', observation: { rubricRef, ratings } }) or soften the claim (EI-12150).`,
      });
      continue;
    }
    const failing = Object.entries(g.newestComplete.ratings)
      .filter(([, r]) => !PASSING_RATINGS.has(r.rating.toLowerCase()))
      .map(([k, r]) => `${k}=${r.rating}`);
    if (failing.length > 0) {
      findings.push({
        level: 'warning',
        code: 'derived_verdict_mismatch',
        message:
          `\`## Now\` claims GREEN/GO/release-ready, but rubric '${g.rubricRef}' newest COMPLETE scorecard ` +
          `(${g.newestComplete.issueId}, ${g.newestComplete.createdAt}) is NOT all-pass: ${failing.join(', ')}. ` +
          `A verdict in prose does not re-derive — update the Now to match the evidence, or re-grade if the ` +
          `evidence is stale (EI-12150).`,
      });
    }
  }
  return findings;
}

/** The fail-open PG gather: every ACTIVE releaseGating rubric + its newest COMPLETE
 *  scorecard. Dynamic imports (the countFeaturesFromPlan pattern) keep lint off the
 *  rubrics/scorecards static dependency graph. */
async function gatingRubricScorecardSummaries(): Promise<GatingRubricScorecardSummary[]> {
  const { listRubrics } = await import('../../rubrics');
  const { listScorecards } = await import('../../scorecards');
  const gating = (await listRubrics({ status: 'active' })).filter((r) => r.releaseGating === true);
  return Promise.all(
    gating.map(async (r) => {
      const rows = await listScorecards({ rubricRef: r.rubricId, limit: 25 });
      const newest = rows.find((row) => row.rubricResolved && row.missingKeys.length === 0 && row.extraKeys.length === 0);
      return {
        rubricRef: r.rubricId,
        newestComplete: newest
          ? { issueId: newest.issueId, createdAt: newest.createdAt, ratings: newest.ratings }
          : null,
      };
    }),
  );
}

/** One plan's row in the bounded all-plans summary: identity + finding
 *  counts, with the ERROR findings inlined (few + actionable, the CI-gating
 *  signal) but WARNINGS collapsed to a count (they are advisory + the bulk of
 *  the bytes — ~400 verbose messages on a real workspace). Drill into a plan's
 *  full warnings by linting its single `slug`. */
export interface LintSummaryPlan {
  slug: string;
  archived?: true;
  legacy?: true;
  exempt?: true;
  errorCount: number;
  warningCount: number;
  errors?: LintFinding[];
}

export interface LintSummary {
  ok: boolean;
  mode: 'summary';
  totalErrors: number;
  totalWarnings: number;
  exempt: number;
  planCount: number;
  errorsByCode: Record<string, number>;
  warningsByCode: Record<string, number>;
  /** Only plans with ≥1 finding (errors inlined, warnings as a count). */
  plans: LintSummaryPlan[];
  hint: string;
}

/**
 * Collapse the full per-plan reports into a BOUNDED summary that fits the
 * agent result-size cap (F-FIX-034 / EI-… : `plans:lint` over a real workspace
 * returned 170KB+ in one line → "exceeds maximum allowed tokens" → an unusable
 * blob). Errors gate (kept in full); warnings advise (kept as per-plan counts +
 * a workspace-wide code rollup). Pure — unit-testable without PG. The complete
 * reports stay available via `full: true` (HTTP) or a single-`slug` lint.
 */
export function summarizeLintReports(reports: PlanLintReport[]): LintSummary {
  const errorsByCode: Record<string, number> = {};
  const warningsByCode: Record<string, number> = {};
  let totalErrors = 0;
  let totalWarnings = 0;
  let exempt = 0;
  const plans: LintSummaryPlan[] = [];
  for (const r of reports) {
    totalErrors += r.errors.length;
    totalWarnings += r.warnings.length;
    if (r.exempt) exempt += 1;
    for (const e of r.errors) errorsByCode[e.code] = (errorsByCode[e.code] ?? 0) + 1;
    for (const w of r.warnings) warningsByCode[w.code] = (warningsByCode[w.code] ?? 0) + 1;
    if (r.errors.length === 0 && r.warnings.length === 0) continue;
    plans.push({
      slug: r.slug,
      ...(r.archived ? { archived: true as const } : {}),
      ...(r.legacy ? { legacy: true as const } : {}),
      ...(r.exempt ? { exempt: true as const } : {}),
      errorCount: r.errors.length,
      warningCount: r.warnings.length,
      ...(r.errors.length > 0 ? { errors: r.errors } : {}),
    });
  }
  return {
    ok: totalErrors === 0,
    mode: 'summary',
    totalErrors,
    totalWarnings,
    exempt,
    planCount: reports.length,
    errorsByCode,
    warningsByCode,
    plans,
    hint:
      'Bounded summary (errors inlined; warnings as counts). Lint one plan for its full warning detail: plans:lint { slug }. For the complete per-plan dump: plans:lint { full: true } (may exceed the agent result-size cap on large workspaces).',
  };
}

export default defineTool({
  name: 'plans:lint',
  description:
    "Validate plan files. Legacy plans are exempt. CI should fail on any error; warnings are informational. With `slug` or `slugs`: full per-plan reports in the standard bulk envelope. Without a slug: a BOUNDED summary across all plans (totals + per-code rollups + per-plan finding counts, with errors inlined) — warnings are collapsed to counts so the result never blows the agent size cap. Pass `full: true` for the complete per-plan dump (HTTP-safe; may overflow an agent caller on a large workspace).",
  guidance: {
    when: 'You\'re editing a plan and want to verify it parses cleanly, or you\'re running the doc-tree health check.',
    notWhen:
      'You just want to read plans — use plans:list/get.',
    chaining: 'All-plans summary flags a plan with errors → plans:lint { slug } for its full findings → plans:get { slug } for context.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);

    const slugs = mergeIds(args.slug, args.slugs);
    if (slugs.length > 0) {
      const env = await runBulk(
        slugs,
        async (slug) => {
          const r = await lintPlan(slug, opts);
          if (!r) return { ok: false as const, slug, error: 'not_found' };
          return {
            ok: true as const,
            slug,
            report: r,
            totalErrors: r.errors.length,
            totalWarnings: r.warnings.length,
            exempt: r.exempt ? 1 : 0,
          };
        },
        { keyOf: (slug) => ({ slug }) },
      );
      const reports = env.results.flatMap((r) => (r.ok && 'report' in r ? [r.report as PlanLintReport] : []));
      ctxAny.metadata?.({
        planCount: reports.length,
        errors: reports.reduce((n, r) => n + r.errors.length, 0),
        warnings: reports.reduce((n, r) => n + r.warnings.length, 0),
        exempt: reports.filter((r) => r.exempt).length,
      });
      return bulkContent(env);
    }

    let reports: PlanLintReport[];
    const includeArchived = args.includeArchived === true;
    const entries = await listPlanFiles(opts);
    const filtered = includeArchived ? entries : entries.filter((e) => !e.archived);
    reports = [];
    for (const e of filtered) {
      const r = await lintPlan(e.slug, opts);
      if (r) reports.push(r);
    }

    const totalErrors = reports.reduce((n, r) => n + r.errors.length, 0);
    const totalWarnings = reports.reduce((n, r) => n + r.warnings.length, 0);
    const exempt = reports.filter((r) => r.exempt).length;

    ctxAny.metadata?.({
      planCount: reports.length,
      errors: totalErrors,
      warnings: totalWarnings,
      exempt,
    });

    // Single-slug: the full report (one plan is always small). All-plans with
    // `full:true`: the legacy complete dump (HTTP-safe; may overflow an agent
    // caller). All-plans default: the BOUNDED summary — warnings collapsed to
    // counts so a real workspace (484 plans × ~380 warnings → 170KB+) no longer
    // blows the agent result-size cap and returns an unusable blob (F-FIX-034).
    const payload =
      args.full === true
        ? { ok: totalErrors === 0, totalErrors, totalWarnings, exempt, reports }
        : summarizeLintReports(reports);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(payload),
        },
      ],
    };
  },
});
