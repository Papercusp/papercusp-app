/**
 * pr-host/index — PrHost abstraction barrel + factory helpers.
 *
 * Phase 7 P-040: `PrHost` interface (types.ts) + GitHub impl (github.ts).
 *
 * Usage:
 *   const host = createGitHubPrHost();          // uses getOctokit()
 *   const host = createGitHubPrHost(myOctokit); // inject in tests
 */

export type {
  Pr,
  PrRef,
  PrState,
  PrMergeMethod,
  PrReviewDecision,
  PrReviewEvent,
  PrHostKind,
  PrHostResult,
  PrHostError,
  PrHostErrorKind,
  OpenPrArgs,
  PostReviewArgs,
  MergePrArgs,
  ListOpenPrsArgs,
  GetRepoFileArgs,
  PrHost,
} from './types';

export {
  ok,
  err,
  isRetryableError,
  isAuthError,
  isGoneError,
  composePrKey,
  parsePrKey,
  statusToErrorKind,
  PR_STATES,
  PR_HOST_ERROR_KINDS,
  PR_HOST_KINDS,
  PR_REVIEW_EVENTS,
} from './types';

export { GitHubPrHost, createGitHubPrHost } from './github';

// PR-2 — agent-reviewer + structured review report.
export type {
  PrReviewRecommendation,
  PrReviewChecksObserved,
  PrReviewReport,
  RawLlmReview,
  ReviewSignals,
  StoredPrReviewReport,
} from './pr-review-report-types';
export {
  PR_REVIEW_RECOMMENDATIONS,
  SECRET_PATTERNS,
  GUARD_RISK,
  scanDiffForSecrets,
  diffChangedPaths,
  diffTouchesTests,
  isDiffEmpty,
  computeReviewSignals,
  applySafetyGuard,
  assembleReport,
  extractJsonObject,
  parseRawLlmReview,
  reportGatesAutoApprove,
  isStoredPrReviewReport,
} from './pr-review-report-types';

export type {
  LlmRunner,
  LlmRunResult,
  ReviewPrArgs,
  ReviewPrResult,
  ReviewProvenance,
  RunAgentReviewArgs,
  RunAgentReviewResult,
  RunAgentReviewDeps,
  PrReviewTaskPayload,
  RunPrReviewTaskArgs,
  RunPrReviewTaskResult,
} from './agent-reviewer';
export {
  REVIEW_MODEL,
  DEFAULT_MAX_DIFF_CHARS,
  REVIEWER_SYSTEM_PROMPT,
  CONVENTIONS_CANDIDATES,
  DEFAULT_MAX_CONVENTIONS_CHARS,
  defaultLlmRunner,
  loadRepoConventions,
  buildReviewPrompt,
  reviewPr,
  runAgentReview,
  runPrReviewTask,
} from './agent-reviewer';

export type {
  FeatureContext,
  StoreReviewReportArgs,
  WriteAgentReviewAuditArgs,
  AgentReviewAuditAction,
} from './pr-review-report-store';
export {
  storeReviewReport,
  readLatestReviewReport,
  loadFeatureContextForPr,
  writeAgentReviewAudit,
} from './pr-review-report-store';
