/**
 * RE-CHECKING DECLARED COMPLETION CLAIMS AFTER THE CLOSE — WI-2142447, the deferred half
 * of EI-22175397357614106.
 *
 * ── What already exists, and the exact gap ──
 *
 * `completion-claims.ts` re-evaluates a close's declared `verification.claims` against the
 * source AT CLOSE TIME: a claim that is false when written produces the `claimsFalsified`
 * finding, downgrades the close to `proposed`, and is named back to the closer. That is an
 * HONESTY check, and it runs exactly once.
 *
 * A claim that was TRUE when the close was written then goes false as the code moves
 * underneath it, and nothing notices. That is a STALENESS check, and it is the half that
 * protects the downstream consumer — the reader who finds the close weeks later and acts
 * on it. The source item is its own measured example, running in the opposite direction:
 * EI-22175397357614106 was filed asserting `coord:dispatch` was absent from
 * `CORE_MCP_TOOL_NAMES`; that was true when filed and FALSE 69 minutes later. A 69-minute
 * half-life on a load-bearing claim about a named array is this tree's measured drift rate.
 *
 * ── Why this module needs a persisted BASELINE, and why that is not optional ──
 *
 * The finding is a TRANSITION — `holds` then, `falsified` now — not a verdict. Nothing
 * about the current tree can distinguish those two claims:
 *
 *   (a) a claim that held at close and has since gone false      ← the finding
 *   (b) a claim that was ALREADY false at close, was reported as such, and already cost
 *       the close its `committed` grade                          ← old news, already acted on
 *
 * Re-filing (b) as "went stale" would attribute a known, already-graded defect to a drift
 * that never happened. So the close-time verdicts are recorded at the moment they are
 * COMPUTED — an observation — rather than re-derived later from the close's tree stamp,
 * which would be an inference that fails silently whenever the sha is unreachable. This is
 * the derived-truth ladder's first rung applied to a verdict: prefer the observation.
 *
 * Coverage is deliberately forward-only. Measured 2026-09-02 before this landed: of 46,020
 * terminal rows (19,639 carrying completion evidence), **0** carried declared claims — the
 * claims feature was ~40 minutes old. There is no historical population to strand and
 * nothing to backfill.
 *
 * ── Trap 1: only `holds` → `falsified` is a finding ──
 *
 * `unevaluatable` is never a falsification, in either position:
 *
 *  - `unevaluatable` NOW (file renamed, moved, deleted, container restructured, spread
 *    element introduced) is absence of judgement, and absence of judgement is never
 *    judged-clean and never judged-false. Getting this backwards would make the sweep fire
 *    hardest on healthy, actively-refactored code — the loudest possible false positive.
 *  - `unevaluatable` THEN cannot witness that a claim ever held, so a claim that is
 *    falsified now but was unjudgeable at close is NOT a regression. It is real
 *    information — the close-time check missed something now decidable — so it is kept as
 *    its own {@link CompletionClaimRecheckStatus} (`falsified-unbaselined`) and counted
 *    separately, never folded into the regression count that drives the audit bucket. It
 *    is recorded rather than discarded precisely because an incomplete enumeration reads
 *    exactly like a passing guard.
 *
 * ── Trap 2: never re-check by re-reading the close's prose ──
 *
 * Claims are declared in structured form so that no natural-language parsing is involved
 * at any point in their lifecycle. `doc-claims/executable-claims.ts` measured what mining
 * membership assertions out of this repo's English costs: wrong in BOTH directions, and
 * SILENTLY — a detector that understands nothing reports "clean", not "unsupported". This
 * module re-evaluates the same structured objects the close declared, through the same
 * evaluator, and reads no prose at all.
 *
 * ── Status is about the TRANSITION, not the current verdict ──
 *
 * Every entry carries `baselineVerdict` and `currentVerdict` alongside its `status`, so a
 * status of `indeterminate` never means "we know nothing" — it means "nothing can be said
 * about the TRANSITION", which is a different and much narrower claim.
 */
import { z } from 'zod';

import {
  CompletionClaimSchema,
  evaluateCompletionClaim,
  type ClaimSourceReader,
  type CompletionClaim,
  type CompletionClaimVerdict,
  type CompletionClaimsReport,
} from './completion-claims';

/**
 * Payload key for the POST-CLOSE recheck observation.
 *
 * Deliberately a SIBLING of `_completionEvidence`, never a field inside it. That object is
 * the close's own record — the thing completion authority is computed from — and a sweep
 * running weeks later writing into it would make the close's evidence surface mutable
 * after the fact. The baseline ({@link CompletionClaimBaseline}) belongs inside, because it
 * is computed AT the close and describes it; this record is a later observation ABOUT the
 * close and belongs beside it.
 */
export const COMPLETION_CLAIM_RECHECK_KEY = '_completionClaimRecheck';

/** One close-time verdict, kept beside the claim it judged. */
export const CompletionClaimBaselineEntrySchema = z.object({
  claim: CompletionClaimSchema,
  verdict: z.enum(['holds', 'falsified', 'unevaluatable']),
  reason: z.string(),
});

/**
 * The close-time verdicts, persisted on `_completionEvidence` beside the `claims` they
 * judge. Server-computed and narrative-side: it describes the close and must never
 * participate in completion-authority calculation.
 */
export const CompletionClaimBaselineSchema = z.object({
  /** ISO timestamp of the close that produced these verdicts. */
  at: z.string().min(1),
  entries: z.array(CompletionClaimBaselineEntrySchema).max(50),
});

export type CompletionClaimBaselineEntry = z.infer<typeof CompletionClaimBaselineEntrySchema>;
export type CompletionClaimBaseline = z.infer<typeof CompletionClaimBaselineSchema>;

/**
 * What happened to one claim BETWEEN the close and now. This describes the TRANSITION; the
 * entry's `baselineVerdict`/`currentVerdict` describe the endpoints.
 *
 *  - `held`                  — held at close, still holds.
 *  - `regressed`             — held at close, FALSIFIED now. The only finding.
 *  - `still-false`           — false at close and still false: already reported and already
 *                              graded at close time, so re-filing it would be duplicate noise.
 *  - `repaired`              — false at close, holds now.
 *  - `falsified-unbaselined` — falsified now, with no baseline verdict that could witness it
 *                              ever holding (unevaluatable at close, or closed before
 *                              baselines were recorded). Real, but not a regression.
 *  - `indeterminate`         — nothing can be said about the transition, overwhelmingly
 *                              because the claim is `unevaluatable` NOW.
 */
export type CompletionClaimRecheckStatus =
  | 'held'
  | 'regressed'
  | 'still-false'
  | 'repaired'
  | 'falsified-unbaselined'
  | 'indeterminate';

/** The SQL-decidable summary verdict the audit bucket selects on. */
export type CompletionClaimRecheckVerdict = 'clean' | 'regressed';

/**
 * The one stamped value the `claim-since-falsified` audit predicate matches. Declared here,
 * in the module that WRITES it, and imported by `completion-audit.ts` rather than re-typed
 * as a bare string there — the same write-and-read-cannot-drift discipline
 * `TERMINAL_COMPLETION_EVIDENCE_KEY` exists for, and for the same reason: a predicate keyed
 * on a value nothing writes returns zero rows forever, with no error.
 */
export const COMPLETION_CLAIM_RECHECK_REGRESSED: CompletionClaimRecheckVerdict = 'regressed';

export interface CompletionClaimRecheckEntry {
  claim: CompletionClaim;
  /** The close-time verdict, or null when this claim had no baseline entry. */
  baselineVerdict: CompletionClaimVerdict | null;
  currentVerdict: CompletionClaimVerdict;
  status: CompletionClaimRecheckStatus;
  /** Why the CURRENT verdict was reached. */
  reason: string;
  /** Why the BASELINE verdict was reached, when there was one. */
  baselineReason?: string;
}

export interface CompletionClaimRecheckReport {
  entries: CompletionClaimRecheckEntry[];
  /** `holds` → `falsified`. THE finding. */
  regressed: number;
  /** Falsified now, never witnessed holding. Real, but never a regression. */
  falsifiedUnbaselined: number;
  held: number;
  stillFalse: number;
  repaired: number;
  indeterminate: number;
  anyRegressed: boolean;
  /** `regressed` iff at least one claim regressed — never widened to any other status. */
  verdict: CompletionClaimRecheckVerdict;
}

/**
 * A stable identity for a claim, used to pair a persisted baseline entry with the claim it
 * judged. Built from JSON-encoded FIELDS in a fixed per-kind order rather than
 * `JSON.stringify(claim)`, for two reasons: key order in a round-tripped JSON object is not
 * something this pairing may depend on, and encoding each field individually means a
 * separator character occurring inside a path or value cannot forge a different claim's key.
 *
 * Two claims with the same key are the same assertion and necessarily evaluate the same
 * way, so a duplicate is harmless.
 */
export function completionClaimKey(claim: CompletionClaim): string {
  const join = (...parts: string[]): string => parts.map((p) => JSON.stringify(p)).join(',');
  switch (claim.kind) {
    case 'string-in-array':
      return join('string-in-array', claim.path, claim.container, claim.value, claim.expect);
    case 'symbol-defined':
      return join(
        'symbol-defined',
        claim.path,
        claim.symbol,
        claim.expect,
        claim.exported === true ? 'exported' : 'any',
      );
    default: {
      // A kind with no key arm must still produce a STABLE, DISTINCT key rather than
      // collapsing every unknown claim onto one identity, which would silently pair
      // unrelated baselines with each other.
      const unknown = claim as Record<string, unknown>;
      return join(
        'unknown',
        ...Object.keys(unknown)
          .sort()
          .map((k) => `${k}=${String(unknown[k])}`),
      );
    }
  }
}

/** Build the close-time baseline from the verdicts the close already computed. */
export function completionClaimBaseline(
  report: CompletionClaimsReport,
  at: string,
): CompletionClaimBaseline | undefined {
  if (report.results.length === 0) return undefined;
  return {
    at,
    entries: report.results.slice(0, 50).map((r) => ({
      claim: r.claim,
      verdict: r.verdict,
      reason: r.reason,
    })),
  };
}

/**
 * Classify ONE claim's transition. Exported so the table above is testable directly rather
 * than only through a reader — the classification is the whole of this module's judgement.
 */
export function classifyClaimRecheck(
  baselineVerdict: CompletionClaimVerdict | null,
  currentVerdict: CompletionClaimVerdict,
): CompletionClaimRecheckStatus {
  // Trap 1, first half: `unevaluatable` NOW says nothing, whatever the baseline said. This
  // arm comes first precisely so no later arm can accidentally read it as a falsification.
  if (currentVerdict === 'unevaluatable') return 'indeterminate';

  if (baselineVerdict === 'holds') {
    return currentVerdict === 'falsified' ? 'regressed' : 'held';
  }
  if (baselineVerdict === 'falsified') {
    return currentVerdict === 'falsified' ? 'still-false' : 'repaired';
  }
  // Trap 1, second half: baseline is `unevaluatable` or absent, so nothing witnessed this
  // claim ever holding. A falsification here is real information but NEVER a regression.
  return currentVerdict === 'falsified' ? 'falsified-unbaselined' : 'indeterminate';
}

/**
 * Re-evaluate a close's declared claims against the CURRENT source and classify each
 * against its close-time verdict.
 *
 * Fail-open in every uncertain direction, inherited from the evaluator: an unreadable
 * source, a renamed container or an unresolved spread yields `unevaluatable`, which this
 * module maps to `indeterminate` and never to a finding.
 */
export function recheckCompletionClaims(input: {
  claims: readonly CompletionClaim[] | null | undefined;
  baseline: CompletionClaimBaseline | null | undefined;
  reader: ClaimSourceReader;
}): CompletionClaimRecheckReport {
  const byKey = new Map<string, CompletionClaimBaselineEntry>();
  for (const entry of input.baseline?.entries ?? []) {
    byKey.set(completionClaimKey(entry.claim), entry);
  }

  const entries: CompletionClaimRecheckEntry[] = (input.claims ?? []).map((claim) => {
    const current = evaluateCompletionClaim(claim, input.reader);
    const prior = byKey.get(completionClaimKey(claim));
    const baselineVerdict = prior?.verdict ?? null;
    return {
      claim,
      baselineVerdict,
      currentVerdict: current.verdict,
      status: classifyClaimRecheck(baselineVerdict, current.verdict),
      reason: current.reason,
      ...(prior ? { baselineReason: prior.reason } : {}),
    };
  });

  const count = (status: CompletionClaimRecheckStatus): number =>
    entries.filter((e) => e.status === status).length;
  const regressed = count('regressed');
  return {
    entries,
    regressed,
    falsifiedUnbaselined: count('falsified-unbaselined'),
    held: count('held'),
    stillFalse: count('still-false'),
    repaired: count('repaired'),
    indeterminate: count('indeterminate'),
    anyRegressed: regressed > 0,
    verdict: regressed > 0 ? 'regressed' : 'clean',
  };
}

/** The row-persisted form of a recheck — one entry per claim, claims rendered for reading. */
export const CompletionClaimRecheckRecordSchema = z.object({
  /** ISO timestamp of the sweep that produced this record. */
  at: z.string().min(1),
  verdict: z.enum(['clean', 'regressed']),
  regressed: z.number().int().nonnegative(),
  falsifiedUnbaselined: z.number().int().nonnegative(),
  claimsChecked: z.number().int().nonnegative(),
  /** True when this close carried no baseline at all — every entry is unbaselined. */
  baselineMissing: z.boolean(),
  entries: z
    .array(
      z.object({
        claim: z.string(),
        status: z.enum([
          'held',
          'regressed',
          'still-false',
          'repaired',
          'falsified-unbaselined',
          'indeterminate',
        ]),
        baselineVerdict: z.enum(['holds', 'falsified', 'unevaluatable']).nullable(),
        currentVerdict: z.enum(['holds', 'falsified', 'unevaluatable']),
        reason: z.string(),
      }),
    )
    .max(50),
});

export type CompletionClaimRecheckRecord = z.infer<typeof CompletionClaimRecheckRecordSchema>;

export function completionClaimRecheckRecord(input: {
  report: CompletionClaimRecheckReport;
  at: string;
  baselinePresent: boolean;
}): CompletionClaimRecheckRecord {
  return {
    at: input.at,
    verdict: input.report.verdict,
    regressed: input.report.regressed,
    falsifiedUnbaselined: input.report.falsifiedUnbaselined,
    claimsChecked: input.report.entries.length,
    baselineMissing: !input.baselinePresent,
    entries: input.report.entries.slice(0, 50).map((e) => ({
      claim: JSON.stringify(e.claim),
      status: e.status,
      baselineVerdict: e.baselineVerdict,
      currentVerdict: e.currentVerdict,
      reason: e.reason,
    })),
  };
}

/** One line per claim, for an improvement body or an audit read. */
export function renderCompletionClaimRecheck(report: CompletionClaimRecheckReport): string {
  if (report.entries.length === 0) return 'no declared claims';
  const glyph: Record<CompletionClaimRecheckStatus, string> = {
    held: '✓',
    regressed: '✗',
    'still-false': '·',
    repaired: '↺',
    'falsified-unbaselined': '!',
    indeterminate: '?',
  };
  return report.entries
    .map(
      (e) =>
        `${glyph[e.status]} ${e.status.toUpperCase()} (${e.baselineVerdict ?? 'no-baseline'} → ` +
        `${e.currentVerdict}): ${e.reason}`,
    )
    .join('\n');
}
