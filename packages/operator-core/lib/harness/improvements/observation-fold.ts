/**
 * observation-fold.ts — the HARD/SOFT decider for FOLD-IN-PLACE of AGENT-filed
 * observations that carry no explicit `conditionKey`
 * (learning-loop-identity-and-consumption-2026-08-08 P-013/P-014, owner D-042).
 *
 * WHAT THIS IS FOR. `improvements:capture` folds a repeat reading onto its
 * standing row when the caller supplies a stable `watchdogKey` (capture-core.ts,
 * EI-15448). That path measurably works — 5,491 keyed agent observations over
 * 4,718 distinct keys in 7 days, i.e. 1.16 rows/key. The gap D-042 authorises us
 * to close is the ~1,583/day agent filings that carry NO key and therefore skip
 * dedup entirely, minting a fresh row every time. This module supplies the
 * DERIVED identity those filings lack.
 *
 * ⛔ IT NEVER REJECTS. D-003's blocking half is explicitly unweakened by D-042:
 * no agent filing may ever be refused. Every verdict here chooses only WHERE the
 * content lands — folded onto a survivor, or minted with a link — never whether
 * the call succeeds. There is deliberately no 'reject' variant of FoldVerdict,
 * so a future edit cannot add rejection here without changing this type.
 *
 * ── WHY NOT A PLAIN COSINE CUT ──────────────────────────────────────────────
 * Because it cannot work on this corpus, and that is MEASURED, not assumed.
 * `semantic-dupe-guard.ts` calibrated 200 agent-filed rows on 2026-08-12
 * (WI-38056): six KNOWN duplicate pairs score cosine 0.861–0.892 while four
 * known-DISTINCT pairs score 0.857–0.868. The ranges OVERLAP — a distinct pair
 * at 0.8677 outscores a real duplicate at 0.8613 — so no pure-cosine threshold
 * separates them at any cut. That file's own HARD=0.93 "has never refused a real
 * duplicate", and it explicitly forbids lowering it into the 0.86–0.89 overlap.
 *
 * So the HARD (fold) predicate is that file's already-calibrated CO-SIGNAL:
 * cosine >= 0.86 AND pg_trgm title similarity >= 0.45. On the same population it
 * fires on 14/200 = 7% of filings, catches 4 of the 6 known duplicate pairs, and
 * fires on NONE of the four known-distinct pairs.
 *
 * ── THE OVER-MERGE TRAP (D-036), AND THE DISCRIMINATOR ──────────────────────
 * D-036 on the same plan established that embedding distance in this corpus "is
 * dominated by the shared TEMPLATE and blind to the discriminating subject".
 * That is fatal to the co-signal used alone: two TEMPLATED filings —
 *   "Test failing repeatedly: packages/a/foo.test.ts"
 *   "Test failing repeatedly: packages/b/bar.test.ts"
 * — clear BOTH co-signal legs comfortably and are DIFFERENT problems. Folding
 * them is the silent failure D-042 orders us to engineer against: the second
 * problem is never seen again.
 *
 * The guard makes the model see what the embedding is blind to. We extract
 * SUBJECT tokens — the high-salience identifiers that name what a filing is
 * ABOUT (file paths, work-item ids, dotted symbols, backticked/quoted literals)
 * — and demote HARD → SOFT when both sides name subjects and those sets are
 * DISJOINT. Both rows then survive, linked.
 *
 * ⚠ BARE NUMBERS ARE DELIBERATELY NOT SUBJECT TOKENS, and this is load-bearing,
 * not an oversight. P-002 established that live measurements must be normalized
 * OUT of the identity: "fires on 92/92 ticks" and "fires on 96/96 ticks" are the
 * SAME standing condition, and that re-filing shape is the plan's founding
 * evidence. Treating those digits as discriminators would demote exactly the
 * pairs this whole plan exists to fold. Numbers are stripped before comparison.
 *
 * Pure functions only — no PG, no embedder, no clock. The caller supplies
 * candidates; this decides. That is what makes the labelled-sample calibration
 * in observation-fold.test.ts able to publish a precision figure at all.
 */

/**
 * The three dispositions. Note what is absent: there is no 'reject'. D-003's
 * no-rejection half is enforced by this type, not by a comment.
 *  - 'hard' → FOLD onto the candidate (repeatCount bump, reporter, evidence).
 *  - 'soft' → MINT a new row, but LINK it to the candidate. Both survive.
 *  - 'none' → MINT cleanly; nothing similar enough to relate.
 */
export type FoldVerdict = 'hard' | 'soft' | 'none';

export interface FoldCandidate {
  id: string;
  title: string;
  /** Cosine similarity (1 − pgvector distance), 0..1. */
  similarity: number;
  /** pg_trgm `similarity()` between the incoming title and this one, 0..1.
   *  Undefined when the caller's query seam did not score it — the co-signal
   *  then cannot apply (fail-open to SOFT at most, never to a silent fold). */
  titleSimilarity?: number;
}

export interface DiscriminatorReport {
  /** Subject tokens found in the incoming title. */
  incoming: string[];
  /** Subject tokens found in the candidate's title. */
  candidate: string[];
  /** True when BOTH sides named subjects and the sets share nothing. */
  disjoint: boolean;
  /** True when this report actually changed the verdict (HARD → SOFT). */
  demoted: boolean;
}

export interface FoldClassification {
  verdict: FoldVerdict;
  /** The row this filing relates to; null only when verdict is 'none'. */
  candidate: FoldCandidate | null;
  /** Which rule produced the verdict — carried into the capture response so a
   *  filing agent (and an auditor) can see WHY, not just WHAT. */
  rule: 'co-signal' | 'pure-cosine' | 'soft-band' | 'discriminator-demoted' | 'none';
  discriminator?: DiscriminatorReport;
  /** Plain-language explanation for a reader who will not interpret the fields. */
  note: string;
}

/** Calibrated on this corpus — see the header. Env-tunable for a re-calibration,
 *  never for taste; a change here MUST be re-measured against a labelled sample. */
export const FOLD_CO_SIGNAL_MIN_COSINE = 0.86;
export const FOLD_CO_SIGNAL_MIN_TITLE = 0.45;
/** Inherited from semantic-dupe-guard's DEFAULT_HARD. Nearly inert as a fold
 *  trigger (no known duplicate reaches it) but harmless and defensible. */
export const FOLD_PURE_COSINE_MIN = 0.93;
/** Inherited from semantic-dupe-guard's DEFAULT_SOFT: "unusually similar for
 *  this corpus" (fires ~21%). Links only — never folds. */
export const FOLD_SOFT_MIN = 0.9;

function envThreshold(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : dflt;
}

export function foldThresholds(): {
  coSignalCosine: number;
  coSignalTitle: number;
  pureCosine: number;
  soft: number;
} {
  return {
    coSignalCosine: envThreshold(process.env.PAPERCUSP_OBS_FOLD_COSIGNAL_COSINE, FOLD_CO_SIGNAL_MIN_COSINE),
    coSignalTitle: envThreshold(process.env.PAPERCUSP_OBS_FOLD_COSIGNAL_TITLE, FOLD_CO_SIGNAL_MIN_TITLE),
    pureCosine: envThreshold(process.env.PAPERCUSP_OBS_FOLD_PURE_COSINE, FOLD_PURE_COSINE_MIN),
    soft: envThreshold(process.env.PAPERCUSP_OBS_FOLD_SOFT, FOLD_SOFT_MIN),
  };
}

/**
 * Extract SUBJECT tokens: the identifiers that name what a filing is about.
 *
 * Deliberately NARROW. A token qualifies only if it is structurally an
 * identifier — not an ordinary English word — because the whole point is to find
 * signal the embedding is blind to. Ordinary prose is already what the cosine
 * scored; re-counting it here would just re-express the same measurement.
 *
 * Included: slash paths (`packages/a/foo.ts`), file names with a known code
 * extension, work-item / plan ids (WI-123, EI-456, F-7, P-001, D-042), dotted
 * symbols (`foo.barBaz`), and backticked or double-quoted literals.
 *
 * EXCLUDED, on purpose: bare numbers, percentages and ratios. See the header —
 * P-002 requires live measurements to be normalized OUT of identity, so digits
 * must never discriminate. `92/92` and `96/96` are the same condition.
 */
export function subjectTokens(title: string): string[] {
  if (!title) return [];
  const found = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const t = raw.trim().toLowerCase().replace(/[),.;:]+$/, '');
    // A token made only of digits/punctuation carries no subject — and per P-002
    // must not, or a changing measurement would read as a different subject.
    if (!t || !/[a-z]/.test(t)) return;
    if (t.length < 3) return;
    found.add(t);
  };

  // Families are harvested MOST-SPECIFIC FIRST, and each one BLANKS the spans it
  // consumed so a later, looser family cannot re-match inside them.
  //
  // This masking is load-bearing, not tidiness. Without it the dotted-symbol
  // pattern matches `test.ts` INSIDE two different paths
  // (`.../decay.test.ts` and `.../triage.test.ts`), both sides yield the shared
  // token `test.ts`, the sets intersect, and the guard concludes the subjects
  // AGREE — silently folding two unrelated failing tests together. That is the
  // exact D-036 over-merge this module exists to prevent, so it is covered by a
  // dedicated test rather than left to inspection.
  let scratch = title;
  const harvest = (re: RegExp, group = 0): void => {
    for (const m of [...scratch.matchAll(re)]) add(m[group] ?? m[0]);
    scratch = scratch.replace(re, (s) => ' '.repeat(s.length));
  };

  // Backticked and double-quoted literals: the author explicitly marked these.
  harvest(/`([^`]+)`/g, 1);
  harvest(/"([^"]+)"/g, 1);
  // Work-item / plan / decision ids.
  harvest(/\b(?:WI|EI|F|P|D)-\d+\b/gi);
  // Slash paths (two or more segments) — consumed BEFORE file names and dotted
  // symbols, which would otherwise carve generic fragments out of them.
  harvest(/\b[\w@.-]+(?:\/[\w@.-]+)+\b/g);
  // Standalone file names carrying a code/data extension.
  harvest(/\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|md|mdx|json|ya?ml|sh|rs|py|toml)\b/gi);
  // Dotted symbols (foo.barBaz) not already consumed above.
  harvest(/\b[a-z_]\w*(?:\.[a-z_]\w*)+\b/gi);

  return [...found].sort();
}

/**
 * The D-036 guard. Returns a report; the caller decides what to do with it.
 *
 * Disjoint only counts when BOTH sides actually name a subject. If either side
 * names none, we have learned nothing and must not demote on ignorance — that
 * would silently convert the common untemplated case into permanent non-folding
 * and quietly restore the row growth this exists to bend.
 */
export function discriminate(incomingTitle: string, candidateTitle: string): DiscriminatorReport {
  const incoming = subjectTokens(incomingTitle);
  const candidate = subjectTokens(candidateTitle);
  const bothNameSubjects = incoming.length > 0 && candidate.length > 0;
  const shares = bothNameSubjects && incoming.some((t) => candidate.includes(t));
  return {
    incoming,
    candidate,
    disjoint: bothNameSubjects && !shares,
    demoted: false,
  };
}

const NONE: FoldClassification = {
  verdict: 'none',
  candidate: null,
  rule: 'none',
  note: 'No sufficiently similar open observation — filed as a new row.',
};

/**
 * Classify one incoming observation against already-retrieved candidates.
 *
 * Candidates are expected to be same-lane, same-scope, still-OPEN observation
 * rows. This function does no filtering of its own beyond similarity: scope and
 * lifecycle are the caller's job, because getting them wrong is a correctness
 * bug that belongs next to the query, not buried in a scorer.
 */
export function classifyObservationFold(
  incomingTitle: string,
  candidates: readonly FoldCandidate[],
  thresholds = foldThresholds(),
): FoldClassification {
  if (!candidates.length) return NONE;

  // Strongest first, so a HARD match is never shadowed by a nearer-but-weaker one.
  const ranked = [...candidates].sort((a, b) => b.similarity - a.similarity);

  let bestSoft: FoldCandidate | null = null;
  let demotedReport: DiscriminatorReport | null = null;
  let demotedCandidate: FoldCandidate | null = null;

  for (const c of ranked) {
    const coSignal =
      c.similarity >= thresholds.coSignalCosine &&
      typeof c.titleSimilarity === 'number' &&
      c.titleSimilarity >= thresholds.coSignalTitle;
    const pure = c.similarity >= thresholds.pureCosine;

    if (coSignal || pure) {
      const report = discriminate(incomingTitle, c.title);
      if (report.disjoint) {
        // D-036: shared template, different subject. Demote — do NOT fold.
        // Keep looking: a later candidate may be a genuine same-subject match.
        if (!demotedReport) {
          demotedReport = { ...report, demoted: true };
          demotedCandidate = c;
        }
        if (!bestSoft) bestSoft = c;
        continue;
      }
      return {
        verdict: 'hard',
        candidate: c,
        rule: coSignal ? 'co-signal' : 'pure-cosine',
        discriminator: report,
        note:
          `Folded onto ${c.id}: cosine ${c.similarity.toFixed(3)}` +
          (typeof c.titleSimilarity === 'number' ? `, title similarity ${c.titleSimilarity.toFixed(3)}` : '') +
          (report.incoming.length && report.candidate.length
            ? ` — subject tokens agree (${report.incoming.filter((t) => report.candidate.includes(t)).join(', ')})`
            : ' — neither title names a distinguishing subject') +
          '.',
      };
    }

    if (!bestSoft && c.similarity >= thresholds.soft) bestSoft = c;
  }

  if (demotedReport && demotedCandidate) {
    return {
      verdict: 'soft',
      candidate: demotedCandidate,
      rule: 'discriminator-demoted',
      discriminator: demotedReport,
      note:
        `NOT folded onto ${demotedCandidate.id} despite high similarity ` +
        `(cosine ${demotedCandidate.similarity.toFixed(3)}): the two titles name DIFFERENT subjects ` +
        `(${demotedReport.incoming.join(', ')} vs ${demotedReport.candidate.join(', ')}). ` +
        'Filed as its own row and linked — this is the D-036 template trap, where similarity ' +
        'reflects a shared wording template rather than a shared problem.',
    };
  }

  if (bestSoft) {
    return {
      verdict: 'soft',
      candidate: bestSoft,
      rule: 'soft-band',
      note:
        `Filed as a new row and linked to ${bestSoft.id} (cosine ${bestSoft.similarity.toFixed(3)}): ` +
        'unusually similar for this corpus, but below the fold threshold. Both rows survive.',
    };
  }

  return NONE;
}
