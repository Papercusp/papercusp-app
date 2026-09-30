/**
 * pr-host/pr-review-report-types — the structured review report the
 * agent-reviewer (PR-2) emits, plus the PURE logic that keeps it
 * honest.
 *
 * Types-only and PURE. No Octokit, no PG, no I/O. The reviewer
 * (`./agent-reviewer.ts`) calls these to turn an LLM's free-form
 * structured output into a validated, safety-guarded `PrReviewReport`;
 * the store (`./pr-review-report-store.ts`) persists it; the poll
 * daemon (PR-1) reads `recommendation` via `reportGatesAutoApprove`;
 * the report GUI (PR-3) renders the whole shape.
 *
 * Tenth module in the dogfood-arc types-only spine. Same one-per-
 * design-anchor pattern as:
 *   - apps/operator/lib/pr-host/types.ts                          (P-040)
 *   - apps/operator/lib/pr-host/auto-review-decision-types.ts     (P-044/045)
 *   - apps/operator/lib/pr-host/harness-feature-pr-row-types.ts   (P-042)
 *
 * Source: PLAN-pr-system-completion-dogfood (Phase PR-2). The owner's
 * "human OR agent review" model: the agent PRODUCES a recommendation;
 * the gate + owner mode decide whether it's applied. This module is
 * the agent's half — and the no-rubber-stamp discipline (Brief-G
 * honesty): a defective PR is NEVER recommended for approval, enforced
 * deterministically here regardless of what the LLM says.
 */

import {
  type Pr,
  type PrChecksState,
  type PrMergeableState,
} from './types';

/**
 * What the agent recommends the owner do with the PR.
 *
 * `approve`          — the change is sound; safe to approve (and, in
 *                      AUTO mode + checks-green + trusted-author, merge).
 * `request_changes`  — the change needs work before it lands.
 * `reject`           — the change should not land (out-of-scope,
 *                      dangerous, or fundamentally wrong).
 *
 * NB: this is ADVISORY. The agent never posts a GitHub review — it
 * only emits this recommendation into a report. `decideAutoReview`
 * (the gate) + the owner's per-hive mode decide whether it's applied.
 */
export const PR_REVIEW_RECOMMENDATIONS = ['approve', 'request_changes', 'reject'] as const;
export type PrReviewRecommendation = (typeof PR_REVIEW_RECOMMENDATIONS)[number];

/**
 * Severity ordering for recommendations. The safety guard takes the
 * MAX of the LLM's recommendation and the deterministic floor — it can
 * only make a recommendation more conservative, never less. So a clean
 * PR keeps the LLM's `approve`, but a defective one is forced off it.
 */
const SEVERITY: Record<PrReviewRecommendation, number> = {
  approve: 0,
  request_changes: 1,
  reject: 2,
};

function severityOf(rec: PrReviewRecommendation): number {
  return SEVERITY[rec];
}

function recForSeverity(n: number): PrReviewRecommendation {
  if (n >= 2) return 'reject';
  if (n === 1) return 'request_changes';
  return 'approve';
}

/**
 * The mechanical observations the reviewer made about the PR — the
 * deterministic facts, NOT the LLM's opinion. Stored alongside the
 * report so the owner (PR-3 GUI) and the audit can see WHAT was
 * observed, and so the safety guard is reproducible.
 *
 * Every field here is derived from the PR + its diff by pure code —
 * the LLM is never trusted for CI state or secret-presence (it would
 * be easy to talk it past a red build). That separation is the
 * honesty discipline: the summary/rationale are the model's judgment;
 * checksObserved are facts.
 */
export interface PrReviewChecksObserved {
  /** CI summary state at review time (from the PR / check cache). */
  checks_state: PrChecksState;
  /** Host's mergeable summary at review time. */
  mergeable_state: PrMergeableState;
  /** Did the diff add/modify test files? `false` flags untested code. */
  tests_touched: boolean;
  /** Did an ADDED line look like a planted credential/secret? */
  secret_suspected: boolean;
  /** Was the diff empty / unfetchable? Nothing to meaningfully review. */
  diff_empty: boolean;
  /** Was the diff too large to send the model in full (truncated for the
   *  prompt)? When true the LLM's judgment covers only the visible portion —
   *  surfaced as a risk so an `approve` isn't read as a full-diff review.
   *  NB: the deterministic scans (secrets, tests, files) still run over the
   *  FULL diff, so the SAFETY properties hold even when this is true. */
  diff_truncated: boolean;
  /** Count of files the diff touches (0 when empty/unfetchable). */
  files_changed: number;
}

/**
 * The structured review report. The owner reads it (manual mode) or
 * the daemon trusts its `recommendation` (auto mode).
 *
 *   summary        — one-paragraph human-readable account of the change.
 *   recommendation — approve | request_changes | reject (safety-guarded).
 *   rationale      — why the recommendation; the reasoning the owner reads.
 *   risks          — explicit risk flags (untested, scope creep, secrets,
 *                    breaking changes). Empty array = none surfaced.
 *   checksObserved — the deterministic facts (above).
 */
export interface PrReviewReport {
  summary: string;
  recommendation: PrReviewRecommendation;
  rationale: string;
  risks: string[];
  checksObserved: PrReviewChecksObserved;
}

/**
 * The raw structured output we ask the LLM for — the parts that are
 * genuinely the model's judgment. `checksObserved` is intentionally
 * NOT here: we compute it deterministically and never trust the model
 * for it. `assembleReport()` welds this together with the observed
 * signals into the final `PrReviewReport`.
 */
export interface RawLlmReview {
  summary: string;
  recommendation: PrReviewRecommendation;
  rationale: string;
  risks: string[];
}

/**
 * The deterministic signals the safety guard reasons over. Built from
 * the PR + its diff by `computeReviewSignals()`.
 */
export interface ReviewSignals {
  checks_state: PrChecksState;
  mergeable_state: PrMergeableState;
  tests_touched: boolean;
  secret_suspected: boolean;
  diff_empty: boolean;
  diff_truncated: boolean;
  files_changed: number;
}

// ── Diff scanners (pure) ──────────────────────────────────────────────

/**
 * High-precision credential patterns. We scan ONLY added lines (a PR
 * review flags NEWLY-introduced secrets, not ones being removed), so a
 * pattern hit is a strong signal — not the noisy "the word secret
 * appears somewhere" heuristic. Each pattern is shaped to its real
 * token format to keep false-positives near zero.
 */
export const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/, // AWS temporary access key id
  /\bghp_[A-Za-z0-9]{36,}\b/, // GitHub personal access token
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, // GitHub fine-grained PAT
  /\bgh[ousr]_[A-Za-z0-9]{36,}\b/, // GitHub oauth/server/refresh tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style secret key
  // Generic "<name> = '<long literal>'" assignment of a credential-ish
  // identifier — bounded to a quoted literal of 8+ chars to avoid
  // catching `apiKey = userInput` and similar non-literal code.
  /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
];

/** Added lines in a unified diff: `+…` but not the `+++ ` file header. */
function addedLines(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) out.push(line.slice(1));
  }
  return out;
}

/**
 * Does any ADDED line look like a planted credential? Pure scan over
 * the unified diff. Conservative by construction (added-lines only,
 * shaped patterns) — a hit is worth a hard downgrade.
 */
export function scanDiffForSecrets(diff: string): boolean {
  if (!diff) return false;
  const added = addedLines(diff).join('\n');
  return SECRET_PATTERNS.some((re) => re.test(added));
}

/** Recognise a path as a test file by the usual conventions. */
function isTestPath(path: string): boolean {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    /\.spec\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)__tests__\//.test(path) ||
    /(^|\/)tests?\//.test(path) ||
    /_test\.(py|go|rb)$/.test(path) ||
    /test_[^/]*\.py$/.test(path)
  );
}

/**
 * Extract the changed file paths from a unified diff's `diff --git`
 * / `+++ b/` headers. Pure.
 */
export function diffChangedPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split('\n')) {
    let m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      paths.add(m[1]);
      paths.add(m[2]);
      continue;
    }
    m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') paths.add(m[1]);
  }
  return [...paths];
}

/** Does the diff add/modify any test file? */
export function diffTouchesTests(diff: string): boolean {
  return diffChangedPaths(diff).some(isTestPath);
}

/** Is the diff empty / unfetchable (nothing to review)? Non-empty if it
 *  carries a file header, a hunk marker, OR any added/removed content
 *  line — so a content-only fragment (no headers) still counts. */
export function isDiffEmpty(diff: string): boolean {
  if (!diff || !diff.trim()) return true;
  if (/^diff --git /m.test(diff)) return false;
  if (/^@@/m.test(diff)) return false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) return false;
    if (line.startsWith('-') && !line.startsWith('---')) return false;
  }
  return true;
}

/**
 * Build the deterministic signals from the PR + its diff. Pure — the
 * reviewer passes `pr` (for CI/mergeable state) and the fetched diff
 * text. `checks_state`/`mergeable_state` come from the PR (the daemon
 * refreshes them); the diff-derived signals come from scanning.
 *
 * `maxChars` (when given) is the prompt's diff budget: a diff longer than
 * it is truncated for the model, so `diff_truncated` flags that the LLM's
 * judgment covered only the visible portion. The scans here still run over
 * the FULL `diff`, so secrets/tests/file-count are unaffected by truncation.
 */
export function computeReviewSignals(args: {
  pr: Pr;
  diff: string;
  maxChars?: number;
}): ReviewSignals {
  const { pr, diff, maxChars } = args;
  const empty = isDiffEmpty(diff);
  return {
    checks_state: pr.checks_state,
    mergeable_state: pr.mergeable_state,
    tests_touched: empty ? false : diffTouchesTests(diff),
    secret_suspected: empty ? false : scanDiffForSecrets(diff),
    diff_empty: empty,
    diff_truncated: !empty && maxChars != null && diff.length > maxChars,
    files_changed: empty ? 0 : diffChangedPaths(diff).filter((p) => p !== '/dev/null').length,
  };
}

// ── Safety guard (pure) ───────────────────────────────────────────────

/** Risk strings the guard appends when a hard signal fires. Exported
 *  so tests + the GUI can match on them stably. */
export const GUARD_RISK = {
  secret: 'A newly-added line looks like a committed credential/secret.',
  checks_failing: 'CI checks are failing or errored on this PR.',
  empty_diff: 'The diff is empty or could not be fetched — nothing to review.',
  no_tests: 'The change touches no test files (untested change).',
  truncated:
    'The diff was too large to review in full — the recommendation covers only the visible portion.',
} as const;

/**
 * The CORE honesty rail. Takes the LLM's recommendation + the
 * deterministic signals and returns a recommendation that is NEVER
 * more permissive than the facts allow, plus the risks to append.
 *
 * Rules (each sets a severity FLOOR; the result is max(llm, floor)):
 *   - a suspected secret           → reject          (floor 2)
 *   - failing/errored CI checks    → request_changes (floor 1)
 *   - an empty/unfetchable diff    → request_changes (floor 1)
 *
 * The guard only ever RAISES severity — if the model already said
 * `reject`, a green build won't talk it back down to approve. This is
 * what makes "a defective PR is never recommended for approval" hold
 * regardless of model behaviour (the PR-2 Done criterion).
 *
 * `no_tests` and `diff_truncated` are surfaced as RISKS but are NOT hard
 * floors — plenty of legitimate PRs touch no tests, and a large diff can
 * be a legitimate big refactor; forcing either off approve would be
 * dishonest in the other direction. The owner reads the flag and decides.
 * (Truncation does not weaken the SAFETY floors: secret/checks scans run
 * over the full diff regardless.)
 */
export function applySafetyGuard(
  llm: RawLlmReview,
  signals: ReviewSignals,
): { recommendation: PrReviewRecommendation; risks: string[] } {
  let floor = 0;
  const guardRisks: string[] = [];

  if (signals.secret_suspected) {
    floor = Math.max(floor, SEVERITY.reject);
    guardRisks.push(GUARD_RISK.secret);
  }
  if (signals.checks_state === 'failure' || signals.checks_state === 'error') {
    floor = Math.max(floor, SEVERITY.request_changes);
    guardRisks.push(GUARD_RISK.checks_failing);
  }
  if (signals.diff_empty) {
    floor = Math.max(floor, SEVERITY.request_changes);
    guardRisks.push(GUARD_RISK.empty_diff);
  }
  if (!signals.diff_empty && !signals.tests_touched) {
    guardRisks.push(GUARD_RISK.no_tests);
  }
  if (signals.diff_truncated) {
    guardRisks.push(GUARD_RISK.truncated);
  }

  const recommendation = recForSeverity(Math.max(severityOf(llm.recommendation), floor));

  // Merge LLM risks + guard risks, de-duplicated, guard risks last so
  // the mechanical flags are visible even if the model omitted them.
  const seen = new Set<string>();
  const risks: string[] = [];
  for (const r of [...llm.risks, ...guardRisks]) {
    const t = r.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      risks.push(t);
    }
  }
  return { recommendation, risks };
}

/**
 * Weld the LLM's judgment + the deterministic signals into the final
 * report. The recommendation + risks pass through the safety guard;
 * checksObserved is the raw signal facts. Pure.
 */
export function assembleReport(llm: RawLlmReview, signals: ReviewSignals): PrReviewReport {
  const guarded = applySafetyGuard(llm, signals);
  return {
    summary: llm.summary.trim(),
    recommendation: guarded.recommendation,
    rationale: llm.rationale.trim(),
    risks: guarded.risks,
    checksObserved: {
      checks_state: signals.checks_state,
      mergeable_state: signals.mergeable_state,
      tests_touched: signals.tests_touched,
      secret_suspected: signals.secret_suspected,
      diff_empty: signals.diff_empty,
      diff_truncated: signals.diff_truncated,
      files_changed: signals.files_changed,
    },
  };
}

// ── LLM-output parsing (pure, defensive) ──────────────────────────────

function isRecommendation(v: unknown): v is PrReviewRecommendation {
  return typeof v === 'string' && (PR_REVIEW_RECOMMENDATIONS as readonly string[]).includes(v);
}

/**
 * Extract the first balanced top-level JSON object from arbitrary LLM
 * text. The model may wrap the JSON in prose or a ```json fence; we
 * find the first `{` and walk to its matching `}` (string-aware so a
 * `}` inside a string literal doesn't end it early). Returns the JSON
 * substring or null.
 */
export function extractJsonObject(text: string): string | null {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse + validate an LLM completion into a `RawLlmReview`. Defensive:
 * tolerant of prose/fences around the JSON, strict on the shape.
 * Returns null on anything malformed so the reviewer can fall back to
 * a safe `reject` (never silently approve on a parse failure).
 *
 *   - recommendation MUST be one of the enum values.
 *   - summary + rationale MUST be non-empty strings.
 *   - risks MUST be an array; non-string entries are dropped; absent
 *     ⇒ [].
 */
export function parseRawLlmReview(text: string): RawLlmReview | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;
  if (!isRecommendation(r.recommendation)) return null;
  if (typeof r.summary !== 'string' || !r.summary.trim()) return null;
  if (typeof r.rationale !== 'string' || !r.rationale.trim()) return null;
  const risks = Array.isArray(r.risks)
    ? r.risks.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  return {
    summary: r.summary,
    recommendation: r.recommendation,
    rationale: r.rationale,
    risks,
  };
}

// ── Gate helper (consumed by PR-1's daemon) ───────────────────────────

/**
 * The single function the poll daemon (PR-1) calls to fold the agent's
 * recommendation into the auto-flow gate: auto-approve may proceed
 * ONLY when the agent recommended `approve`. The daemon ANDs this with
 * `decideAutoReview(pr, settings)` (trust + checks + state) — both must
 * pass. A `request_changes`/`reject` report blocks the auto path even
 * for a trusted author with green checks.
 */
export function reportGatesAutoApprove(report: Pick<PrReviewReport, 'recommendation'>): boolean {
  return report.recommendation === 'approve';
}

// ── Stored shape (consumed by store + GUI) ────────────────────────────

/**
 * A persisted review report row (the `harness_shared.pr_review_reports`
 * table). The report fields + the PR linkage + provenance (which model
 * reviewed which diff, at what cost) for traceability.
 */
export interface StoredPrReviewReport {
  workspace_id: string;
  harness_slug: string;
  pr_number: number;
  pr_url: string;
  /** Head commit SHA the diff was reviewed at — the diff fingerprint.
   *  A re-review at the same SHA is idempotent; a new SHA is a new row. */
  head_sha: string;
  /** Linked work-item/feature id (PR-4's harness_feature_prs), or null
   *  when the PR isn't yet linked to a WI. */
  feature_id: string | null;
  recommendation: PrReviewRecommendation;
  summary: string;
  rationale: string;
  risks: string[];
  checks_observed: PrReviewChecksObserved;
  /** Provenance: which model produced this, and its usage. */
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd_cents: number;
  /** ISO timestamp the report was written. */
  reviewed_at: string;
}

/**
 * Structural predicate for a stored report row read back from PG —
 * defends the GUI/daemon read path against legacy/garbled rows.
 */
export function isStoredPrReviewReport(input: unknown): input is StoredPrReviewReport {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || !r.harness_slug) return false;
  if (typeof r.pr_number !== 'number' || !Number.isInteger(r.pr_number)) return false;
  if (typeof r.pr_url !== 'string') return false;
  if (!isRecommendation(r.recommendation)) return false;
  if (typeof r.summary !== 'string') return false;
  if (typeof r.rationale !== 'string') return false;
  if (!Array.isArray(r.risks)) return false;
  if (r.checks_observed === null || typeof r.checks_observed !== 'object') return false;
  if (typeof r.model !== 'string') return false;
  return true;
}
