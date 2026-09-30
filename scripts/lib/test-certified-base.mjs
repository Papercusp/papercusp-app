/**
 * test-certified-base.mjs — WI-42146 / P-047, the test-certified watermark.
 *
 * THE LOOP THIS BREAKS. `affected-tests.mjs` derives its diff base from
 * `origin/main`, and `origin/main` only fast-forwards when a green checkpoint
 * passes. So the SIZE of every gate run is coupled to the AGE of the outage:
 * main goes red -> the base stops moving -> more paths read as "affected" ->
 * runs get longer -> more likely to be preempted, time out, or lose their
 * verdict -> main stays red. Recovery cost grows with the outage, which is why
 * it never self-heals. Measured 2026-08-26: `changedPaths=4572 base=origin/main
 * baseBehind=3868 workspaces=75 tasks=105`, against `workspaces=5 tasks=23` for
 * an explicitly-scoped three-file change. The script's own comment recorded the
 * same degradation at 460 commits behind; we reached 3,868.
 *
 * THE FIX IS NOT TO NARROW THE RADIUS. The gate legitimately certifies the whole
 * candidate, and the selector itself is precise — one file selects 5 of 103
 * workspaces with correct reverse-dependency semantics (plan decision
 * green-main-fast-2026-08-25#D-029). The defect is that it conflates two
 * different facts: "tests are certified through sha X" and "main fast-forwarded
 * to sha X". Those come apart constantly — the streak that motivated this had
 * `failingTests: ["lint:tsc"]`, a NON-test gate leg, so the tests were never what
 * failed, yet every subsequent run re-ran the entire inflated radius anyway.
 *
 * So we keep our own watermark, advanced only when the affected-test LEG passes,
 * and diff against that. A git ref rather than a state file or a DB row: it is
 * git's own primitive for "a commit pointer", it is atomic, it needs no new
 * dependency inside a script the gate runs in an isolated checkout, and it cannot
 * drift out of sync with the objects it names.
 *
 * FAIL-SAFE IN ONE DIRECTION ONLY. Every branch that cannot be positively
 * verified returns `origin/main`, so the worst case of a missing, corrupt,
 * foreign, or stale watermark is today's behaviour. A silently NARROWED run would
 * under-test, and that is the one outcome that must be impossible here.
 *
 * This lives beside `affected-tests.mjs` rather than inside it so the decisions
 * are reachable by a test without a git fixture and without mutating the shared
 * checkout — the same split as `changed-path-provenance.mjs`.
 */

/** The ref holding the last sha whose affected-test leg passed in full. */
export const TEST_CERTIFIED_REF = "refs/papercusp/test-certified";

/** The base every unverifiable branch falls back to — today's behaviour. */
export const DEFAULT_BASE = "origin/main";

/** Set this env var to "0" to disable both reading and advancing the watermark. */
export const DISABLE_ENV = "AFFECTED_TEST_CERTIFIED_BASE";

/**
 * Flags that mean "the caller narrowed this run", so it measured less than its
 * own full derived radius and must never certify anything.
 *
 * Kept in sync with `VALUE_FLAGS` in affected-tests.mjs by
 * `affected-tests-test-certified-base.test.ts`, which reads both and compares —
 * a hand-copied list is exactly the drift this repo's derived-truth ladder warns
 * about, and here a stale copy silently re-opens the false-certification hole.
 */
export const SCOPE_FLAGS = Object.freeze(["--changed-paths", "--range-from", "--range-to"]);

/**
 * Did the caller scope this run?
 *
 * MUST mirror the CLI's own argv normalisation. `affected-tests.mjs` puts
 * `--changed-paths` in `VALUE_FLAGS` and splits `--flag=value` into two tokens
 * before parsing, so `--changed-paths=foo/bar` is a fully supported scoped
 * invocation. A plain `argv.includes("--changed-paths")` against RAW argv answers
 * FALSE for that form — which would let a one-file run advance the watermark and
 * certify the entire tree from `RUN_START_HEAD`. That is the single mistake in
 * this whole feature that would actually corrupt a later run's radius, so the
 * splitting is reproduced here rather than approximated.
 *
 * @param {readonly string[]} argv Raw `process.argv` (or any token list).
 * @returns {boolean} True when any scope-narrowing flag is present, either form.
 */
export function isScopedInvocation(argv) {
  if (!Array.isArray(argv)) return false;
  for (const token of argv) {
    if (typeof token !== "string") continue;
    const equals = token.indexOf("=");
    const flag = equals > 0 ? token.slice(0, equals) : token;
    if (SCOPE_FLAGS.includes(flag)) return true;
  }
  return false;
}

/**
 * Resolve the diff base, preferring the watermark but only when it is provably
 * safe to do so.
 *
 * Both ancestry checks are load-bearing:
 *   - the watermark must be an ANCESTOR OF HEAD, or its diff describes a history
 *     this checkout is not on (a rebase, a force-push, another pot's ref);
 *   - `origin/main` must be an ancestor of the WATERMARK, i.e. the watermark is
 *     at-or-ahead of main. If it is behind, main already gives the smaller radius
 *     and we take it. This is what makes the watermark able only ever to SHRINK a
 *     run relative to today, never to grow it.
 *
 * @param {object} [deps]
 * @param {(argv: string[]) => string | null} [deps.git] Read-only git runner returning
 *   trimmed stdout, or `null` for ANY failure. Every `null` sends us to the default.
 *   OPTIONAL on purpose: a caller that supplies none gets the `no-git-runner` fallback
 *   rather than a throw, so a mis-wire degrades to today's base instead of killing a
 *   green run. Declaring it required would make the type lie about that.
 * @param {Record<string, string | undefined>} [deps.env] Environment to read the
 *   kill-switch from.
 * @returns {{ base: string, source: 'default' | 'watermark', sha: string | null, reason: string }}
 *   `reason` names the branch taken. It exists so a test can tell a working guard
 *   apart from a function that merely always returns `origin/main` — without it
 *   every negative case is indistinguishable from total breakage.
 */
export function resolveTestCertifiedBase({ git, env = {} } = {}) {
  const fallback = (reason) => ({ base: DEFAULT_BASE, source: "default", sha: null, reason });

  if (env[DISABLE_ENV] === "0") return fallback("disabled");
  if (typeof git !== "function") return fallback("no-git-runner");

  const sha = git(["rev-parse", "--verify", "--quiet", `${TEST_CERTIFIED_REF}^{commit}`]);
  if (!sha) return fallback("no-watermark");

  // `merge-base --is-ancestor` signals via exit status; the runner maps a non-zero
  // exit to null, so `null` here means "not an ancestor" OR "git could not tell us".
  // Both are unverified, and unverified means fall back.
  if (git(["merge-base", "--is-ancestor", sha, "HEAD"]) === null) {
    return fallback("not-ancestor-of-head");
  }
  if (git(["merge-base", "--is-ancestor", DEFAULT_BASE, sha]) === null) {
    return fallback("behind-default-base");
  }

  return { base: sha, source: "watermark", sha, reason: "watermark" };
}

/**
 * The stderr line announcing a non-default radius. A run whose scope came from
 * somewhere other than the documented default must never be a silent difference
 * to whoever reads the log later.
 *
 * @param {{ sha: string }} resolved
 * @returns {string}
 */
export function baseSourceLine({ sha }) {
  return (
    `AFFECTED_BASE_SOURCE ref=${TEST_CERTIFIED_REF} sha=${String(sha).slice(0, 12)} ` +
    `(test-certified watermark, at-or-ahead of ${DEFAULT_BASE}; set ${DISABLE_ENV}=0 to disable)`
  );
}

/**
 * May this run advance the watermark?
 *
 * Refuses every run that measured less than its own full derived radius, and
 * every run that did not finish cleanly. `undetermined` and `timedOut` are
 * refusals in their own right and not folded into `failed`: a task whose verdict
 * was never established is precisely the case where "no failures were reported"
 * must not be read as "everything passed".
 *
 * @param {object} input
 * @param {Record<string, string | undefined>} [input.env]
 * @param {readonly string[]} [input.argv] Raw argv, checked for scope flags.
 * @param {boolean} [input.failed] Any gating task failed.
 * @param {boolean} [input.undeterminedTasks] Any task's verdict was not established.
 * @param {boolean} [input.timedOutTasks] Any task timed out.
 * @param {string | null} [input.runStartHead] The sha the run STARTED at. Never
 *   current HEAD: git-sync commits this shared tree continuously, so HEAD has very
 *   likely moved during a run this long, and certifying it would vouch for commits
 *   no task ever saw.
 * @returns {{ advance: boolean, sha: string | null, reason: string }}
 */
export function decideWatermarkAdvance({
  env = {},
  argv = [],
  failed = false,
  undeterminedTasks = false,
  timedOutTasks = false,
  runStartHead = null,
} = {}) {
  const refuse = (reason) => ({ advance: false, sha: null, reason });

  if (env[DISABLE_ENV] === "0") return refuse("disabled");
  if (isScopedInvocation(argv)) return refuse("scoped");
  if (failed) return refuse("failed");
  if (undeterminedTasks) return refuse("undetermined");
  if (timedOutTasks) return refuse("timed-out");
  if (!runStartHead) return refuse("no-run-start-head");

  return { advance: true, sha: runStartHead, reason: "advance" };
}
