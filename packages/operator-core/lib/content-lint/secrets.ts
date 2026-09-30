/**
 * The COMMIT-TIME secrets detector (EI-21230011589307899).
 *
 * WHY THIS EXISTS, and why it is at THIS seam. A credential-shaped blob that
 * reaches git history permanently freezes this pot's p2p egress: pot-git's
 * own-head publish guard scans every blob in `(baseline, head]`, its baseline
 * never advances past a refused range, and editing the file afterwards does not
 * remove the earlier blob. The ONLY escape is a path exemption. Three instances
 * in four days (2026-08-23 / 08-25 / 08-26), the last one froze egress ~51min
 * with 55 commits queued behind it.
 *
 * A WRITE-time guard already exists — the Claude Code PreToolUse secrets hook —
 * and it is sound: it blocked a live PEM-header write on 2026-08-26. But its
 * matcher is `Edit|Write|MultiEdit|mcp__.*__capability_(edit|write|multi_?edit)`.
 * Bash is absent, so a `sed -i`, a heredoc or a `>` redirect never invokes it —
 * and the stock Claude Code bypass-mode preamble actively steers agents onto
 * exactly that path. Extending the matcher to Bash was REJECTED: it would have
 * to parse redirects out of arbitrary shell, is high false-positive risk on
 * every bash call, and still misses non-agent writers (an external editor, a
 * script, a peer process).
 *
 * Scanning the WORKING TREE at COMMIT time is write-path-AGNOSTIC — it closes
 * the gap however the bytes arrived. It rides the existing git-sync content
 * guard, whose D-001 contract is precisely the shape this needs: quarantine the
 * offending FILE (exclude it from the commit, leave it on disk, escalate), never
 * stall the tree's commit. That settles the design fork recorded on the item — a
 * whole-commit refusal would silently strand an agent's work, which is arguably
 * worse than today's loud freeze.
 *
 * ⚠ THIS FILE MUST NEVER CONTAIN A LITERAL CREDENTIAL SHAPE. It is scanned like
 * any other source file, and a single explanatory comment carrying a bare PEM
 * header is enough to wedge the publish plane — that has happened, to a comment
 * on the exemption list itself (2026-07-20). Refer to rules by their id; never
 * reproduce what they match. The same rule governs this module's test suite,
 * which assembles every fixture at runtime for that reason.
 */
import {
  scanTextForSecrets,
  isFixtureFile,
  describeSecretFindings,
  type SecretFinding,
} from '../sync/pot-git/secrets-guard';
import { isPathExempt } from '../sync/pot-git/secrets-guard-exemptions';

/** How long a loaded exemption set is reused before it is re-read. Short enough
 *  that an agent registering an exemption to unblock its own commit sees it take
 *  effect on the next tick or two, long enough that a per-file scan is not a
 *  per-file query. */
export const EXEMPTION_CACHE_TTL_MS = 60_000;

/**
 * The findings that should BLOCK a commit for `file`.
 *
 * Two exemption layers, deliberately both consulted here rather than only one:
 *  - `isFixtureFile` — the STATIC set (the secrets scanner's own suite, the
 *    PreToolUse hook, this scanner's source). Compiled in, always available.
 *  - `exemptions` — the RUNTIME `secrets_guard_path_exemptions` rows that the
 *    publish guard already honours. Consulting them is not optional: a path
 *    exempted to unfreeze PUBLISH would otherwise be quarantined from COMMIT
 *    forever, trading one deadlock for another.
 */
export function findCommitBlockingSecrets(
  file: string,
  text: string,
  exemptions: ReadonlySet<string>,
): SecretFinding[] {
  if (isFixtureFile(file)) return [];
  if (isPathExempt(exemptions, file)) return [];
  return scanTextForSecrets(file, text);
}

/**
 * The human-readable error the content guard records on the offender, puts in
 * its escalation body, and hands to the fixer role.
 *
 * It names the REMEDY FIRST and in the right order, because the ordering is the
 * whole point of this message: the guard's predecessor (the publish-time
 * refusal) named only the exemption path, which is the heavier and riskier
 * remedy, and that is how the exemption surface grew. A credential stand-in in
 * a test is a NAMING choice, not a case for a security waiver.
 */
export function describeCommitBlockingSecrets(file: string, findings: readonly SecretFinding[]): string {
  const where = findings.map((f) => `${f.line} [${f.rule}]`).join('; ');
  return (
    `credential-shaped content would enter git history (${findings.length} finding(s) at line ${where}). ` +
    `This file is EXCLUDED from the commit and left on disk — fix it in place, do not retry the write. ` +
    `If this is a credential STAND-IN for a test, replace it with a low-entropy, role-named constant ` +
    `(the in-tree convention is NEVER_EMIT_MARKER = 'never-emit-me'; six social adapter suites use it with ` +
    `zero incidents) — the conformance check is a plain substring search, so a realistic-looking value buys ` +
    `nothing. Only if the file must genuinely carry credential shapes as fixtures, register the exact path: ` +
    `pot_git:secrets_exemptions { action:'add', path:'${file}', reason:'<why this is a false positive>' }. ` +
    `Detail: ${describeSecretFindings(findings as SecretFinding[])}`
  );
}

/** Loads the runtime exemption set for the active workspace. Injectable so this
 *  module unit-tests with no database. */
export type ExemptionLoader = () => Promise<ReadonlySet<string>>;

/** The production loader: resolve the active workspace, then read its rows.
 *  `loadSecretsGuardPathExemptions` already fails CLOSED to an empty set on any
 *  database error, and so does this — see `cachedExemptionLoader` for why an
 *  empty set is the correct failure direction at THIS seam. */
export const defaultExemptionLoader: ExemptionLoader = async () => {
  const [{ activeWorkspaceId }, { loadSecretsGuardPathExemptions }] = await Promise.all([
    import('../workspace-registry'),
    import('../sync/pot-git/secrets-guard-exemptions'),
  ]);
  return loadSecretsGuardPathExemptions(await activeWorkspaceId());
};

/**
 * Wrap a loader in a short-TTL cache.
 *
 * FAILURE DIRECTION, stated because it is the one judgement call in this module
 * and it is the opposite of the content guard's own: the guard FAILS OPEN (a
 * throwing detector is skipped and the file commits). That is right for a
 * detector whose miss costs a broken build. It is wrong here, because the two
 * failure modes are not symmetric:
 *   - exemptions unavailable, so we quarantine a file we should not: the file
 *     stays on disk, the escalation is loud, and the next tick commits it.
 *     Recoverable in minutes.
 *   - detector skipped, so a credential-shaped blob enters history: egress is
 *     frozen for the whole pot and NOTHING short of a path exemption clears it.
 *     Not recoverable by editing anything.
 * So a load failure yields an EMPTY exemption set (scan everything) rather than
 * an exception — an exception would reach the guard's fail-open path and commit
 * the blob, which is the outcome this module exists to prevent.
 */
export function cachedExemptionLoader(load: ExemptionLoader, nowMs: () => number = Date.now): ExemptionLoader {
  let cached: ReadonlySet<string> | null = null;
  let loadedAtMs = 0;
  let inFlight: Promise<ReadonlySet<string>> | null = null;
  return async () => {
    const now = nowMs();
    if (cached && now - loadedAtMs < EXEMPTION_CACHE_TTL_MS) return cached;
    // Collapse a burst of per-file scans in one tick onto a single read.
    inFlight ??= load()
      .then((set) => {
        cached = set;
        loadedAtMs = nowMs();
        return set;
      })
      .catch((): ReadonlySet<string> => new Set())
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
