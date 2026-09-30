/**
 * THE POST-CLOSE SWEEP for declared completion claims — WI-2142447.
 *
 * `completion-claim-recheck.ts` owns the JUDGEMENT (what a transition means); this module
 * owns the PASS (which rows to look at, what to stamp, what to report). Split for the same
 * reason `dead-citation-sweep.ts` is split from its action: everything here is injected, so
 * the pass is testable with no database, no filesystem and no repo checkout.
 *
 * ── Why the sweep stamps the row instead of just reporting ──
 *
 * A report scrolls away. The durable surface is the `claim-since-falsified` audit bucket,
 * whose predicate reads the stamp this pass writes — see that bucket's paragraph in
 * `completion-audit.ts` for why the finding cannot be a SQL predicate over the live tree.
 * The improvement filed alongside is the NOTIFICATION, not the record.
 *
 * ── Fail-open, everywhere, on purpose ──
 *
 * A row whose persisted `claims` or `claimVerdicts` does not parse is SKIPPED and counted,
 * never guessed at. A claim the evaluator cannot decide today is `indeterminate` and never
 * a finding. The cost asymmetry is the one the claims module already states: a missed
 * falsity costs what we have today, while a fabricated one reds honest work and trains
 * readers to ignore the check.
 */
import { z } from 'zod';

import {
  CompletionClaimSchema,
  type ClaimSourceReader,
  type CompletionClaim,
} from './completion-claims';
import {
  CompletionClaimBaselineSchema,
  completionClaimRecheckRecord,
  recheckCompletionClaims,
  type CompletionClaimBaseline,
  type CompletionClaimRecheckRecord,
} from './completion-claim-recheck';

/** One candidate row, as read from the work-item payload. Values are RAW jsonb. */
export interface CompletionClaimRecheckCandidate {
  id: string;
  harnessSlug: string | null;
  title: string | null;
  /** `payload->'_completionEvidence'->'claims'` */
  claims: unknown;
  /** `payload->'_completionEvidence'->'claimVerdicts'` */
  baseline: unknown;
  /** `payload->'_completionClaimRecheck'->>'verdict'` from a PREVIOUS pass, if any. */
  priorVerdict: string | null;
}

export interface CompletionClaimRecheckSweepDeps {
  /** Terminal rows carrying declared claims, least-recently-rechecked first. */
  candidates: (limit: number) => Promise<CompletionClaimRecheckCandidate[]>;
  /** Reads repo-relative source for the current tree. */
  reader: ClaimSourceReader;
  /** Persist one row's recheck record. */
  stamp: (input: {
    id: string;
    harnessSlug: string | null;
    record: CompletionClaimRecheckRecord;
  }) => Promise<void>;
  now?: () => Date;
}

export interface CompletionClaimRecheckFinding {
  id: string;
  title: string | null;
  /** The regressed claims only — rendered, with the evaluator's reason for each. */
  claims: Array<{ claim: string; reason: string }>;
  /** True when a PREVIOUS pass had not already stamped this row `regressed`. */
  newlyRegressed: boolean;
}

export interface CompletionClaimRecheckSweepResult {
  scannedRows: number;
  claimsChecked: number;
  /** Rows carrying at least one `holds` → `falsified` transition. */
  regressed: CompletionClaimRecheckFinding[];
  /** Rows carrying a claim falsified now that nothing ever witnessed holding. */
  falsifiedUnbaselined: CompletionClaimRecheckFinding[];
  /** Rows whose persisted claims/baseline did not parse — skipped, never guessed at. */
  malformedRows: number;
  /** Rows carrying claims but NO close-time baseline (closed before baselines existed). */
  unbaselinedRows: number;
}

const ClaimsArraySchema = z.array(CompletionClaimSchema).max(50);

/** Default rows per pass. The population is small by construction; this only bounds a surprise. */
export const COMPLETION_CLAIM_RECHECK_ROW_LIMIT = 500;

function parseClaims(raw: unknown): readonly CompletionClaim[] | null {
  const parsed = ClaimsArraySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseBaseline(raw: unknown): { ok: true; baseline: CompletionClaimBaseline | null } | { ok: false } {
  // An ABSENT baseline is a legitimate state (a close written before baselines were
  // recorded), and materially different from a MALFORMED one. Absent yields null and every
  // claim classifies `falsified-unbaselined`/`indeterminate`; malformed skips the row.
  if (raw === null || raw === undefined) return { ok: true, baseline: null };
  const parsed = CompletionClaimBaselineSchema.safeParse(raw);
  return parsed.success ? { ok: true, baseline: parsed.data } : { ok: false };
}

export async function runCompletionClaimRecheckSweep(
  deps: CompletionClaimRecheckSweepDeps,
  limit: number = COMPLETION_CLAIM_RECHECK_ROW_LIMIT,
): Promise<CompletionClaimRecheckSweepResult> {
  const now = deps.now ?? (() => new Date());
  const rows = await deps.candidates(limit);

  const result: CompletionClaimRecheckSweepResult = {
    scannedRows: 0,
    claimsChecked: 0,
    regressed: [],
    falsifiedUnbaselined: [],
    malformedRows: 0,
    unbaselinedRows: 0,
  };

  for (const row of rows) {
    const claims = parseClaims(row.claims);
    const baseline = parseBaseline(row.baseline);
    if (!claims || claims.length === 0 || !baseline.ok) {
      result.malformedRows += 1;
      continue;
    }
    if (!baseline.baseline) result.unbaselinedRows += 1;

    const report = recheckCompletionClaims({
      claims,
      baseline: baseline.baseline,
      reader: deps.reader,
    });
    result.scannedRows += 1;
    result.claimsChecked += report.entries.length;

    const record = completionClaimRecheckRecord({
      report,
      at: now().toISOString(),
      baselinePresent: Boolean(baseline.baseline),
    });
    await deps.stamp({ id: row.id, harnessSlug: row.harnessSlug, record });

    if (report.regressed > 0) {
      result.regressed.push({
        id: row.id,
        title: row.title,
        claims: report.entries
          .filter((e) => e.status === 'regressed')
          .map((e) => ({ claim: JSON.stringify(e.claim), reason: e.reason })),
        newlyRegressed: row.priorVerdict !== 'regressed',
      });
    }
    if (report.falsifiedUnbaselined > 0) {
      result.falsifiedUnbaselined.push({
        id: row.id,
        title: row.title,
        claims: report.entries
          .filter((e) => e.status === 'falsified-unbaselined')
          .map((e) => ({ claim: JSON.stringify(e.claim), reason: e.reason })),
        newlyRegressed: false,
      });
    }
  }

  return result;
}

/**
 * Render the sweep as an improvement body. EVIDENCE, never a verdict on the work-item — a
 * regressed claim says the close's stated fact is no longer true, which may mean the close
 * was superseded by a deliberate later change rather than that it was ever wrong.
 */
export function renderCompletionClaimRecheckBody(result: CompletionClaimRecheckSweepResult): string {
  const lines: string[] = [];
  lines.push(
    `${result.regressed.length} closed work-item(s) carry a declared completion claim that HELD ` +
      `when the close was written and is FALSIFIED against the current tree.`,
    '',
    'A declared claim is a machine-checkable assertion the closer made about the source ' +
      '(`verification.claims`). It was re-evaluated at close time and held. It does not hold now.',
    '',
    '⚠ THIS IS EVIDENCE, NOT A VERDICT ON THE CLOSE. A claim can go false because the close was ' +
      'wrong, or because later work deliberately changed what it described. Both need a reader; ' +
      'only the first needs a fix. The value of the finding is that nobody was told at all before.',
    '',
  );

  for (const finding of result.regressed) {
    lines.push(`- **${finding.id}**${finding.newlyRegressed ? ' (new this pass)' : ''} — ${finding.title ?? '(untitled)'}`);
    for (const c of finding.claims) lines.push(`    - \`${c.claim}\` → ${c.reason}`);
  }

  if (result.falsifiedUnbaselined.length > 0) {
    lines.push(
      '',
      `Separately, ${result.falsifiedUnbaselined.length} row(s) carry a claim that is falsified now ` +
        'but was never witnessed holding (unevaluatable at close, or closed before close-time ' +
        'verdicts were recorded). Deliberately NOT counted as a regression — nothing establishes ' +
        'a transition — but listed because absence of judgement is never judged-clean:',
    );
    for (const finding of result.falsifiedUnbaselined) {
      lines.push(`- ${finding.id} — ${finding.title ?? '(untitled)'}`);
      for (const c of finding.claims) lines.push(`    - \`${c.claim}\` → ${c.reason}`);
    }
  }

  lines.push(
    '',
    `Scanned ${result.scannedRows} row(s) / ${result.claimsChecked} claim(s); ` +
      `${result.unbaselinedRows} carried no close-time baseline; ${result.malformedRows} row(s) ` +
      'were skipped because their persisted claims did not parse.',
    '',
    'Filed by the completion-claim-recheck system action and re-evaluated on its next scheduled ' +
      'run. The durable surface is `work_items:list { audit: "claim-since-falsified" }`.',
  );
  return lines.join('\n');
}

export function completionClaimRecheckWatchdogKey(harnessSlug: string): string {
  return `completion-claim-recheck:${harnessSlug}`;
}
