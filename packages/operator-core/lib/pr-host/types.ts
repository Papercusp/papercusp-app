/**
 * pr-host/types — neutral types for the PrHost abstraction (Phase 7
 * P-040) per papercusp-dogfood-v5 §8 + D-009.
 *
 * Types-only — no Octokit, no @octokit/auth-*, no HTTP. The v1
 * implementation (`./github.ts`) imports these verbatim; future
 * v2+ impls (GitLab, Gitea, Bitbucket) drop in against the same
 * interface without touching call-sites.
 *
 * Seventh module in the dogfood-arc types-only spine. Same one-per-
 * design-anchor pattern as:
 *   - apps/operator/lib/harness/binding-types.ts                  (P-068)
 *   - apps/operator/lib/identity/binding-verifier-types.ts        (P-075)
 *   - apps/operator/lib/identity/attestation-types.ts             (P-011)
 *   - apps/operator/lib/identity/contributor-file-types.ts        (P-075 Channel 2)
 *   - apps/operator/lib/harness/contributor-usage-event-types.ts  (P-070)
 *   - apps/operator/lib/harness/feature-claim-types.ts            (P-036)
 *
 * Why neutral types and not "GitHub types": v5 D-009 commits to
 * GitHub for v1 but explicitly carves out GitLab/Gitea/Bitbucket
 * paths for v2+. Every Phase 7 task (P-040 through P-046) consumes
 * the PrHost interface — if it leaks Octokit-specific shapes, the
 * v2+ ports become a rewrite instead of a drop-in.
 *
 * The neutral shapes here mirror what GitHub returns (so the v1
 * GitHub impl is a straight passthrough) but use snake-case fields
 * + value-typed enums so a GitLab impl can map cleanly without
 * needing to invent a translation layer.
 */

/**
 * PR identity. A `(remote, number)` pair uniquely names a PR on the
 * host. `remote` is the same string we store in feature
 * `completion_ref.remote` (e.g. `"github.com/papercup-ai/papercup"`)
 * — keeps the join from PrHost results back to harness rows trivial.
 */
export interface PrRef {
  remote: string;
  /** PR number is host-side stable; same as `pull_request.number`
   * on GitHub. Positive integer. */
  number: number;
}

/**
 * The four canonical PR lifecycle states. v5 §8 references these
 * in the poll-daemon + auto-approve/auto-merge logic.
 *
 * `open` — PR exists, neither merged nor closed.
 * `merged` — PR was merged. Terminal.
 * `closed` — PR was closed without merge. Terminal.
 * `gone` — PR was deleted/transferred upstream (P-042f).
 *   Set client-side; not a host-reported value.
 */
export const PR_STATES = ['open', 'merged', 'closed', 'gone'] as const;
export type PrState = (typeof PR_STATES)[number];

/**
 * Reviewer decision per v5 §8.4 + GitHub's PR review API.
 *
 * `none`             — no review submitted yet on this PR.
 * `approved`         — at least one approval, no requested-changes.
 * `changes_requested` — at least one requested-changes review.
 * `commented`        — only comments, no approve / reject.
 */
export const PR_REVIEW_DECISIONS = [
  'none',
  'approved',
  'changes_requested',
  'commented',
] as const;
export type PrReviewDecision = (typeof PR_REVIEW_DECISIONS)[number];

/**
 * Checks-summary states per v5 §8.4 + GitHub's combined-status API.
 *
 * `unknown` — no checks reported yet (or polling failed).
 * `pending` — at least one in-progress check.
 * `success` — all checks green.
 * `failure` — at least one check failed.
 * `error`   — at least one check errored (infra issue, not a code failure).
 * `cancelled` — at least one check cancelled.
 */
export const PR_CHECKS_STATES = [
  'unknown',
  'pending',
  'success',
  'failure',
  'error',
  'cancelled',
] as const;
export type PrChecksState = (typeof PR_CHECKS_STATES)[number];

/**
 * Mergeable-state subset that PrHost surfaces. GitHub returns more
 * states (`dirty`, `draft`, etc.); we collapse to the three that
 * matter for the auto-merge gate.
 *
 * `mergeable`    — would merge cleanly now.
 * `not_mergeable` — conflicts / failing required checks / branch protections block.
 * `unknown`      — host hasn't computed yet (GitHub: `null`).
 */
export const PR_MERGEABLE_STATES = ['mergeable', 'not_mergeable', 'unknown'] as const;
export type PrMergeableState = (typeof PR_MERGEABLE_STATES)[number];

/**
 * Per-host merge methods. `squash` is the v1 default per v5 §8.5;
 * the harness's `pr_reviewer_settings.merge_method` column carries
 * the per-harness preference.
 */
export const PR_MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export type PrMergeMethod = (typeof PR_MERGE_METHODS)[number];

/**
 * Author identity surfaced on a Pr. github_user_id is the
 * cross-rename stable id; login is display-only and may rename.
 */
export interface PrAuthor {
  github_user_id: number;
  github_login: string;
  avatar_url?: string;
}

/**
 * Reviewer surfaced on a Pr. Same shape as PrAuthor; separate type
 * to keep call-sites self-documenting.
 */
export type PrReviewer = PrAuthor;

/**
 * The neutral PR shape returned by PrHost. Mirrors the most-used
 * GitHub fields with snake_case + value-typed enums.
 *
 * Field naming convention: snake_case to match GitHub + the PG
 * mirror tables (`harness_feature_prs`) directly. The PrHost is the
 * boundary between host-API responses and PG/HYPERBEE rows; matching
 * field names keeps the mapping trivial.
 */
export interface Pr {
  ref: PrRef;
  state: PrState;
  title: string;
  body: string | null;
  /** GitHub head ref / GitLab source-branch. */
  head_ref: string;
  /** GitHub base ref / GitLab target-branch. */
  base_ref: string;
  /** Head commit SHA of the PR branch at last fetch. */
  head_sha: string;
  /** Merge commit SHA (only populated when state='merged'). */
  merge_commit_sha: string | null;
  author: PrAuthor;
  reviewers_requested: PrReviewer[];
  review_decision: PrReviewDecision;
  checks_state: PrChecksState;
  mergeable_state: PrMergeableState;
  /** Whether the PR is a draft. v5 §8.5 auto-merge ignores drafts. */
  is_draft: boolean;
  /** PR URL on the host (e.g. `https://github.com/...`).
   * Display-only. */
  url: string;
  /** Epoch ms of last update (host-reported). */
  updated_at: number;
}

/**
 * Arguments for `PrHost.openPr` per v5 §8.1.
 */
export interface OpenPrArgs {
  remote: string;
  title: string;
  body: string;
  head_ref: string;
  base_ref: string;
  draft?: boolean;
  /**
   * Cross-fork PR: the GitHub login that owns the fork the head branch lives
   * on. When set, the host sends `head: "<head_owner>:<head_ref>"` while keeping
   * `owner/repo` = the UPSTREAM repo (from `remote`) — i.e. a PR opened on the
   * upstream from a contributor's fork. Omit for a same-repo PR (`head_ref`
   * alone). Used by the non-collaborator code→PR path
   * (non-collaborator-join-fork-pr sub-project B): a contributor without
   * upstream write pushes to their fork and opens a cross-fork PR.
   */
  head_owner?: string;
}

/**
 * Arguments for `PrHost.postReview` per v5 §8.4 + auto-approve flow.
 */
export interface PostReviewArgs {
  ref: PrRef;
  event: PrReviewEvent;
  /** Optional body — when `event='approve'` this becomes the
   * approval comment ("Auto-approved by Papercusp — @alice in trust
   * list."). */
  body?: string;
}

export const PR_REVIEW_EVENTS = ['approve', 'request_changes', 'comment'] as const;
export type PrReviewEvent = (typeof PR_REVIEW_EVENTS)[number];

/**
 * Arguments for `PrHost.merge` per v5 §8.5 auto-merge.
 */
export interface MergePrArgs {
  ref: PrRef;
  method: PrMergeMethod;
  /** Override for the commit title; host defaults to PR title. */
  commit_title?: string;
  /** Override for the commit message body; host defaults to PR body. */
  commit_message?: string;
  /** Optional head-sha pin — refuse to merge if head moved. */
  expected_head_sha?: string;
}

/**
 * Arguments for `PrHost.getRepoFile` (PR-2 conventions loading).
 */
export interface GetRepoFileArgs {
  remote: string;
  /** Repo-root-relative path, e.g. `CONTRIBUTING.md` or `.github/CONTRIBUTING.md`. */
  path: string;
  /** Ref to read at (branch / tag / sha). Default: host default branch. */
  ref?: string;
}

/**
 * Arguments for `PrHost.listOpenPrs` per v5 §8.4 bulk poll.
 */
export interface ListOpenPrsArgs {
  remote: string;
  /** Page size. Default 100, max 100 (GitHub cap). */
  per_page?: number;
}

/**
 * The PrHost abstraction. v1 is GitHub via Octokit; v2+ adds
 * GitLab/Gitea/Bitbucket impls behind the same interface.
 *
 * Every method returns either a typed result or a `PrHostError`.
 * No method throws on host-API errors — failures are values, so
 * the poll daemon's retry / backoff logic can pattern-match
 * cleanly per v5 §8.4 audit M.
 */
/** Details used by the in-app viewer; patches absent on binary or oversized files. */
export interface PrFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}
export interface PrCommit { sha: string; message: string; author: string; url: string }
export interface PrDetailsData {
  pr: Pr;
  commits: PrCommit[];
  files: PrFile[];
  diff: string;
  diffTruncated: boolean;
  checks: Array<{ name: string; conclusion: string | null; status: string; url: string | null }>;
  /** The target tip observed alongside this detail snapshot. */
  targetSha: string;
}

export interface PrHost {
  /** Host identifier — `"github"` / `"gitlab"` / `"gitea"`. */
  readonly kind: PrHostKind;

  openPr(args: OpenPrArgs): Promise<PrHostResult<Pr>>;
  getPr(ref: PrRef): Promise<PrHostResult<Pr>>;
  /**
   * Fetch the PR's unified diff as text — the input the agent-reviewer
   * (PR-2) reads. Host-neutral: the GitHub impl asks for the `.diff`
   * media type; a future GitLab/Gitea impl maps to its own diff
   * endpoint. The returned string is the raw unified diff
   * (`diff --git …` hunks). Large diffs are the host's concern to cap;
   * call-sites that need a bound truncate the returned text.
   */
  getPrDiff(ref: PrRef): Promise<PrHostResult<string>>;
  /**
   * Fetch a single file's text from the repo at an optional ref (default:
   * the host's default branch). Returns a `not_found` error when the path
   * doesn't exist. OPTIONAL on the interface: the agent-reviewer (PR-2)
   * uses it to load repo conventions (CONTRIBUTING / AGENTS / CLAUDE) when
   * present; a host impl without it simply reviews without that context.
   * Kept optional so existing PrHost fakes don't have to implement it.
   */
  getRepoFile?(args: GetRepoFileArgs): Promise<PrHostResult<string>>;
  postReview(args: PostReviewArgs): Promise<PrHostResult<void>>;
  merge(args: MergePrArgs): Promise<PrHostResult<{ merge_commit_sha: string }>>;
  listOpenPrs(args: ListOpenPrsArgs): Promise<PrHostResult<Pr[]>>;
  /** Optional viewer capabilities; older hosts fail closed for unsupported actions. */
  listPrs?(args: ListOpenPrsArgs & { state: 'open' | 'closed' | 'all' }): Promise<PrHostResult<Pr[]>>;
  getPrDetails?(ref: PrRef): Promise<PrHostResult<PrDetailsData>>;
  closePr?(ref: PrRef): Promise<PrHostResult<void>>;
}

export const PR_HOST_KINDS = ['github', 'gitlab', 'gitea', 'bitbucket'] as const;
export type PrHostKind = (typeof PR_HOST_KINDS)[number];

/**
 * Discriminated result envelope. Every PrHost method returns this;
 * call-sites pattern-match on `ok` before consuming `data` / `error`.
 */
export type PrHostResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PrHostError };

/**
 * Typed error variants per v5 §8.4 audit M error handling.
 *
 *   `not_found`      — host returned 404 for the PR / repo.
 *   `unauthorized`   — host returned 401; OAuth token bad/expired.
 *   `forbidden`      — host returned 403 (non-rate-limit).
 *                      e.g. branch protections refuse the merge.
 *   `rate_limited`   — host returned 429 or `X-RateLimit-Remaining: 0`.
 *                      `retry_after_ms` carries the wait if known.
 *   `conflict`       — host returned 409 (e.g. head moved during
 *                      merge with expected_head_sha set).
 *   `validation`     — host returned 422 (bad args, missing fields).
 *   `server_error`   — host returned 5xx. Retryable.
 *   `network_error`  — local fetch failed (DNS, timeout, TLS).
 *                      Retryable.
 *   `unsupported`    — call-site asked for a feature the host
 *                      impl doesn't support (e.g. squash on a
 *                      host without squash-merge).
 */
export interface PrHostError {
  kind: PrHostErrorKind;
  /** Human-readable error message — surfaces in audit log + UI toast. */
  message: string;
  /** Host-side status code when available. */
  status?: number;
  /** Rate-limit retry-after window, populated for kind='rate_limited'. */
  retry_after_ms?: number;
  /** Per-field validation issues when kind='validation'. */
  field_errors?: Array<{ field: string; message: string }>;
}

export const PR_HOST_ERROR_KINDS = [
  'not_found',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'conflict',
  'validation',
  'server_error',
  'network_error',
  'unsupported',
] as const;
export type PrHostErrorKind = (typeof PR_HOST_ERROR_KINDS)[number];

/**
 * Convenience: build an ok-result. Reduces verbosity in impl code.
 */
export function ok<T>(data: T): PrHostResult<T> {
  return { ok: true, data };
}

/**
 * Convenience: build an error-result. Reduces verbosity in impl code.
 */
export function err(error: PrHostError): PrHostResult<never> {
  return { ok: false, error };
}

/**
 * Predicate: is this error transient + worth retrying? Auto-marks
 * the boundary the poll daemon uses for backoff vs giving up.
 */
export function isRetryableError(error: PrHostError): boolean {
  switch (error.kind) {
    case 'rate_limited':
    case 'server_error':
    case 'network_error':
      return true;
    case 'not_found':
    case 'unauthorized':
    case 'forbidden':
    case 'conflict':
    case 'validation':
    case 'unsupported':
      return false;
  }
}

/**
 * Predicate: should we surface a re-auth flow to the user? `true`
 * for 401-after-token-refresh-attempt; the poll daemon handles the
 * refresh attempt itself.
 */
export function isAuthError(error: PrHostError): boolean {
  return error.kind === 'unauthorized';
}

/**
 * Predicate: should the PR be marked `gone` per P-042f? `true` only
 * for 404 on a PR we previously had cached.
 */
export function isGoneError(error: PrHostError): boolean {
  return error.kind === 'not_found';
}

/**
 * Map a host-API status code to a PrHostErrorKind. The v1 GitHub
 * impl calls this from its catch-block to translate Octokit
 * `RequestError.status` into the neutral enum.
 *
 * Unknown statuses (anything not handled) map to `server_error` so
 * the daemon retries with backoff rather than fails open.
 */
export function statusToErrorKind(status: number): PrHostErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status < 600) return 'server_error';
  return 'server_error';
}

/**
 * Compose a stable display key for a PrRef. Used by audit log row
 * keys + URL fragments. Format:
 *
 *   <remote>#<number>
 */
export function composePrKey(ref: PrRef): string {
  return ref.remote + '#' + ref.number;
}

/**
 * Inverse of composePrKey. Returns null on any malformed input.
 */
export function parsePrKey(key: string): PrRef | null {
  if (typeof key !== 'string') return null;
  const idx = key.lastIndexOf('#');
  if (idx <= 0 || idx === key.length - 1) return null;
  const numStr = key.slice(idx + 1);
  const number = Number(numStr);
  if (!Number.isInteger(number) || number <= 0) return null;
  const remote = key.slice(0, idx);
  if (remote.length === 0) return null;
  return { remote, number };
}
