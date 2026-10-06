/**
 * plans:set-content — whole-document write with compare-and-swap.
 *
 * agent-plan-tracking Phase 5 (D-011 of plans-admin-ui-2026-05-20).
 *
 * The one genuinely unstructured plan write. The assisted writers
 * (set-status / set-now / add-decision / add-item) each touch a single
 * parser-recognized region; this verb replaces the entire document —
 * for the Plans admin tab's raw-prose Edit mode (P-301), which lets a
 * human rewrite the free-prose sections (`## Background` etc.) that the
 * assisted verbs cannot reach.
 *
 * Three guards make it as safe as the structured verbs:
 *
 *   1. Compare-and-swap. `expectedHash` is the `contentHash` from the
 *      `plans:get` that loaded the editor. Inside the lock the live
 *      file is hashed; a mismatch rejects `{ error: 'stale' }` with the
 *      current bytes so the UI can reload — a concurrent change is
 *      never silently clobbered. A UI edit session holds the lock only
 *      for the write, not the minutes of editing, so CAS — not the
 *      lock — is the real concurrency guard.
 *   2. Legacy-boundary guard. `plans:lint` exempts legacy plans, so a
 *      payload that drops `slug:` / `status:` would degrade a real plan
 *      to legacy and lint would pass vacuously. If the file was
 *      non-legacy, a result that parses legacy is rejected.
 *   3. Reject on lint errors. The proposed body is parsed + linted
 *      in-memory (`lintParsed`) before the write; errors reject and
 *      return the findings, warnings pass.
 *
 * Writes inside `withPlanLock`. Does not emit a plan_event — the
 * plan-event vocabulary covers the structured lifecycle (now / item /
 * decision / status), not a whole-document rewrite.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  derivePlanLifecycle,
  derivePlanStatusTransition,
  findTerminalPlanChildMutations,
  type TerminalPlanChildMutation,
} from '@papercusp/plan-parser';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock } from './with-plan-lock';
import { domainFailureMessage } from './plan-activation-gate';
import { parsePlan, type ParsedPlan } from './parser';
import { detectItemTextChanges, type PlanItemTextChange } from '../../plan-items/text-drift';
import { planItemTextDriftForWrite } from '../../plan-items/text-drift-report';
import type { ResolveIdentityCtx } from '../coordination/identity';
import { summarizeItemParse, type ItemParseSummary } from './item-parse-feedback';
import { lintParsed, type LintFinding } from './lint';
import { hashPlanContent } from './content-hash';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { clearStartedForTerminalPlan, isTerminalPlanStatus } from './plan-start-state';
import { stampTerminalNowBlock } from './terminal-now-stamp';
import { parseRequirementBars } from '../../acceptance-bar-seed';

/**
 * `dev:pg_query` exposes PostgreSQL bigint values as decimal strings, while
 * the plan version CAS itself is a nonnegative safe JS integer. Accept that
 * read-then-write wire shape without weakening the published JSON schema or
 * silently coercing arbitrary numeric strings.
 */
const expectedVersionSchema = z.preprocess(
  (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
);

export const argsSchema = z.object({
  slug: z.string().min(1),
  harness: harnessArg,
  content: z
    .string()
    .min(1)
    .describe('The full new markdown document body — replaces the file wholesale.'),
  expectedVersion: expectedVersionSchema
    .optional()
    .describe(
      'The `version` from the plans:get that loaded the editor — the optimistic compare-and-swap baseline (plans-pg-canonical-migration D-005). When the live row has moved past it the write is rejected as stale. Preferred over expectedHash.',
    ),
  expectedHash: z
    .string()
    .optional()
    .describe(
      'Legacy CAS baseline — the `contentHash` from plans:get. Equivalent to expectedVersion (both detect a concurrent change); kept for callers that still send a hash. When it no longer matches the stored content the write is rejected as stale.',
    ),
  rationale: z
    .string()
    .optional()
    .describe(
      'Optional — the *why* behind this rewrite: the rejected alternative, the constraint that forced it, the argument that settled it. Stored on the plan revision and always loaded as context for any agent later launched from this plan (D-009). State it for a substantive rewrite; a trivial fix may omit it.',
    ),
  allowShrink: z
    .boolean()
    .optional()
    .describe(
      'A body that shrinks the plan to under 20% of its current size is rejected as a probable mass deletion (`suspicious_shrink`) unless this is true. Pass it only when the shrink is intentional — e.g. archiving prose that moved elsewhere.',
    ),
  allowStatusRegression: z
    .boolean()
    .optional()
    .describe(
      'A write with no expectedVersion/expectedHash that would move an item BACKWARD off a terminal (done/dropped) status is rejected as `item_status_regression` (almost always a stale-read clobber of someone else\'s completed work) unless this is true. Pass it only when the regression is intentional — e.g. genuinely reopening a wrongly-closed item. Carrying expectedVersion/expectedHash from a fresh plans:get avoids needing this at all.',
    ),
});

export type SetContentValue =
  | {
      ok: true;
      slug: string;
      contentHash: string;
      warning?: string;
      nowStamped?: boolean;
      parseFeedback: ItemParseSummary;
      /**
       * WI-40825: plan items whose SEMANTIC text this write changed or removed.
       * Computed here (in the one evaluator all three whole-body writers share)
       * so the handler can look up the work_items already minted from those
       * items and warn/notify their holders — a converted item's text is
       * snapshotted at mint and never refreshed, so a rewrite silently strands
       * whoever is executing it. Empty/absent ⇒ this write touched no item text.
       */
      itemTextChanges?: PlanItemTextChange[];
      /** True when this write changes whether the current lifecycle status warrants
       *  an automatic drained-plan transition. The reaction rule rechecks under lock. */
      planDrainTransitionChanged?: boolean;
    }
  | { ok: false; code: 'not_found' }
  | {
      ok: false;
      code: 'plan_status_change_requires_lifecycle_writer';
      currentStatus: string | null;
      proposedStatus: string | null;
      writer: 'plans:set-plan-status' | 'plans:set-frontmatter';
      message: string;
    }
  | { ok: false; code: 'stale'; currentContent: string; currentHash: string; currentVersion?: number }
  | {
      ok: false;
      code: 'suspicious_shrink';
      /** What tripped the guard — a wholesale byte shrink, or a structural
       *  drop of items/decisions that byte size missed (EI-83). */
      reason: 'bytes' | 'structure';
      currentLength: number;
      proposedLength: number;
      /** Structural deltas (populated for `reason: 'structure'`). */
      priorItems?: number;
      priorDecisions?: number;
      droppedItems?: number;
      droppedDecisions?: number;
    }
  | { ok: false; code: 'would_orphan_frontmatter' }
  | {
      ok: false;
      code: 'item_status_regression';
      /** Items that would move backward off a terminal (done/dropped)
       *  status — see detectStatusRegressions. */
      regressions: StatusRegressionEntry[];
    }
  | {
      ok: false;
      code: 'terminal_parent_child_mutation';
      parentStatus: string;
      changes: TerminalPlanChildMutation[];
      message: string;
    }
  | {
      ok: false;
      code: 'lint_failed';
      /** Only the errors THIS write introduces (the ratchet) — never the
       *  plan's pre-existing ones, which no single edit could clear. */
      errors: LintFinding[];
      /** How many errors the live body already carried. Non-zero means the
       *  plan was already in violation and this write was judged against
       *  that baseline, not against zero. */
      preexistingErrors?: number;
    };

/**
 * Identity of a lint finding for the ratchet, INDEPENDENT of where in the file
 * it happens to sit.
 *
 * ⚠ The line-number scrub is load-bearing, not cosmetic. Lint messages embed
 * positions (`Duplicate decision id: D-045 at line 1650`), so any edit that
 * adds or removes a line renumbers every finding below it. Comparing raw
 * messages would therefore read a pre-existing error at its new line as a
 * BRAND NEW one and reject the write — reproducing the exact wedge this
 * ratchet exists to remove, while looking like it worked.
 */
function lintSignature(f: LintFinding): string {
  const message = f.message.replace(/\bline \d+\b/g, 'line N');
  return [f.code, f.itemId ?? '', f.decisionId ?? '', message].join('\x00');
}

/**
 * The errors in `proposed` that are NOT already present in `baseline`, compared
 * as a MULTISET — two instances of the same error must not be excused by one
 * pre-existing instance.
 *
 * Deliberately not a count comparison: a write that fixes one error and
 * introduces a different one leaves the count unchanged and would slip through.
 */
export function errorsIntroduced(baseline: LintFinding[], proposed: LintFinding[]): LintFinding[] {
  const budget = new Map<string, number>();
  for (const f of baseline) {
    const sig = lintSignature(f);
    budget.set(sig, (budget.get(sig) ?? 0) + 1);
  }
  const introduced: LintFinding[] = [];
  for (const f of proposed) {
    const sig = lintSignature(f);
    const left = budget.get(sig) ?? 0;
    if (left > 0) budget.set(sig, left - 1);
    else introduced.push(f);
  }
  return introduced;
}

/** A proposed body this much smaller than the live one is treated as a
 *  probable mass deletion (truncated paste, wrong-plan write, model
 *  hallucinating a fresh doc) and rejected unless the caller passes
 *  `allowShrink: true` (EI-83 / audit P-040). */
export const SUSPICIOUS_SHRINK_RATIO = 0.2;

/**
 * One item that was TERMINAL (`done`/`dropped`) in the live plan but is
 * proposed to move BACKWARD to a non-terminal status (EI-18756269998422483).
 */
export interface StatusRegressionEntry {
  id: string;
  from: string;
  to: string;
}

/**
 * Items whose stored status would REGRESS off a terminal state
 * (EI-18756269998422483: "a plan item's `done` status silently reverted to
 * `todo` mid-session ... completion state is being lost, not just
 * mis-displayed"). Root-caused to exactly this shape: a whole-document write
 * built from a STALE read (no CAS baseline carried forward) silently
 * clobbered an unrelated item's status back to whatever the caller's stale
 * copy said, even though the write never named that item. The structured
 * verbs (plans:set-status) cannot do this — each touches exactly one named
 * item — so this guard exists only for the genuinely unstructured writers
 * (set-content / set-content-chunk).
 */
export function detectStatusRegressions(
  currentParsed: ParsedPlan,
  proposed: ParsedPlan,
): StatusRegressionEntry[] {
  const proposedById = new Map(proposed.items.map((it) => [it.id, it]));
  const out: StatusRegressionEntry[] = [];
  for (const cur of currentParsed.items) {
    if (cur.storedStatus !== 'done' && cur.storedStatus !== 'dropped') continue;
    const next = proposedById.get(cur.id);
    if (next && next.storedStatus !== cur.storedStatus) {
      out.push({ id: cur.id, from: cur.storedStatus, to: next.storedStatus });
    }
  }
  return out;
}

/** Once a plan carries at least this many items+decisions, wiping most of
 *  them is a red flag rather than ordinary churn. Below it the byte-ratio
 *  guard is the only shrink check — a tiny plan legitimately rewrites its
 *  handful of items, and a structural ratio on small counts is all noise. */
export const STRUCTURAL_GUARD_MIN_PRIOR = 5;
/** A write that drops MORE than this fraction of the prior plan's combined
 *  items+decisions is treated as a probable truncation and rejected without
 *  `allowShrink`. The EI-83 forensic dropped 100% (15 items + 9 decisions)
 *  while keeping enough prose that the byte-ratio guard alone would not have
 *  caught a prose-heavy variant — the structural count is the real signal. */
export const STRUCTURAL_DROP_RATIO = 0.5;

/**
 * The mass-deletion guard: a byte-ratio shrink OR a structural drop of
 * items/decisions (EI-83). Byte ratio catches a wholesale truncated paste;
 * the structural check catches the case byte size misses — a prose-heavy plan
 * whose items + decisions are wiped while a long `## Background` keeps the
 * byte count above the ratio. Returns the rejection value, or null to pass.
 */
function detectSuspiciousShrink(
  current: string,
  content: string,
  currentParsed: ParsedPlan,
  proposed: ParsedPlan,
): Extract<SetContentValue, { code: 'suspicious_shrink' }> | null {
  // 1. Wholesale byte shrink — a truncated paste / wrong-plan write.
  if (content.length < current.length * SUSPICIOUS_SHRINK_RATIO) {
    return {
      ok: false,
      code: 'suspicious_shrink',
      reason: 'bytes',
      currentLength: current.length,
      proposedLength: content.length,
    };
  }
  // 2. Structural drop — items/decisions destroyed even though bytes survived.
  const priorStructural = currentParsed.items.length + currentParsed.decisions.length;
  const proposedStructural = proposed.items.length + proposed.decisions.length;
  if (
    priorStructural >= STRUCTURAL_GUARD_MIN_PRIOR &&
    proposedStructural < priorStructural * (1 - STRUCTURAL_DROP_RATIO)
  ) {
    return {
      ok: false,
      code: 'suspicious_shrink',
      reason: 'structure',
      currentLength: current.length,
      proposedLength: content.length,
      priorItems: currentParsed.items.length,
      priorDecisions: currentParsed.decisions.length,
      droppedItems: currentParsed.items.length - proposed.items.length,
      droppedDecisions: currentParsed.decisions.length - proposed.decisions.length,
    };
  }
  return null;
}

/** Surfacing (EI-83 fix #2): a one-line "this write removed N items" note
 *  attached to a SUCCESSFUL write whenever it drops items/decisions — so even
 *  an allowed shrink is visible in the response instead of silent. */
function shrinkWarning(currentParsed: ParsedPlan, proposed: ParsedPlan): string | undefined {
  const droppedItems = currentParsed.items.length - proposed.items.length;
  const droppedDecisions = currentParsed.decisions.length - proposed.decisions.length;
  if (droppedItems <= 0 && droppedDecisions <= 0) return undefined;
  const parts: string[] = [];
  if (droppedItems > 0) parts.push(`${droppedItems} item${droppedItems === 1 ? '' : 's'}`);
  if (droppedDecisions > 0) parts.push(`${droppedDecisions} decision${droppedDecisions === 1 ? '' : 's'}`);
  return `This write removed ${parts.join(' and ')}.`;
}

/**
 * The pure CAS + legacy-boundary + lint decision for a set-content
 * write. Exported so it can be unit-tested without the SU lock
 * side-database — the handler runs exactly this inside `withPlanLock`.
 *
 *   - `current` is the live file body, or null if the file is absent.
 *   - `newBody` is what to write (null = reject, leave the file).
 */
export async function evaluateSetContent(
  current: string | null,
  content: string,
  slug: string,
  expectedHash: string | undefined,
  opts: {
    expectedVersion?: number;
    meta?: { version: number; contentHash: string } | null;
    allowShrink?: boolean;
    /**
     * EI-18756269998422483: opt this call into the item-status-regression
     * guard (detectStatusRegressions). Only the whole-document rewriters
     * (set-content, set-content-chunk) pass this — plans:edit's exact-match
     * requirement is already its OWN concurrency guard (see edit.ts's header)
     * and is deliberately left out of this additional check.
     */
    wholeDocumentRewrite?: boolean;
    /** Explicit override: the regression is intentional (e.g. reopening a
     *  wrongly-closed item) even though no CAS baseline was supplied. */
    allowStatusRegression?: boolean;
  } = {},
): Promise<{ newBody: string | null; value: SetContentValue }> {
  if (current === null) {
    return { newBody: null, value: { ok: false, code: 'not_found' } };
  }

  // 1. Compare-and-swap — reject a write against a plan that changed since the
  //    editor loaded it. Prefer the optimistic version CAS (D-005); fall back to
  //    the equivalent content-hash CAS for callers that still send expectedHash.
  const currentHash = hashPlanContent(current);
  const currentVersion = opts.meta?.version;
  if (opts.expectedVersion != null && currentVersion != null && opts.expectedVersion !== currentVersion) {
    return {
      newBody: null,
      value: { ok: false, code: 'stale', currentContent: current, currentHash, currentVersion },
    };
  }
  if (expectedHash && expectedHash !== currentHash) {
    return {
      newBody: null,
      value: { ok: false, code: 'stale', currentContent: current, currentHash, currentVersion },
    };
  }

  const filePath = `${slug}.md`;
  const currentParsed = parsePlan(current, { filePath });
  // EI-1812: a PG-canonical plan keeps its frontmatter in PG columns, so a raw-body
  // edit legitimately omits the leading `---…---` block. parsePlan then flags the
  // proposed body `isLegacy`, which the legacy-boundary guard below would reject as
  // `would_orphan_frontmatter` — even though the canonical frontmatter is NOT being
  // dropped (it survives in the columns + the current body). When the proposed body
  // carries no frontmatter of its own, re-attach the CURRENT plan's frontmatter so the
  // shrink/legacy/lint guards + the stored body see the real, preserved result. A body
  // that DOES carry its own `---…---` is left untouched — an intentional frontmatter
  // rewrite still passes through the legacy-boundary guard + lint unchanged.
  let body = content;
  let proposed = parsePlan(body, { filePath });
  // A CLEAN PG-canonical body omits frontmatter entirely and starts with markdown (`# …`).
  // A body that STRIPPED only its opening `---` fence is corruption, not omission: it begins
  // with the former frontmatter KEYS and still carries the orphaned CLOSING `---`
  // (`title: …\nstatus: …\n---\n# body`). Re-attaching would silently produce a plan with
  // DUPLICATED frontmatter keys + a stray fence, so detect that signature and let the
  // legacy-boundary guard reject it (would_orphan_frontmatter) instead of rescuing it.
  const looksLikeStrippedFrontmatter =
    /^[ \t]*[A-Za-z0-9_][\w-]*:[ \t]/.test(body) && /(^|\r?\n)---[ \t]*\r?\n/.test(body);
  if (!currentParsed.isLegacy && proposed.isLegacy && !/^\s*---\r?\n/.test(body) && !looksLikeStrippedFrontmatter) {
    const fm = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/.exec(current)?.[1];
    if (fm) {
      const reattached = fm + body;
      const reparsed = parsePlan(reattached, { filePath });
      if (!reparsed.isLegacy) {
        body = reattached;
        proposed = reparsed;
      }
    }
  }

  // 1b. Mass-deletion guard (EI-83 / audit P-040) — a body that shrinks the
  //     plan past the byte ratio OR drops most of its items/decisions is far
  //     more often a truncated paste or a wrong-plan write than an intentional
  //     rewrite. Require the caller to say so explicitly via allowShrink.
  if (!opts.allowShrink) {
    const shrink = detectSuspiciousShrink(current, body, currentParsed, proposed);
    if (shrink) return { newBody: null, value: shrink };
  }

  // 1c. Status-regression guard (EI-18756269998422483) — a whole-document
  //     rewriter (set-content / set-content-chunk) with NO CAS baseline (no
  //     expectedVersion/expectedHash to prove the caller's copy is fresh) that
  //     moves an item BACKWARD off a terminal (done/dropped) status is almost
  //     certainly built from a stale read silently reverting someone else's
  //     completed work — exactly how a plan item's `done` status was observed
  //     to silently revert to `todo` mid-session with none of the writes in
  //     between ever naming that item. A CAS-VERIFIED write is provably fresh,
  //     so an intentional regression through it (e.g. genuinely reopening a
  //     wrongly-closed item) is allowed without the escape hatch; a CAS-less
  //     write needs `allowStatusRegression: true` to say the regression is
  //     deliberate. Scoped to whole-document rewriters only — plans:set-status
  //     is immune by construction (it only ever touches the one named item),
  //     and plans:edit's exact-match requirement is already its own
  //     concurrency guard (its header explains why it opts out).
  if (opts.wholeDocumentRewrite && !opts.allowStatusRegression) {
    const hadCasBaseline =
      (opts.expectedVersion != null && opts.meta?.version != null) || Boolean(expectedHash);
    if (!hadCasBaseline) {
      const regressions = detectStatusRegressions(currentParsed, proposed);
      if (regressions.length > 0) {
        return { newBody: null, value: { ok: false, code: 'item_status_regression', regressions } };
      }
    }
  }

  // 2. Legacy-boundary guard — a real plan must not be silently
  //    degraded to a (lint-exempt) legacy plan.
  if (!currentParsed.isLegacy && proposed.isLegacy) {
    return { newBody: null, value: { ok: false, code: 'would_orphan_frontmatter' } };
  }

  // Lifecycle status is owned by its structured writer. Raw content routes
  // (plans:edit, set-content, and set-content-chunk) must not skip activation,
  // admission, acceptance, supersede, or terminal cleanup gates. Legacy plans
  // convert only through set-frontmatter, which now accepts non-terminal starts.
  const currentStatus = currentParsed.frontmatter.status ?? null;
  const proposedStatus = proposed.frontmatter.status ?? null;
  const legacyConversion = currentParsed.isLegacy && !proposed.isLegacy;
  if (legacyConversion || currentStatus !== proposedStatus) {
    const writer = currentParsed.isLegacy ? 'plans:set-frontmatter' : 'plans:set-plan-status';
    return {
      newBody: null,
      value: {
        ok: false,
        code: 'plan_status_change_requires_lifecycle_writer',
        currentStatus,
        proposedStatus,
        writer,
        message: writer === 'plans:set-frontmatter'
          ? 'Legacy plans must be converted with plans:set-frontmatter and a non-terminal initial status.'
          : 'Plan lifecycle status changes must use plans:set-plan-status so the lifecycle gates and cleanup run.',
      },
    };
  }

  const terminalChildChanges = findTerminalPlanChildMutations(
    currentStatus,
    currentParsed.items.map((item) => ({ id: item.id, status: item.storedStatus })),
    proposed.items.map((item) => ({ id: item.id, status: item.storedStatus })),
  );
  if (currentStatus && terminalChildChanges.length > 0) {
    return {
      newBody: null,
      value: {
        ok: false,
        code: 'terminal_parent_child_mutation',
        parentStatus: currentStatus,
        changes: terminalChildChanges,
        message:
          'the parent plan is still ' +
          currentStatus +
          '; use plans:set-plan-status to transition it before adding or reopening a nonterminal child',
      },
    };
  }

  // WI-38303: raw-content writers may still edit prose on an already-terminal
  // plan. Preserve the terminal-Now invariant in the shared evaluator before
  // lint and derived indexes are written. Idempotent and prepend-only; an
  // absent Now block remains absent.
  const terminalStamp = stampTerminalNowBlock(body, proposed.frontmatter.status ?? '');
  const nowStamped = terminalStamp !== null;
  if (terminalStamp !== null) {
    body = terminalStamp;
    proposed = parsePlan(body, { filePath });
  }

  // A raw edit may change the BAR source without crossing a lifecycle gate.
  // Ratchet a previously parseable Requirements section here, at the shared
  // write path, so a malformed nested fence cannot sit in the plan until a
  // later audit or shipment attempt discovers it. Existing invalid plans must
  // remain editable so a sequence of small repairs can restore them.
  const priorBars = parseRequirementBars(current);
  if (priorBars.ok) {
    const nextBars = parseRequirementBars(body);
    if (!nextBars.ok) {
      return {
        newBody: null,
        value: {
          ok: false,
          code: 'lint_failed',
          errors: nextBars.problems.map((problem) => ({
            level: 'error',
            code: problem.code,
            message: problem.detail,
          })),
        },
      };
    }
  }

  // 3. Lint the proposed body in-memory; errors block the write — but only the
  //    errors this write INTRODUCES (EI-18804290731494084).
  //    `archived` is cosmetic for the lint rules — set-content targets
  //    active plans.
  //
  //    Judging the proposed body against ZERO errors makes a plan that is
  //    ALREADY in violation permanently un-writable: every edit is refused
  //    because of damage it did not cause and cannot clear in one string
  //    replace. That is not hypothetical — unified-agent-state-plane-2026-07-27
  //    reached exactly this state (two duplicate-decision-id errors ~370 lines
  //    apart, no single old_string spanning both), and a repair that dropped the
  //    error list 2 → 1 was still rejected. Lint is a RATCHET here: a write may
  //    not make the plan worse, and a clean plan still hard-rejects its first
  //    error.
  const report = await lintParsed(proposed, slug, false);
  if (report.errors.length > 0) {
    const baseline = await lintParsed(currentParsed, slug, false);
    const introduced = errorsIntroduced(baseline.errors, report.errors);
    if (introduced.length > 0) {
      return {
        newBody: null,
        value: {
          ok: false,
          code: 'lint_failed',
          errors: introduced,
          preexistingErrors: baseline.errors.length,
        },
      };
    }
  }

  const warning = shrinkWarning(currentParsed, proposed);
  // Item-parse feedback (WI-3363) — computed here so it flows to ALL three
  // whole-body writers that share this core (set-content, set-content-chunk,
  // edit). hintOnZeroItems is OMITTED (false): these all edit an EXISTING plan,
  // where a prose-only rewrite legitimately has 0 items — only genuinely
  // unparsed item lines warrant a hint. Parsed off `body` (the exact bytes
  // written, post frontmatter-reattach).
  const parseFeedback = summarizeItemParse(body, { bodyProvided: true });
  // WI-40825: which items' semantic text this write rewrites or removes. Parsed
  // off `body` (the exact bytes written) against the live parse, so it reflects
  // the real before/after — including the frontmatter-reattach and terminal-Now
  // stamp above. The PG lookup for work_items minted from these items is the
  // HANDLER's job (this evaluator stays pure); see plan-items/text-drift-report.
  const itemTextChanges = detectItemTextChanges(currentParsed, proposed);
  const priorDrainTarget =
    derivePlanStatusTransition(currentStatus, derivePlanLifecycle(currentParsed.items))?.to ?? null;
  const nextDrainTarget =
    derivePlanStatusTransition(currentStatus, derivePlanLifecycle(proposed.items))?.to ?? null;
  const planDrainTransitionChanged = priorDrainTarget !== nextDrainTarget;
  return {
    newBody: body,
    value: {
      ok: true,
      slug,
      contentHash: hashPlanContent(body),
      ...(warning ? { warning } : {}),
      ...(nowStamped ? { nowStamped: true } : {}),
      parseFeedback,
      ...(itemTextChanges.length > 0 ? { itemTextChanges } : {}),
      ...(planDrainTransitionChanged ? { planDrainTransitionChanged: true } : {}),
    },
  };
}

export default defineTool({
  name: 'plans:set-content',
  description:
    'Replace a plan file wholesale, guarded by a compare-and-swap on `expectedHash`. For raw-prose edits the structured verbs cannot make. Rejects stale writes, frontmatter loss, lifecycle status changes (use plans:set-plan-status), and writes that fail lint. A successful write is recorded as a plan revision; pass `rationale` to capture the why. For large plan bodies, use plans:set-content-chunk instead so the provider sends multiple small tool calls.',
  guidance: {
    when: 'A human is editing the raw markdown of a plan — prose sections the assisted verbs (set-now / set-status / add-decision / add-item) do not cover. Use only for small-to-medium bodies that fit comfortably in one tool call.',
    notWhen:
      'A structured edit — changing a lifecycle status, flipping an item, replacing the Now block, or appending a decision/item — use its dedicated verb. Convert a legacy plan with plans:set-frontmatter. For a large plan body use plans:set-content-chunk begin → append* → commit.',
    chaining:
      'plans:get { slug } → carry `contentHash` → plans:set-content { slug, content, expectedHash: contentHash }. For large bodies: plans:set-content-chunk begin → append* → commit.',
    seeAlso: [
      'plans:get (carry the contentHash first)',
      'plans:set-content-chunk (large / streamed body edits)',
      'plans:set-frontmatter (edit frontmatter, not the body)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    // Append a plan_revisions row after the write, while the lock is
    // still held — so `seq` allocation is race-free (P-002 / D-003).
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      args.rationale,
      harnessSlug ? { harnessSlug } : {},
    );
    const result = await withPlanLock<SetContentValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-content',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      (current, meta) =>
        evaluateSetContent(current, args.content, args.slug, args.expectedHash, {
          expectedVersion: args.expectedVersion,
          meta,
          allowShrink: args.allowShrink,
          wholeDocumentRewrite: true,
          allowStatusRegression: args.allowStatusRegression,
        }),
    );

    if (result.kind === 'busy') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'busy',
              busy: result.busy.map((b) => ({
                path: b.path,
                owner_label: b.owner_label,
                intent: b.intent,
                expires_ts: b.expires_ts,
              })),
            }),
          },
        ],
        isError: true,
      };
    }

    const v = result.value;
    if (!v.ok) {
      // Domain failures all use the `error` key (the plans:* convention);
      // stale + lint_failed carry their extra payload alongside it.
      const payload: Record<string, unknown> = { error: v.code, slug: args.slug };
      const domainMessage = domainFailureMessage(v);
      if (domainMessage) payload.message = domainMessage;
      if (v.code === 'stale') {
        payload.currentContent = v.currentContent;
        payload.currentHash = v.currentHash;
        if (v.currentVersion != null) payload.currentVersion = v.currentVersion;
      } else if (v.code === 'lint_failed') {
        payload.errors = v.errors;
        if (v.preexistingErrors) {
          payload.preexistingErrors = v.preexistingErrors;
          payload.hint =
            `only the ${v.errors.length} error(s) above were INTRODUCED by this write — the plan already carried ` +
            `${v.preexistingErrors} unrelated lint error(s), which do not block it.`;
        }
      } else if (v.code === 'suspicious_shrink') {
        payload.reason = v.reason;
        payload.currentLength = v.currentLength;
        payload.proposedLength = v.proposedLength;
        if (v.reason === 'structure') {
          payload.priorItems = v.priorItems;
          payload.priorDecisions = v.priorDecisions;
          payload.droppedItems = v.droppedItems;
          payload.droppedDecisions = v.droppedDecisions;
          payload.hint = `This write drops ${v.droppedItems} of ${v.priorItems} items and ${v.droppedDecisions} of ${v.priorDecisions} decisions — looks like a truncation. If intentional, retry with allowShrink: true.`;
        } else {
          payload.hint =
            'The proposed body is under 20% of the live plan — looks like a mass deletion. If intentional, retry with allowShrink: true.';
        }
      } else if (v.code === 'item_status_regression') {
        payload.regressions = v.regressions;
        payload.hint =
          `This write (no expectedVersion/expectedHash supplied) would move ${v.regressions.length} item(s) ` +
          `backward off a terminal status (${v.regressions.map((r) => `${r.id}: ${r.from}→${r.to}`).join(', ')}) — ` +
          `almost always a stale read clobbering someone else's completed work. Re-fetch via plans:get and carry its ` +
          `version/contentHash, or use plans:set-status for a real single-item flip. If the regression is genuinely ` +
          `intentional, retry with allowStatusRegression: true.`;
      } else if (v.code === 'terminal_parent_child_mutation') {
        payload.parentStatus = v.parentStatus;
        payload.changes = v.changes;
        payload.message = v.message;
      } else if (v.code === 'plan_status_change_requires_lifecycle_writer') {
        payload.currentStatus = v.currentStatus;
        payload.proposedStatus = v.proposedStatus;
        payload.writer = v.writer;
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        isError: true,
      };
    }

    // Cross-store invariant: an accepted prose write on an already-terminal
    // plan can still reconcile a stale started/paused row. Lifecycle changes
    // themselves are refused by the shared evaluator and use set-plan-status.
    if (isTerminalPlanStatus(parsePlan(args.content, { filePath: `${args.slug}.md` }).frontmatter.status)) {
      try {
        await clearStartedForTerminalPlan(result.scope.workspaceId, result.scope.harnessSlug, args.slug);
      } catch {
        /* recovered by reconcileStartStatus on the next plans:list read */
      }
    }

    const planItemDrift = await planItemTextDriftForWrite(
      ctx as ResolveIdentityCtx,
      args.slug,
      v.itemTextChanges,
      result.scope.harnessSlug,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: v.slug,
            contentHash: v.contentHash,
            ...(v.planDrainTransitionChanged ? { planDrainTransitionChanged: true } : {}),
            // Surfacing (EI-83 fix #2): present only when the write removed
            // items/decisions — so even an allowed shrink is visible.
            ...(v.warning ? { warning: v.warning } : {}),
            ...(v.nowStamped ? { nowStamped: true } : {}),
            version: result.version,
            filePath: result.filePath,
            // Item-parse feedback (WI-3363), computed in evaluateSetContent.
            ...v.parseFeedback,
            // The revision row appended for this write (D-003). `null`
            // when the best-effort append failed — the file write still
            // succeeded; the gap is recoverable via P-005's backfill.
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
            ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
            // WI-40825: open work-items minted from items this write rewrote or
            // removed. A whole-document write is the easiest way to reword an
            // item without noticing anyone is executing it.
            ...(planItemDrift ? { planItemDrift } : {}),
          }),
        },
      ],
    };
  },
});
