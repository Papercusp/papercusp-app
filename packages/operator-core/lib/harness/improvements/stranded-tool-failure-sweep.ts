/**
 * Sweep the promoted tool-failure bugs that no lane can claim (plan
 * unified-bug-pipeline-and-honest-queue-2026-10-05, P-003 / D-022;
 * EI-25176539351759672).
 *
 * Before P-002, two producers stamped an `unknown` readiness that waits on a
 * verifier but never handed the row to one: a corroborated tool-failure
 * promotion (`corroborated-tool-failure-awaiting-review`) and a triage place
 * whose deployment screen could not answer (`deployment-freshness-unknown`).
 * The claim floor holds both out of self-select, and the reviewer lane selects
 * only `agentReview.status = pending`, so ~620 open bugs sat where nobody could
 * pick them up. P-002 fixed the producers; this sweep clears the rows they had
 * already stamped, and any later row that lands in the same state.
 *
 * Each row takes the FIRST outcome that applies:
 *  1. `verified` — it carries a filing-time encounter receipt (D-024) that
 *     `verifyBugReproductionReceipt` still accepts, and the failure is not
 *     caller-classified. The bug is born verified, exactly as capture would have
 *     stamped it (D-011).
 *  2. `retired` — D-012: the file defining the tool changed between the report's
 *     build and the build serving now, and no failing call of that tool with that
 *     error code happened after the last change. The row records reportBuild,
 *     currentBuild and lastMatchingFailureAt, and resolves under its own owner.
 *  3. `review` — everything else enters agent review, which the reviewer lane
 *     claims. A row whose freshness cannot be resolved always lands here, never
 *     in (2): an unknown is not evidence that the bug is gone.
 *
 * It runs as a bounded pass in the watchdog's 'papercusp-invocation-friction'
 * collector, beside the signature fold, so it needs no manual step and finishes
 * on its own. Bounded by rows AND wall time: a slow git read defers the rest of
 * the batch to the next tick instead of stretching the collector.
 */
import { getOrgPg } from '@papercusp/db-org';

import { getBuildInfo } from '../../build-info';
import { gitReadForRepo, type GitRead } from '../../candidate-contains';
import { realGit } from '../../git-pipeline-position';
import { getIssue, mergeIssuePayload, setIssueState, type EngineerIssue } from '../../issues-engineer';
import { integrationRoot } from '../../release-deploy-launch';
import { pathStaleness, relativizeToRepo, type PathStaleness } from '../../tool-schema-staleness';
import { resolveToolSourceFile } from '../../tool-source-file';
import {
  isAcceptedReproductionStatus,
  readStoredBugReproduction,
  sameBuildSha,
  verifyBugReproductionReceipt,
  type ReproductionLedgerDeps,
  type ReproductionVerification,
} from '../../attention/bug-reproduction';
import { createImplementationReadiness } from './agent-review-policy';
import {
  STRANDED_REVIEW_REASONS,
  enrolPromotedToolFailureReview,
  type CaptureDeps,
} from './capture-core';
import { structuredToolFailureSubject } from './deployment-staleness-screen';

type Sql = ReturnType<typeof getOrgPg>['sql'];

export const STRANDED_SWEEP_OWNER = 'system:stranded-tool-failure-sweep';
export const STRANDED_SWEEP_BATCH = 200;
/** How many enrolment failures a pass reports with their reason. */
export const ENROL_FAILURE_SAMPLE = 10;
/** Wall-time budget for one pass; rows past it wait for the next tick. */
export const STRANDED_SWEEP_BUDGET_MS = 45_000;

export type StrandedOutcome = 'verified' | 'retired' | 'review';

/** Why a row could not be retired. Enumerated so the review note can be counted. */
export type NotRetirableReason =
  | 'no-structured-tool-failure'
  | 'report-build-unknown'
  | 'current-build-unknown'
  | 'report-on-current-build'
  | 'tool-source-unknown'
  | 'source-outside-repo'
  | 'tool-unchanged-since-report'
  | 'failure-after-last-change'
  | `freshness-unknown:${string}`
  | 'ledger-unreadable';

export type RetirementVerdict =
  | {
      retirable: true;
      toolName: string;
      errorCode: string | null;
      relPath: string;
      reportBuild: string;
      currentBuild: string;
      changeCommits: string[];
      lastMatchingFailureAt: string;
    }
  | { retirable: false; reason: NotRetirableReason };

export interface StrandedFacts {
  /** Fresh verdict on the stored encounter receipt; null when there is none or it is ineligible. */
  reproduction: ReproductionVerification | null;
  retirement: RetirementVerdict;
}

export interface StrandedClassification {
  outcome: StrandedOutcome;
  /** Short, countable reason: the receipt status, the retirement evidence, or why neither applied. */
  reason: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function probationOf(payload: Record<string, unknown>): Record<string, unknown> {
  return record(payload.toolFailureProbation);
}

function isCallerClassified(payload: Record<string, unknown>): boolean {
  return probationOf(payload).class === 'caller';
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * The build the failing call ran on. D-022 names the freshness envelope's source sha;
 * the runtime sha and the probation's deployed revision are fallbacks for rows filed
 * before the envelope existed. `runtime-unknown` and anything not sha-shaped is no build.
 */
export function reportBuildOf(payload: Record<string, unknown>): string | null {
  const envelope = record(payload.freshnessEnvelope);
  for (const candidate of [envelope.observedSourceSha, envelope.observedRuntimeSha, probationOf(payload).deployedRevision]) {
    if (typeof candidate === 'string' && SHA_RE.test(candidate.trim())) return candidate.trim();
  }
  return null;
}

/** The report's own error code, or null when the filing named none. */
export function reportErrorCodeOf(payload: Record<string, unknown>): string | null {
  const code = record(probationOf(payload).report).errorCode;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

/**
 * The latest moment this report itself saw the failure. Every stamp a filing can carry
 * counts, so a ledger with short retention cannot make the report look older than it is.
 */
export function reportLastSeenAt(payload: Record<string, unknown>): string | null {
  const probation = probationOf(payload);
  const stamps = [
    payload.lastSeenAt,
    probation.lastSeenAt,
    probation.firstSeenAt,
    record(payload.freshnessEnvelope).observedAt,
    record(payload.toolInvocation).invokedAt,
  ];
  let latest: number | null = null;
  for (const stamp of stamps) {
    if (typeof stamp !== 'string') continue;
    const at = Date.parse(stamp);
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/**
 * Pick the outcome (pure). The order is D-022's: a verified receipt wins, then a
 * retirement backed by evidence, and review takes everything else — including every
 * row whose freshness could not be resolved.
 */
export function classifyStrandedRow(
  payload: Record<string, unknown>,
  facts: StrandedFacts,
): StrandedClassification {
  if (facts.reproduction && !isCallerClassified(payload) && isAcceptedReproductionStatus(facts.reproduction.status)) {
    return { outcome: 'verified', reason: `receipt-${facts.reproduction.status}` };
  }
  if (facts.retirement.retirable) return { outcome: 'retired', reason: 'tool-changed-and-quiet' };
  return { outcome: 'review', reason: facts.retirement.reason };
}

export interface StrandedSweepDeps {
  sql?: Sql;
  /** The build serving now; the retirement range ends here, never at the tree. */
  currentBuild?: () => string | null;
  sourceFileFor?: (toolName: string) => string | null | Promise<string | null>;
  repoRoot?: string;
  git?: GitRead;
  /** Latest failing call of `toolName` (with `errorCode`, when given) strictly after `after`. */
  lastFailureAfter?: (toolName: string, errorCode: string | null, after: string) => Promise<string | null>;
  ledger?: ReproductionLedgerDeps;
  mergeIssuePayload?: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  resolveRetired?: (id: string) => Promise<unknown>;
  getIssue?: (id: string) => Promise<EngineerIssue | null>;
  captureDeps?: CaptureDeps;
  now?: () => number;
}

/** Is the receipt still accepted? Ineligible filings and caller-classified failures never skip review. */
export async function reproductionFact(
  payload: Record<string, unknown>,
  ledger: ReproductionLedgerDeps,
): Promise<ReproductionVerification | null> {
  const stored = readStoredBugReproduction(payload);
  if (!stored || stored.verification.status === 'not-eligible' || isCallerClassified(payload)) return null;
  return verifyBugReproductionReceipt(stored.receipt, ledger);
}

type ResolvedRetirementDeps = Required<
  Pick<StrandedSweepDeps, 'currentBuild' | 'sourceFileFor' | 'repoRoot' | 'git' | 'lastFailureAfter'>
>;

function stalenessReason(verdict: Extract<PathStaleness, { state: 'unknown' }>): NotRetirableReason {
  return `freshness-unknown:${verdict.reason}`;
}

/**
 * D-012 retirement evidence for one row. Two git reads at most: first whether the
 * defining file changed between the report's build and the serving build at all, then
 * — only when it did — whether it changed again AFTER the last matching failure.
 */
export async function retirementFact(
  payload: Record<string, unknown>,
  deps: ResolvedRetirementDeps,
): Promise<RetirementVerdict> {
  const toolName = structuredToolFailureSubject({ payload });
  if (!toolName) return { retirable: false, reason: 'no-structured-tool-failure' };
  const reportBuild = reportBuildOf(payload);
  if (!reportBuild) return { retirable: false, reason: 'report-build-unknown' };
  const currentBuild = deps.currentBuild();
  if (!currentBuild) return { retirable: false, reason: 'current-build-unknown' };
  if (sameBuildSha(reportBuild, currentBuild)) return { retirable: false, reason: 'report-on-current-build' };

  const sourceFile = await deps.sourceFileFor(toolName);
  if (!sourceFile) return { retirable: false, reason: 'tool-source-unknown' };
  const relPath = relativizeToRepo(sourceFile, deps.repoRoot);
  if (!relPath) return { retirable: false, reason: 'source-outside-repo' };

  const range = { deployedSha: () => reportBuild, repoRoot: deps.repoRoot, git: deps.git, treeRef: currentBuild };
  const changed = await pathStaleness(relPath, range);
  if (changed.state === 'unknown') return { retirable: false, reason: stalenessReason(changed) };
  if (changed.state === 'current') return { retirable: false, reason: 'tool-unchanged-since-report' };

  const errorCode = reportErrorCodeOf(payload);
  const seen = reportLastSeenAt(payload);
  if (!seen) return { retirable: false, reason: 'report-build-unknown' };
  let laterFailure: string | null;
  try {
    laterFailure = await deps.lastFailureAfter(toolName, errorCode, seen);
  } catch {
    return { retirable: false, reason: 'ledger-unreadable' };
  }
  const lastMatchingFailureAt = laterFailure ?? seen;
  // A change only counts if it landed after the last time the failure was seen.
  const quiet = await pathStaleness(relPath, { ...range, notBefore: lastMatchingFailureAt });
  if (quiet.state === 'unknown') return { retirable: false, reason: stalenessReason(quiet) };
  if (quiet.state === 'current') return { retirable: false, reason: 'failure-after-last-change' };
  return {
    retirable: true,
    toolName,
    errorCode,
    relPath,
    reportBuild,
    currentBuild,
    changeCommits: quiet.newerCommits.slice(0, 5),
    lastMatchingFailureAt,
  };
}

const CANDIDATES_SQL = `
    SELECT feature_id AS id, harness_slug, payload
      FROM harness_shared.work_items
     WHERE workspace_id = $1
       AND item_kind IN ('bug', 'change')
       AND status = 'open'
       AND taken_by IS NULL
       AND claim_hold IS NOT TRUE
       AND needs_owner_action IS NOT TRUE
       AND needs_human_review IS NOT TRUE
       AND lane IS DISTINCT FROM 'observation'
       AND payload->>'lane' IS DISTINCT FROM 'observation'
       AND COALESCE(admission, '') <> 'pending'
       AND payload->'implementationReadiness'->>'status' = 'unknown'
       AND payload->'implementationReadiness'->>'reason' = ANY ($2::text[])
       AND (payload->'agentReview' IS NULL OR jsonb_typeof(payload->'agentReview') = 'null')
     ORDER BY updated_ts ASC NULLS FIRST, feature_id
     LIMIT $3`;

// A failing call is any recorded status other than the two the reproduction verifier
// treats as success. Matching on the error code alone (not the field path) is the
// conservative reading: any failure of that kind keeps the row out of retirement.
const LAST_FAILURE_SQL = `
    SELECT max(invoked_at) AS last
      FROM harness_shared.tool_invocations
     WHERE workspace_id = $1
       AND tool_name = $2
       AND ($3::text IS NULL OR error_code = $3)
       AND status IS NOT NULL
       AND status NOT IN ('ok', 'replayed')
       AND invoked_at > $4::timestamptz`;

interface CandidateRow {
  id: string;
  harness_slug: string | null;
  payload: Record<string, unknown>;
}

export interface StrandedSweepResult {
  scanned: number;
  verified: number;
  retired: number;
  review: number;
  /** Review rows the reviewer lane could not take; stamped and retried on a later tick. */
  enrolFailed: number;
  /**
   * Why enrolment failed, per row (first {@link ENROL_FAILURE_SAMPLE} rows). A bare count
   * hid the cause on the first live run (3 rows refused 'remote-owned'); the message is
   * the same one stamped on the row as agentReviewFailure.
   */
  enrolFailures: Array<{ id: string; message: string }>;
  /** Rows left for the next tick because the wall-time budget ran out. */
  deferred: number;
  failed: number;
  /** Per-reason counts for rows routed to review, so the note says WHY they were not retired. */
  reviewReasons: Record<string, number>;
  /** Dry-run only: what each row would get. */
  plan?: Array<{ id: string; outcome: StrandedOutcome; reason: string }>;
}

function defaultLedger(sql: Sql): ReproductionLedgerDeps {
  return {
    readTestRun: async (id) => {
      const [row] = await sql.unsafe<Array<{ status: string | null; commit_sha: string | null; worktree_dirty: boolean | null }>>(
        'SELECT status, commit_sha, worktree_dirty FROM harness_shared.test_runs WHERE id = $1',
        [id],
      );
      return row ? { status: row.status, commitSha: row.commit_sha, worktreeDirty: row.worktree_dirty } : null;
    },
    readToolInvocation: async (id) => {
      const [row] = await sql.unsafe<Array<{ status: string | null; serving_build_sha: string | null }>>(
        'SELECT status, serving_build_sha FROM harness_shared.tool_invocations WHERE id = $1',
        [id],
      );
      return row ? { status: row.status, servingBuildSha: row.serving_build_sha } : null;
    },
    now: () => new Date(),
  };
}

/** The deps capture's own promotion enrolment uses, minus everything it does not touch. */
function defaultCaptureDeps(): CaptureDeps {
  return {
    enterAgentReview: async (input) => {
      const { enterAgentReview } = await import('./agent-review');
      return enterAgentReview(input);
    },
  } as CaptureDeps;
}

/**
 * One bounded sweep pass for a workspace. A row that throws is counted in `failed` and
 * left for the next tick; it never aborts the others. `dryRun` classifies without writing.
 */
export async function sweepStrandedToolFailures(
  workspaceId: string,
  deps: StrandedSweepDeps = {},
  opts: { limit?: number; budgetMs?: number; dryRun?: boolean } = {},
): Promise<StrandedSweepResult> {
  const sql = deps.sql ?? getOrgPg().sql;
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const repoRoot = deps.repoRoot ?? integrationRoot();
  const retirementDeps: ResolvedRetirementDeps = {
    currentBuild: deps.currentBuild ?? (() => getBuildInfo().sha ?? null),
    sourceFileFor: deps.sourceFileFor ?? resolveToolSourceFile,
    repoRoot,
    git: deps.git ?? gitReadForRepo(realGit, repoRoot),
    lastFailureAfter:
      deps.lastFailureAfter ??
      (async (toolName, errorCode, after) => {
        const [row] = await sql.unsafe<Array<{ last: Date | string | null }>>(LAST_FAILURE_SQL, [
          workspaceId,
          toolName,
          errorCode,
          after,
        ]);
        const last = row?.last;
        return last ? new Date(last).toISOString() : null;
      }),
  };
  const ledger = deps.ledger ?? defaultLedger(sql);
  const merge = deps.mergeIssuePayload ?? ((id, patch) => mergeIssuePayload(id, patch));
  const resolve =
    deps.resolveRetired ??
    ((id) => setIssueState(id, 'resolved', STRANDED_SWEEP_OWNER, undefined, { skipCompletionGate: true }));
  const readIssue = deps.getIssue ?? ((id) => getIssue(id));
  const captureDeps = deps.captureDeps ?? defaultCaptureDeps();

  const rows = await sql.unsafe<CandidateRow[]>(CANDIDATES_SQL, [
    workspaceId,
    [...STRANDED_REVIEW_REASONS],
    opts.limit ?? STRANDED_SWEEP_BATCH,
  ]);
  const result: StrandedSweepResult = {
    scanned: rows.length,
    verified: 0,
    retired: 0,
    review: 0,
    enrolFailed: 0,
    enrolFailures: [],
    deferred: 0,
    failed: 0,
    reviewReasons: {},
    ...(opts.dryRun ? { plan: [] } : {}),
  };
  const budget = opts.budgetMs ?? STRANDED_SWEEP_BUDGET_MS;

  for (const [index, row] of rows.entries()) {
    if (now() - started > budget) {
      result.deferred = rows.length - index;
      break;
    }
    try {
      const payload = record(row.payload);
      const [reproduction, retirement] = await Promise.all([
        reproductionFact(payload, ledger),
        retirementFact(payload, retirementDeps),
      ]);
      const classification = classifyStrandedRow(payload, { reproduction, retirement });
      if (classification.outcome === 'review') {
        result.reviewReasons[classification.reason] = (result.reviewReasons[classification.reason] ?? 0) + 1;
      }
      result.plan?.push({ id: row.id, ...classification });
      if (opts.dryRun) {
        result[classification.outcome]++;
        continue;
      }
      const at = new Date(now()).toISOString();
      const marker = { owner: STRANDED_SWEEP_OWNER, at, outcome: classification.outcome, reason: classification.reason };

      if (classification.outcome === 'verified' && reproduction) {
        const stored = readStoredBugReproduction(payload);
        await merge(row.id, {
          implementationReadiness: createImplementationReadiness({
            status: 'ready',
            source: 'capture-policy',
            reason: 'born-verified-tool-failure-promotion',
          }),
          ...(stored ? { reproduction: { ...stored, verification: reproduction } } : {}),
          strandedToolFailureSweep: marker,
        });
        result.verified++;
        continue;
      }

      if (classification.outcome === 'retired' && retirement.retirable) {
        const errorText = retirement.errorCode ? ` ${retirement.errorCode}` : '';
        await merge(row.id, {
          decidedReason:
            `retired — \`${retirement.relPath}\` (defines ${retirement.toolName}) changed between the report's ` +
            `build ${retirement.reportBuild} and the serving build ${retirement.currentBuild}, and no failing ` +
            `${retirement.toolName}${errorText} call was recorded after the last change ` +
            `(last matching failure ${retirement.lastMatchingFailureAt}). ` +
            'Stranded tool-failure sweep (unified-bug-pipeline-and-honest-queue-2026-10-05 D-012/D-022).',
          strandedToolFailureSweep: {
            ...marker,
            toolName: retirement.toolName,
            errorCode: retirement.errorCode,
            relPath: retirement.relPath,
            reportBuild: retirement.reportBuild,
            currentBuild: retirement.currentBuild,
            changeCommits: retirement.changeCommits,
            lastMatchingFailureAt: retirement.lastMatchingFailureAt,
          },
        });
        await resolve(row.id);
        result.retired++;
        continue;
      }

      const issue = await readIssue(row.id);
      if (!issue) {
        result.failed++;
        continue;
      }
      const enrolment = await enrolPromotedToolFailureReview(
        issue,
        {
          submittedBy: STRANDED_SWEEP_OWNER,
          workspaceId,
          ...(row.harness_slug ? { fallbackScope: `harness:${row.harness_slug}` } : {}),
        },
        captureDeps,
      );
      if (enrolment.enrolled) {
        await merge(row.id, { strandedToolFailureSweep: marker });
        result.review++;
      } else {
        result.enrolFailed++;
        if (result.enrolFailures.length < ENROL_FAILURE_SAMPLE) {
          result.enrolFailures.push({ id: row.id, message: enrolment.failure?.message ?? 'not eligible for agent review' });
        }
      }
    } catch {
      result.failed++;
    }
  }
  return result;
}

/** The one-line watchdog note for a pass. */
export function renderStrandedSweepNote(result: StrandedSweepResult | { error: string }): string {
  if ('error' in result) return `stranded-sweep error=${result.error}`;
  const reasons = Object.entries(result.reviewReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, n]) => `${reason}:${n}`)
    .join(',');
  const failures = result.enrolFailures
    .slice(0, 3)
    .map((f) => `${f.id}:${f.message.replace(/^agent-review enrollment was not entered: /, '')}`)
    .join(',');
  return (
    `stranded-sweep scanned=${result.scanned} verified=${result.verified} retired=${result.retired} ` +
    `review=${result.review} enrolFailed=${result.enrolFailed} deferred=${result.deferred} failed=${result.failed}` +
    (reasons ? ` reviewReasons=${reasons}` : '') +
    (failures ? ` enrolFailures=${failures}` : '')
  );
}
