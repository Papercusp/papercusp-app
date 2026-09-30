/**
 * pr-host/agent-reviewer — the agent half of the owner's "human OR
 * agent review" model (PLAN-pr-system-completion-dogfood Phase PR-2).
 *
 * The poll daemon (PR-1) triggers this for a new/updated PR. It reads
 * the PR DIFF + the PR's WI/feature context (PR-4's harness_feature_prs)
 * + the repo conventions, asks a capable model to judge the change, and
 * produces a STRUCTURED, safety-guarded review report:
 *
 *   { summary, recommendation: approve|request_changes|reject,
 *     rationale, risks[], checksObserved{} }
 *
 * Safety rails (the spine of this module):
 *   - The reviewer NEVER posts a GitHub review or merges. It has no code
 *     path to host.postReview/merge — it only PRODUCES a recommendation.
 *     The gate (decideAutoReview) + owner mode decide whether it applies.
 *   - The recommendation is run through the deterministic safety guard
 *     (`assembleReport`): a failing build / a planted secret / an empty
 *     diff can only make the recommendation MORE conservative, never
 *     less — so a defective PR is never recommended for approval even if
 *     the model is fooled.
 *   - On a model failure / unparseable output the report falls back to
 *     `request_changes` (never silently approve), and the orchestrator
 *     records an `agent_review_error` audit row.
 *
 * Determinism/audit: every review stamps model + head_sha + usage into
 * `pr_review_reports` AND an `auto_review_audit` row, so a recommendation
 * is traceable (who/what reviewed, on what diff).
 *
 * The LLM call + storage are injectable (`runLlm`, `deps`) so the logic
 * is unit-testable with no live model and no DB.
 */
import { runAgentChat } from '../agent-chat-stream';
import type { Pr, PrHost } from './types';
import { createGitHubPrHost } from './github';
import {
  assembleReport,
  computeReviewSignals,
  parseRawLlmReview,
  type PrReviewReport,
  type RawLlmReview,
} from './pr-review-report-types';
import {
  loadFeatureContextForPr,
  storeReviewReport,
  writeAgentReviewAudit,
  type FeatureContext,
} from './pr-review-report-store';

/** The capable default model for PR review. Overridable per-deploy. */
export const REVIEW_MODEL = process.env.PAPERCUSP_PR_REVIEW_MODEL ?? 'claude-sonnet-4-6';

/** Cap the diff text sent to the model (the secret/test scan still runs
 *  over the FULL diff — only the prompt is bounded). */
export const DEFAULT_MAX_DIFF_CHARS = 60_000;

/** The reviewer's max output tokens — a report is a few paragraphs. */
const REVIEW_MAX_TOKENS = 1500;

export interface LlmRunResult {
  text: string;
  model: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/** Injectable LLM seam. Returns null on any failure (never throws). */
export type LlmRunner = (args: {
  systemPrompt: string;
  prompt: string;
  model: string;
  signal?: AbortSignal;
}) => Promise<LlmRunResult | null>;

/**
 * Default runner: one stateless anthropic-direct round-trip (same
 * transport as runHaiku, a more capable model + bigger budget). Returns
 * null on any failure so the reviewer falls back safely.
 */
export const defaultLlmRunner: LlmRunner = async ({ systemPrompt, prompt, model, signal }) => {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const killer = setTimeout(() => ac.abort(), 90_000);
  let out = '';
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let failed = false;
  try {
    for await (const ev of runAgentChat({
      backend: 'anthropic-direct',
      systemPromptText: systemPrompt,
      promptText: prompt,
      model,
      maxTokens: REVIEW_MAX_TOKENS,
      temperature: 0,
      signal: ac.signal,
      usageAttribution: { role: 'pr-reviewer' },
    })) {
      if (ev.type === 'delta') out = ev.text;
      else if (ev.type === 'result') {
        out = ev.finalText || out;
        costUsd = ev.costUsd ?? 0;
        tokensIn = ev.tokensIn ?? 0;
        tokensOut = ev.tokensOut ?? 0;
      } else if (ev.type === 'error') {
        failed = true;
        console.warn('[agent-reviewer] llm error:', (ev.stderr ?? ev.message)?.slice(0, 300));
      }
    }
  } catch (err) {
    console.warn('[agent-reviewer] llm threw:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(killer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (failed || !out.trim()) return null;
  return { text: out, model, costUsd, tokensIn, tokensOut };
};

/** The fixed reviewer instruction (the model's SYSTEM prompt). Encodes
 *  the honesty discipline + the strict-JSON output contract. */
export const REVIEWER_SYSTEM_PROMPT = [
  'You are an exacting code reviewer for a pull request. You produce a structured',
  'review report — you do NOT approve, merge, or comment on GitHub; your output is',
  'only advice that a human owner (or a gated automation) will weigh.',
  '',
  'Be honest and specific. Do NOT rubber-stamp. Actively look for and flag:',
  '  - changes that are untested (no test added/updated for new behaviour),',
  '  - scope creep — code unrelated to the work-item the PR claims to satisfy,',
  '  - committed secrets/credentials, debug code, or commented-out blocks,',
  '  - breaking changes, unsafe migrations, or removed safety checks,',
  '  - logic errors and unhandled failure modes.',
  '',
  'Recommend "approve" ONLY when the change is sound, in-scope, and adequately',
  'tested. Recommend "request_changes" when it needs work, and "reject" when it',
  'should not land at all (dangerous, out-of-scope, or fundamentally wrong).',
  '',
  'Respond with ONLY a single JSON object, no prose, no code fence:',
  '{',
  '  "summary": "<one paragraph: what the change does>",',
  '  "recommendation": "approve" | "request_changes" | "reject",',
  '  "rationale": "<why this recommendation>",',
  '  "risks": ["<each concrete risk you found>", "..."]',
  '}',
].join('\n');

/** Conventions docs the reviewer looks for, in priority order. The first
 *  one present in the base repo is loaded as the "repo conventions" the
 *  brief calls for. */
export const CONVENTIONS_CANDIDATES = [
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/CONVENTIONS.md',
] as const;

/** Cap on conventions text fed to the model. */
export const DEFAULT_MAX_CONVENTIONS_CHARS = 8_000;

/**
 * Best-effort load of the base repo's conventions doc via the host's
 * (optional) getRepoFile. Tries each candidate path in order, returns the
 * first non-empty one (bounded), or null when the host can't fetch files /
 * none exist. Never throws — conventions are advisory context.
 */
export async function loadRepoConventions(opts: {
  host: PrHost;
  remote: string;
  ref?: string;
  candidates?: readonly string[];
  maxChars?: number;
}): Promise<string | null> {
  if (typeof opts.host.getRepoFile !== 'function') return null;
  const candidates = opts.candidates ?? CONVENTIONS_CANDIDATES;
  const max = opts.maxChars ?? DEFAULT_MAX_CONVENTIONS_CHARS;
  for (const path of candidates) {
    let r;
    try {
      r = await opts.host.getRepoFile({ remote: opts.remote, path, ref: opts.ref });
    } catch {
      continue; // best-effort: a throw on one candidate must not abort the rest
    }
    if (r.ok && typeof r.data === 'string' && r.data.trim()) {
      const text = r.data.trim();
      return text.length > max ? text.slice(0, max) + '\n…[conventions truncated]…' : text;
    }
    // not_found / other miss → try the next candidate.
  }
  return null;
}

/** Render the WI/feature context block for the prompt. */
function renderFeatureContext(fc: FeatureContext | null | undefined): string {
  if (!fc) {
    return 'Work-item context: (none — this PR is not linked to a tracked work-item).';
  }
  return [
    `Work-item the PR claims to satisfy: ${fc.feature_id}`,
    fc.title ? `  Title: ${fc.title}` : null,
    fc.summary ? `  Summary: ${fc.summary}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the user-message prompt: PR metadata + WI context + the
 * mechanical observations + the (bounded) diff. Pure.
 */
export function buildReviewPrompt(args: {
  pr: Pr;
  diff: string;
  featureContext?: FeatureContext | null;
  conventions?: string;
}): string {
  const { pr, diff } = args;
  const parts: string[] = [];
  parts.push(`PR #${pr.ref.number} on ${pr.ref.remote}`);
  parts.push(`Title: ${pr.title}`);
  parts.push(`Author: @${pr.author.github_login}`);
  parts.push(`Base: ${pr.base_ref}  Head: ${pr.head_ref} (${pr.head_sha})`);
  parts.push(`CI checks: ${pr.checks_state}; mergeable: ${pr.mergeable_state}`);
  if (pr.body) parts.push(`\nPR description:\n${pr.body.slice(0, 4000)}`);
  parts.push('\n' + renderFeatureContext(args.featureContext));
  if (args.conventions && args.conventions.trim()) {
    parts.push(`\nRepository conventions to weigh the change against:\n${args.conventions.trim()}`);
  }
  parts.push('\nUnified diff:\n```diff\n' + diff + '\n```');
  parts.push('\nProduce the JSON review report now.');
  return parts.join('\n');
}

export interface ReviewProvenance {
  model: string;
  head_sha: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd_cents: number;
}

export interface ReviewPrResult {
  /** false ⇒ the model failed / output was unparseable; `report` is then
   *  the SAFE fallback (request_changes, plus any hard-signal downgrade). */
  ok: boolean;
  report: PrReviewReport;
  provenance: ReviewProvenance;
  error?: string;
}

export interface ReviewPrArgs {
  /** Used only to fetch the diff when `diff` isn't supplied. */
  host: PrHost;
  pr: Pr;
  featureContext?: FeatureContext | null;
  conventions?: string;
  /** Pre-fetched diff (tests / when the daemon already has it). When
   *  omitted, fetched via host.getPrDiff. */
  diff?: string;
  model?: string;
  runLlm?: LlmRunner;
  signal?: AbortSignal;
  maxDiffChars?: number;
}

function usdToCents(usd: number): number {
  return Math.round((Number.isFinite(usd) ? usd : 0) * 100);
}

/**
 * Review a single PR → a safety-guarded report. Pure-ish: the only
 * effects are the (injectable) diff fetch + LLM call. Never posts,
 * never merges, never writes to PG (that's `runAgentReview`).
 */
export async function reviewPr(args: ReviewPrArgs): Promise<ReviewPrResult> {
  const model = args.model ?? REVIEW_MODEL;
  const runLlm = args.runLlm ?? defaultLlmRunner;
  const maxChars = args.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;

  // 1. Resolve the diff. A fetch failure is NOT fatal — we review with
  //    an empty diff, which the guard treats as "nothing to review →
  //    request_changes".
  let diff = args.diff;
  let diffError: string | null = null;
  if (diff === undefined) {
    const r = await args.host.getPrDiff(args.pr.ref);
    if (r.ok) diff = r.data;
    else {
      diff = '';
      diffError = `diff_fetch_failed:${r.error.kind}`;
    }
  }

  // 2. Deterministic signals over the FULL diff (secret scan must not be
  //    truncation-evadable). The prompt gets a bounded copy; pass maxChars so
  //    the signals flag `diff_truncated` when the model saw only part of it.
  const signals = computeReviewSignals({ pr: args.pr, diff, maxChars });
  const boundedDiff =
    diff.length > maxChars ? diff.slice(0, maxChars) + '\n…[diff truncated for review]…' : diff;

  // 3. Ask the model (skip when there is nothing to review).
  let raw: RawLlmReview | null = null;
  let provenance: ReviewProvenance = {
    model,
    head_sha: args.pr.head_sha,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd_cents: 0,
  };
  let llmError: string | null = diffError;

  if (!signals.diff_empty) {
    const prompt = buildReviewPrompt({
      pr: args.pr,
      diff: boundedDiff,
      featureContext: args.featureContext,
      conventions: args.conventions,
    });
    const res = await runLlm({
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      prompt,
      model,
      signal: args.signal,
    });
    if (res) {
      provenance = {
        model: res.model || model,
        head_sha: args.pr.head_sha,
        tokens_in: res.tokensIn,
        tokens_out: res.tokensOut,
        cost_usd_cents: usdToCents(res.costUsd),
      };
      raw = parseRawLlmReview(res.text);
      if (!raw) llmError = 'unparseable_llm_output';
    } else {
      llmError = llmError ?? 'llm_unavailable';
    }
  }

  // 4. On any failure, fall back to a SAFE raw report (request_changes).
  //    The guard still runs over the signals, so a secret in the diff
  //    still escalates to reject even on this path.
  const ok = raw !== null && llmError === null;
  const effectiveRaw: RawLlmReview = raw ?? {
    summary: signals.diff_empty
      ? 'No reviewable diff was available for this PR.'
      : 'Automated review could not be completed (model unavailable or output unparseable).',
    recommendation: 'request_changes',
    rationale: signals.diff_empty
      ? 'The PR diff was empty or could not be fetched, so the change could not be assessed.'
      : 'The agent reviewer failed to produce a parseable report; defaulting to request_changes so the change is not auto-approved.',
    risks: [],
  };

  const report = assembleReport(effectiveRaw, signals);
  return { ok, report, provenance, error: llmError ?? undefined };
}

// ── Orchestrator: review → store → audit (what PR-1's daemon calls) ───

export interface RunAgentReviewDeps {
  loadFeatureContext?: typeof loadFeatureContextForPr;
  loadConventions?: typeof loadRepoConventions;
  store?: typeof storeReviewReport;
  audit?: typeof writeAgentReviewAudit;
}

export interface RunAgentReviewArgs extends Omit<ReviewPrArgs, 'featureContext'> {
  workspaceId: string;
  harnessSlug: string;
  /** The HUMAN operator's GitHub id this review is attributed to (PR-4
   *  identity). Recorded on the audit row. */
  reviewerGithubId: number;
  /** Feature id parsed from the PR title/body (PR-4 stamps `${featureId}`);
   *  used to resolve WI context when harness_feature_prs has no row yet. */
  bodyFeatureId?: string | null;
  /** Pre-resolved WI context (skips the DB lookup). */
  featureContext?: FeatureContext | null;
  deps?: RunAgentReviewDeps;
}

export interface RunAgentReviewResult {
  ok: boolean;
  report: PrReviewReport;
  provenance: ReviewProvenance;
  featureId: string | null;
  recommendation: PrReviewReport['recommendation'];
  error?: string;
}

/**
 * Full PR-2 flow: resolve WI context → review → persist the report →
 * write the audit row. This is the single entry point PR-1's poll daemon
 * calls. It NEVER approves/merges — it returns the recommendation for the
 * gate to weigh.
 */
export async function runAgentReview(args: RunAgentReviewArgs): Promise<RunAgentReviewResult> {
  const deps = args.deps ?? {};
  const loadFeatureContext = deps.loadFeatureContext ?? loadFeatureContextForPr;
  const loadConventions = deps.loadConventions ?? loadRepoConventions;
  const store = deps.store ?? storeReviewReport;
  const audit = deps.audit ?? writeAgentReviewAudit;

  // 0. Repo conventions (the brief's third reviewer input). When the caller
  //    didn't supply them, best-effort load from the base repo. A provided
  //    value (even '') is respected as an explicit override.
  let conventions = args.conventions;
  if (conventions === undefined) {
    try {
      conventions =
        (await loadConventions({
          host: args.host,
          remote: args.pr.ref.remote,
          ref: args.pr.base_ref,
        })) ?? undefined;
    } catch {
      conventions = undefined;
    }
  }

  // 1. WI context (skip the lookup if the caller pre-resolved it).
  let featureContext = args.featureContext ?? null;
  if (featureContext === null) {
    try {
      featureContext = await loadFeatureContext({
        harnessSlug: args.harnessSlug,
        prUrl: args.pr.url,
        bodyFeatureId: args.bodyFeatureId ?? null,
        workspaceId: args.workspaceId,
      });
    } catch {
      featureContext = null; // WI context is best-effort; review proceeds without it.
    }
  }
  const featureId = featureContext?.feature_id ?? null;

  // 2. Review.
  const result = await reviewPr({
    host: args.host,
    pr: args.pr,
    featureContext,
    conventions,
    diff: args.diff,
    model: args.model,
    runLlm: args.runLlm,
    signal: args.signal,
    maxDiffChars: args.maxDiffChars,
  });

  // 3. Persist the report (best-effort: a store failure must not lose the
  //    recommendation the daemon needs).
  let storeError: string | null = null;
  try {
    await store({
      workspaceId: args.workspaceId,
      harnessSlug: args.harnessSlug,
      prNumber: args.pr.ref.number,
      prUrl: args.pr.url,
      headSha: result.provenance.head_sha,
      featureId,
      report: result.report,
      model: result.provenance.model,
      tokensIn: result.provenance.tokens_in,
      tokensOut: result.provenance.tokens_out,
      costUsdCents: result.provenance.cost_usd_cents,
    });
  } catch (e) {
    storeError = (e as Error).message;
  }

  // 4. Audit (traceability: who/what reviewed which diff → what).
  const detail = JSON.stringify({
    model: result.provenance.model,
    head_sha: result.provenance.head_sha,
    recommendation: result.report.recommendation,
    feature_id: featureId,
    tokens_in: result.provenance.tokens_in,
    tokens_out: result.provenance.tokens_out,
    risks: result.report.risks.length,
    ...(result.error ? { error: result.error } : {}),
    ...(storeError ? { store_error: storeError } : {}),
  });
  await audit({
    workspaceId: args.workspaceId,
    harnessSlug: args.harnessSlug,
    prNumber: args.pr.ref.number,
    prUrl: args.pr.url,
    authorGithubId: args.pr.author.github_user_id,
    reviewerGithubId: args.reviewerGithubId,
    action: result.ok ? 'agent_review' : 'agent_review_error',
    detail,
  });

  return {
    ok: result.ok && storeError === null,
    report: result.report,
    provenance: result.provenance,
    featureId,
    recommendation: result.report.recommendation,
    error: result.error ?? storeError ?? undefined,
  };
}

// ── Triggered-task entry point (the consumer of PR-1's `pr:review` trigger) ──

/**
 * The payload PR-1's poll daemon ships with the `pr:review` trigger
 * (`extra: ['--pr-review', JSON.stringify(...)]`). Identifies the PR to
 * review by `(remote, number)`.
 */
export interface PrReviewTaskPayload {
  remote: string;
  number: number;
  head_sha?: string;
  url?: string;
}

export interface RunPrReviewTaskArgs {
  payload: PrReviewTaskPayload;
  workspaceId: string;
  harnessSlug: string;
  /** The HUMAN operator's GitHub id the review is attributed to (PR-4). */
  reviewerGithubId: number;
  bodyFeatureId?: string | null;
  /** Inject a host (tests). Default: createGitHubPrHost() (live). */
  host?: PrHost | null;
  runLlm?: LlmRunner;
  model?: string;
  conventions?: string;
  deps?: RunAgentReviewDeps;
  signal?: AbortSignal;
}

export type RunPrReviewTaskResult =
  | { ok: true; review: RunAgentReviewResult }
  | { ok: false; error: 'no_pr_host' | string };

/**
 * Run a PR review FROM A TRIGGER PAYLOAD — the entry point a spawned
 * reviewer task (PR-1's `pr:review` launch) or a loopback handler invokes.
 * Resolves a host, fetches the full PR for `(remote, number)`, then runs
 * the full review→store→audit flow via `runAgentReview`.
 *
 * Self-contained + injectable so it's unit-testable with no live host /
 * model / DB. Never posts/merges (inherits runAgentReview's guarantee).
 *
 * Returns `{ok:false}` when it can't even start (not authed / PR fetch
 * failed) so the caller can log + move on; the auto-flow gate treats an
 * absent report as "no veto", so a failed review never blocks PR-1.
 */
export async function runPrReviewTask(args: RunPrReviewTaskArgs): Promise<RunPrReviewTaskResult> {
  // Explicit `null` ⇒ "no host" (testable); `undefined` ⇒ resolve the live host.
  const host = args.host !== undefined ? args.host : await createGitHubPrHost();
  if (!host) return { ok: false, error: 'no_pr_host' };

  const got = await host.getPr({ remote: args.payload.remote, number: args.payload.number });
  if (!got.ok) return { ok: false, error: `getPr_failed:${got.error.kind}` };

  const review = await runAgentReview({
    host,
    pr: got.data,
    workspaceId: args.workspaceId,
    harnessSlug: args.harnessSlug,
    reviewerGithubId: args.reviewerGithubId,
    bodyFeatureId: args.bodyFeatureId,
    runLlm: args.runLlm,
    model: args.model,
    conventions: args.conventions,
    deps: args.deps,
    signal: args.signal,
  });
  return { ok: true, review };
}
