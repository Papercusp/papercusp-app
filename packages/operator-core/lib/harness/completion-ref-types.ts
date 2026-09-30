/**
 * completion-ref-types — types for the `completion_ref` JSONB
 * column on `harness_features_consolidated` per
 * papercusp-dogfood-v5 line 451 + §15 (the trust-tier-B verifier
 * surface).
 *
 * Types-only and PURE. No PG, no git, no Octokit.
 *
 * Sixteenth module in the dogfood-arc types-only spine.
 *
 * Per v5 line 451 + §15:
 *   completion_ref JSONB — {remote, branch, commit_sha, pr_url}
 *   populated when status → 'pending_done' or 'shipped'
 *
 * Used by:
 *   - The worker that writes it on push (when worker integration with
 *     completion_ref lands)
 *   - The P-016 verifier daemon (already shipped at commit `4b950a07`)
 *     which calls `git ls-remote` against {remote, branch} and checks
 *     the returned SHA against commit_sha
 *   - The Feature row + FeatureDetail UI (renders the tier-B ✓ badge
 *     + the PR link from pr_url)
 *
 * Why types-first: the verifier daemon at `completion-ref-verifier.ts`
 * parses completion_ref ad-hoc today; spelling out the shape +
 * predicate lets the parse path consume one validator + the worker's
 * write path produce a guaranteed-valid object. Stops "field gets
 * renamed mid-arc" + "verifier and writer disagree on whether pr_url
 * is required" classes of bug.
 */

/**
 * Wire-version of the completion_ref shape. Bumped together with the
 * `harness_features_consolidated.completion_ref` schema.
 */
export const COMPLETION_REF_SCHEMA_VERSION = 1 as const;
export type CompletionRefSchemaVersion = typeof COMPLETION_REF_SCHEMA_VERSION;

/**
 * The completion_ref payload. All four fields are required when the
 * worker writes it; the verifier rejects missing-field rows
 * (defensive against legacy / mid-migration writes).
 *
 * Field naming: snake_case matches the v5 spec verbatim.
 */
export interface CompletionRef {
  /** Git remote URL the worker pushed to. Format matches what
   * `git remote get-url <name>` returns — typically
   * `git@github.com:<owner>/<repo>.git` or HTTPS.
   *
   * The P-016 verifier daemon uses this in `git ls-remote <remote>
   * refs/heads/<branch>` to validate the SHA. */
  remote: string;

  /** Branch name on the remote where the work landed. The worker
   * typically pushes to its `user/<github_user_id>` branch; the
   * verifier checks `git ls-remote` against this. */
  branch: string;

  /** The commit SHA that resolves the feature. 40-char or 64-char
   * (SHA-1 / SHA-256) lowercase hex. Verifier compares this to
   * what `git ls-remote` returns for the branch. */
  commit_sha: string;

  /** PR URL on the host (e.g. https://github.com/.../pull/42). May
   * be the empty string when the feature was pushed direct to main
   * without a PR (rare, but allowed by the workflow). */
  pr_url: string;

  /** PR number on the host (e.g. 42 for /pull/42). Optional —
   * not all writers populate it (v5 line 451 omits it; §8.1
   * includes it). Verifier callers prefer pr_number when present
   * for stable display; otherwise extract from pr_url. */
  pr_number?: number;

  /** Wire-schema version of THIS payload. */
  schema_version: CompletionRefSchemaVersion;
}

/**
 * SHA-shape predicate. Accepts either SHA-1 (40 chars) or SHA-256
 * (64 chars) lowercase hex per git's transition plan. The verifier
 * compares case-insensitively when matching against `git ls-remote`
 * output but the canonical form is lowercase.
 */
export function isValidCommitSha(sha: string): boolean {
  if (typeof sha !== 'string') return false;
  if (sha.length !== 40 && sha.length !== 64) return false;
  return /^[0-9a-f]+$/.test(sha);
}

/**
 * Predicate for the URL portion. Allows empty (direct-to-main push)
 * but rejects malformed http(s) URLs.
 */
export function isValidPrUrl(pr_url: string): boolean {
  if (typeof pr_url !== 'string') return false;
  if (pr_url === '') return true; // direct-to-main push
  try {
    const u = new URL(pr_url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Structural predicate. Returns true if the JSON-parsed object
 * matches the CompletionRef shape exactly. Used by the verifier
 * daemon + every UI read path defensively.
 */
export function isCompletionRef(input: unknown): input is CompletionRef {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.remote !== 'string' || r.remote.length === 0) return false;
  if (typeof r.branch !== 'string' || r.branch.length === 0) return false;
  if (typeof r.commit_sha !== 'string' || !isValidCommitSha(r.commit_sha)) return false;
  if (typeof r.pr_url !== 'string' || !isValidPrUrl(r.pr_url)) return false;
  if (
    r.pr_number !== undefined &&
    (typeof r.pr_number !== 'number' || !Number.isInteger(r.pr_number) || r.pr_number <= 0)
  ) {
    return false;
  }
  if (r.schema_version !== COMPLETION_REF_SCHEMA_VERSION) return false;
  return true;
}

/**
 * Predicate: was this push direct-to-main (no PR)? Useful for the
 * UI to render either "via PR #42" or "direct push" instead of
 * showing an empty pr_url string.
 */
export function isDirectMainPush(ref: CompletionRef): boolean {
  return ref.pr_url === '';
}

/**
 * Build a fresh completion_ref payload. Used by the worker when it
 * stamps a feature as `pending_done`. Pure constructor — caller
 * supplies fields; throws TypeError on bad input rather than
 * silently writing invalid JSON.
 */
export function buildCompletionRef(args: {
  remote: string;
  branch: string;
  commit_sha: string;
  pr_url?: string;
  pr_number?: number;
}): CompletionRef {
  if (typeof args.remote !== 'string' || args.remote.length === 0) {
    throw new TypeError('remote required');
  }
  if (typeof args.branch !== 'string' || args.branch.length === 0) {
    throw new TypeError('branch required');
  }
  if (!isValidCommitSha(args.commit_sha)) {
    throw new TypeError('commit_sha must be 40 or 64 char lowercase hex');
  }
  const pr_url = args.pr_url ?? '';
  if (!isValidPrUrl(pr_url)) {
    throw new TypeError('pr_url must be empty or a valid http(s) URL');
  }
  if (args.pr_number !== undefined) {
    if (!Number.isInteger(args.pr_number) || args.pr_number <= 0) {
      throw new TypeError('pr_number must be a positive integer when supplied');
    }
  }
  const ref: CompletionRef = {
    remote: args.remote,
    branch: args.branch,
    commit_sha: args.commit_sha,
    pr_url,
    schema_version: COMPLETION_REF_SCHEMA_VERSION,
  };
  if (args.pr_number !== undefined) {
    ref.pr_number = args.pr_number;
  }
  return ref;
}

/**
 * Compose a stable display key for a completion_ref. Used by audit
 * log rows + URL fragments. Format:
 *
 *   <branch>@<commit_sha-first-7>
 *
 * E.g. `user/12345@abcdef1`. Short enough for compact UI rendering,
 * unambiguous within a single repo.
 */
export function composeCompletionRefKey(ref: CompletionRef): string {
  return ref.branch + '@' + ref.commit_sha.slice(0, 7);
}

/**
 * Predicate: do two completion_refs refer to the same git object?
 * `true` when the (remote, branch, commit_sha) tuple matches.
 * pr_url is descriptive metadata that can change after the fact
 * (e.g. PR re-opened) so it's not part of the identity check.
 */
export function isSameCompletion(a: CompletionRef, b: CompletionRef): boolean {
  return (
    a.remote === b.remote &&
    a.branch === b.branch &&
    a.commit_sha === b.commit_sha
  );
}
