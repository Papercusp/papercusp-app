import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { staticImportClosure } from "./related-tests.mjs";

export const PASSING_TASK_VERDICT_CACHE_VERSION = 2;
export const PASSING_TASK_VERDICT_IMPLEMENTATION_VERSION =
  "affected-passing-task-verdict-v6";
export const PASSING_TASK_VERDICT_CACHE_MAX_GROUPS = 32;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function normalize(value) {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(normalize(value));
}

/**
 * Build the environment component used ONLY by the passing-task cache identity.
 *
 * A frozen-repair verifier must retain its own PAPERCUSP_TEST_RUN_GROUP in the real child
 * environment so reporters, watchdogs, and diagnostics describe this verifier process. The
 * initial gate run's group is supplied separately through AFFECTED_TASK_VERDICT_PROOF_GROUP;
 * substituting it in this cloned identity environment lets unchanged tasks compare against the
 * original proof without falsifying the environment the child actually receives.
 *
 * Missing or malformed proof state leaves the current run group in place, which deliberately
 * makes a later verifier miss. The transport-only proof variable is never itself hashed: it was
 * absent from the initial run and would otherwise invalidate the identity it exists to recover.
 */
/**
 * pc-heavy wrapper variables that are UNIQUE PER INVOCATION and therefore must never enter the
 * cache identity. Each one describes the wrapper process, not the test task, so hashing it makes
 * every run's `environment` component differ and defeats reuse entirely.
 *
 * This list is a second copy of a truth `scripts/pc-heavy.sh` owns, so it WILL drift — it already
 * did. `affected-tests-passing-verdict-cache.test.ts` DERIVES the volatile set by parsing
 * pc-heavy.sh for exports whose value resolves to `$$`, `$RANDOM`, `$BASHPID`, `date +%s*`, or
 * `mktemp`, and fails if any is missing here. Add names by making that guard pass, never by hand
 * alone.
 *
 * EI-21748784988454958: `PC_HEAVY_ADMISSION_ID` is `pc-heavy-$$-$(date +%s%N)` — pid plus
 * nanoseconds, exported into every child (pc-heavy.sh:2774). Because it was absent here, the
 * `environment` component differed on EVERY invocation and cross-run reuse could NEVER hit
 * through pc-heavy — defeating both the root `npm test` resume path (package.json:175) and the
 * pre-existing green-checkpoint reuse of EI-21577710345620735.
 */
export const PC_HEAVY_VOLATILE_IDENTITY_ENV = Object.freeze([
  "PC_HEAVY_PREEMPT_READY_FILE",
  "PC_HEAVY_PREEMPT_RESULT_FILE",
  "PC_HEAVY_CALLER_PID",
  "PC_HEAVY_CALLER_START_TICKS",
  "PC_HEAVY_PREEMPT_NOTIFY_FD",
  // EI-21748784988454958 — each unique per invocation; see the note above.
  "PC_HEAVY_ADMISSION_ID",
  "PC_HEAVY_PSI_FINALIZATION_FILE",
  "PC_HEAVY_PREEMPT_START_FILE",
  // WI-1024071 live Run C -> D: conditionally present for focused/preempt paths. Its value
  // selects wrapper scheduling only; it never changes the admitted task's command or inputs.
  "PC_HEAVY_PREEMPT_EXCLUSIVE",
]);

/**
 * WI-10003603 — per-invocation transport paths that affected-tests itself stamps into a task's
 * child env. `PC_EXECUTED_SOURCE_MAP_RESULT` names a result file unique to this runner process
 * (run token + task), where the executed-source-map reporter says what its flush did. It is an
 * output channel, never a task input, and hashing it would make a frozen-repair verifier's
 * per-run identity miss against the original gate run's proof on the path alone.
 */
export const AFFECTED_TESTS_TRANSPORT_IDENTITY_ENV = Object.freeze([
  "PC_EXECUTED_SOURCE_MAP_RESULT",
]);

export function passingTaskVerdictIdentityEnvironment(environment) {
  const identityEnvironment = { ...(environment ?? {}) };
  for (const transportName of AFFECTED_TESTS_TRANSPORT_IDENTITY_ENV) {
    delete identityEnvironment[transportName];
  }
  const rawProofGroup = identityEnvironment.AFFECTED_TASK_VERDICT_PROOF_GROUP;
  const proofGroup =
    typeof rawProofGroup === "string" && rawProofGroup.trim() !== ""
      ? rawProofGroup
      : null;
  delete identityEnvironment.AFFECTED_TASK_VERDICT_PROOF_GROUP;
  // These values describe the pc-heavy wrapper process, not the test task. Every fresh retry gets
  // a new ready-marker path, caller PID/start tick, and notify fd; hashing them would make the
  // explicitly shared proof group miss on environment identity and silently defeat resumability.
  // They remain untouched in the REAL child environment — this clone is cache identity only.
  for (const transportName of PC_HEAVY_VOLATILE_IDENTITY_ENV) {
    delete identityEnvironment[transportName];
  }
  if (proofGroup !== null) {
    identityEnvironment.PAPERCUSP_TEST_RUN_GROUP = proofGroup;
  }
  const rawCacheGroup = identityEnvironment.PAPERCUSP_TEST_RUN_GROUP;
  const cacheGroup =
    typeof rawCacheGroup === "string" && rawCacheGroup.trim() !== ""
      ? rawCacheGroup.trim().slice(0, 256)
      : null;
  return {
    environment: identityEnvironment,
    proofGroupApplied: proofGroup !== null,
    cacheGroup,
  };
}

/**
 * The single stable group every passing verdict is ALSO written under, so a task proven green in
 * gate run N can be reused in run N+1. The per-run group above deliberately confines reuse to one
 * run; that is correct for the *identity* of a run, but it is also the whole reason a red gate
 * re-tests the ~100 tasks that already passed. See EI-21577710345620735.
 *
 * Reuse is NOT widened by this group: a cross-run hit still has to match the FULL identity —
 * taskKey, command, gateConfig, implementation version, and above all `dependencyHash`, which is
 * the content sha256 of every file in the task's dependency closure. "Nothing this task reads has
 * changed" is the actual claim being made, and it is content-addressed, not sha-range guesswork.
 */
export const PASSING_TASK_VERDICT_CROSS_RUN_GROUP = "cross-run-v1";

/**
 * Identity environment for the CROSS-RUN group.
 *
 * Same clone as `passingTaskVerdictIdentityEnvironment`, minus the values that necessarily differ
 * between two runs of the same unchanged task. Each removal below is load-bearing: leave any one
 * of them in and the cross-run identity can never match, which does not fail loudly — it silently
 * degrades to "no reuse", i.e. exactly the deadlock this exists to break.
 *
 *   PAPERCUSP_TEST_RUN_GROUP    — the run identity itself; keeping it IS the one-run confinement.
 *   AFFECTED_TASK_VERDICT_*     — transport/proof plumbing, absent from the run being compared to.
 *   VITEST_MAX_WORKERS/FORKS/THREADS — the scheduler's per-task concurrency allocation. These
 *     describe HOW the task was scheduled (capacity mode, live load), never WHAT it exercised, and
 *     they change run to run on a busy box. This is the same reasoning the per-run identity already
 *     applies to the PC_HEAVY_* transport variables.
 *
 * Deliberately still hashed when present: AFFECTED_BASE. Some repo-wide guards consume the base
 * directly, so the generic identity cannot assume it is selection-only. The affected-test runner
 * instead removes it from the REAL child environment of ordinary reusable workspace tasks, where
 * source census proves it is not a task input; base-dependent guard tasks retain it (WI-1024071).
 */
/**
 * WI-595883 — shell bookkeeping, measured as a live third defeater.
 *
 * These three are written by the SHELL to describe the invocation, never the task. `OLDPWD` was
 * caught red-handed: two otherwise identical runs of the same unchanged task missed with
 * `environment-changed` for the single reason that one shell had run `cd` and the other had not.
 * `_` (bash's last-argument) and `SHLVL` (nesting depth) differ on essentially every invocation
 * for the same reason, so leaving them hashed makes reuse depend on how the caller happened to
 * type the command.
 *
 * The conservative-by-default stance on the rest of the environment is deliberate and unchanged.
 * The argument for these three is not "probably irrelevant" — it is that they are DEFINED as
 * properties of the calling shell, so no test outcome can depend on them without depending on who
 * typed the command. `affected-tests-passing-verdict-cache.test.ts` fails if one is re-admitted.
 */
export const SHELL_VOLATILE_IDENTITY_ENV = Object.freeze([
  "OLDPWD",
  "_",
  "SHLVL",
]);

/**
 * EI-21762403020037943 — launcher-seam markers, the same defeater one level up from the shell.
 *
 * `capability:bash` stamps these into every child it spawns. They describe WHICH DOOR the command
 * was typed through — the task id the operator minted for this job, whether it went through the
 * foreground or background seam, and with what caller timeout — never what the command exercises.
 * So the argument is the one `SHELL_VOLATILE_IDENTITY_ENV` already makes, not a weaker "probably
 * irrelevant": a test outcome cannot depend on them without depending on who launched it.
 *
 * Measured, not assumed. `PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID` is a fresh enrolment task
 * id per background job (`bash-jobs.ts:1445`), so an agent measuring cross-run reuse the only way
 * it can — two separate `capability:bash` jobs — ALWAYS missed with `cross-run:environment-changed`.
 * A healthy cache was indistinguishable from a broken one from outside. Corroborated live by a
 * grader's ENV_DELTA on 2026-08-29: `changed=1 changedKeys=[PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID]`.
 *
 * The green-checkpoint gate never saw this: it runs under systemd/pc-heavy, which does not stamp
 * these names. That is precisely why it went unnoticed — the defeater only fires on the measuring
 * path, so it corrupted the INSTRUMENT while leaving the instrumented system healthy.
 *
 * This list is a second copy of a truth the `capability:bash` seam owns, so it WILL drift — every
 * future launcher that stamps a unique id into the child env re-introduces the bug until its name
 * lands here. `affected-tests-passing-verdict-cache.test.ts` DERIVES the set by parsing
 * `bash-jobs.ts` for the env-name constants that seam exports, and fails if any is missing here or
 * if a child-env stamp appears that the derivation cannot account for. Add names by making that
 * guard pass, never by hand alone.
 *
 * Scoped to the CROSS-RUN identity on purpose. Within one run the seam cannot drift, and the
 * per-run group is confined to that run anyway — the same reasoning that keeps the shell-volatile
 * names in the per-run identity.
 */
export const CAPABILITY_BASH_SEAM_IDENTITY_ENV = Object.freeze([
  "PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID",
  "PAPERCUSP_CAPABILITY_BASH_FOREGROUND",
  "PAPERCUSP_CAPABILITY_BASH_FOREGROUND_TIMEOUT_MS",
  "PC_HEAVY_DURABLE_CALLER",
]);

/**
 * Cross-run proof identity is RELATED-INPUT identity, not PROCESS identity.
 *
 * The product invariant is direct: once a task passes, do not execute it again unless its
 * command or related-file closure changed. The inherited environment describes the caller,
 * terminal, gate scheduling, load, credentials, and wrapper mechanics. Hashing that ambient
 * process state made unchanged tasks rerun on every invocation; subtracting individual volatile
 * names merely moved the miss to the next undiscovered variable.
 *
 * Task semantics remain fail-closed in the task-owned identity components:
 *   - `command` binds argv, cwd, and the package script text;
 *   - `implementationVersion` binds this proof mechanism; and
 *   - `dependencyHash` binds every related workspace, dependency, runner, and test-config file.
 * Resolved execution policy is caller state too; the files that define that policy are already
 * part of `dependencyHash`.
 *
 * A future task that intentionally depends on an environment value must declare it into one of
 * those task-owned inputs. Ambient inheritance is never an implicit reason to rerun every green
 * task. The real child environment is untouched; this empty object exists only in cache identity.
 */
export function passingTaskVerdictCrossRunIdentityEnvironment(_environment) {
  return {
    environment: {},
    cacheGroup: PASSING_TASK_VERDICT_CROSS_RUN_GROUP,
  };
}

/**
 * The gateConfig analogue of `passingTaskVerdictCrossRunIdentityEnvironment`: resolved gate,
 * retry, timeout, load, capture, and resource values describe HOW this invocation runs, not the
 * command or related-file closure the passing proof covers. Several values are also
 * SELF-INVALIDATING — they move between two runs over a byte-identical tree, so retaining any of
 * them makes cross-run reuse structurally unable to hit rather than merely rare.
 *
 * - `affectedBase` is the SELECTION RADIUS: it decides which tasks get picked, never what a
 *   picked task exercises, and an unpinned local run derives it from the moving test-certified
 *   watermark.
 * - `batchTimeout.effectiveMs`/`.source` are DERIVED FROM DURATION HISTORY
 *   (`timeoutDurationEstimate`), so every run moves the next run's value. Measured: one run hit
 *   `cross-run:identity-match` and the byte-identical next run missed with `gate-config-changed`
 *   purely because the first had recorded a duration.
 * - `retryFailed` is resolved from caller override + live load. A stored verdict necessarily came
 *   from a clean first pass, so whether a failure WOULD have received an absorption retry cannot
 *   change what that pass proved; retaining it only makes load/caller drift invalidate the proof.
 *
 * Validity is decided by `command`, `implementationVersion`, and `dependencyHash` — the latter is
 * the content sha256 of the task's whole related-file closure, including the runner/config files
 * that define these policies. Normalising the resolved object therefore does not widen what a
 * stored verdict claims. FAIL-SAFE DIRECTION: a task that exceeds its bound FAILS, and a failed
 * task never stores a passing verdict, so admitting a stored PASS under a different resolved
 * bound cannot turn a red into a green.
 */
export function passingTaskVerdictCrossRunGateConfig(_gateConfig) {
  // Resolved timeouts, worker budgets, retry/load policy, capture mode, and selection radius
  // describe HOW this invocation runs. The runner/config FILES that define those policies are
  // already bound by dependencyHash. Ambient resolved values must not rerun a previously green
  // task when its command and related files are unchanged.
  return {};
}

/** One bounded, machine-readable composite cache verdict for gate logs. */
export function formatPassingTaskVerdictSummary(
  decisions,
  { proofGroupApplied = false, cacheGroup = null, cacheScope = null } = {},
) {
  let hits = 0;
  let misses = 0;
  const reasons = new Map();
  for (const decision of decisions ?? []) {
    if (decision?.status === "hit") hits += 1;
    else if (decision?.status === "miss") misses += 1;
    else continue;
    const reason =
      typeof decision.reason === "string" && decision.reason
        ? decision.reason
        : "unknown";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const reasonCounts = Object.fromEntries(
    [...reasons.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const proofIdentity =
    cacheScope === "cross-run"
      ? "cross-run"
      : proofGroupApplied
        ? "initial-run"
        : "current-run";
  const scopeSuffix = cacheScope ? ` scope=${cacheScope}` : "";
  return (
    `AFFECTED_TASK_CACHE_SUMMARY hits=${hits} misses=${misses} ` +
    `proofIdentity=${proofIdentity} ` +
    `group=${cacheGroup ? sha256(cacheGroup).slice(0, 12) : "missing"}${scopeSuffix} ` +
    `reasons=${JSON.stringify(reasonCounts)}`
  );
}

/**
 * Preserve which cache layer made a decision without coupling observability to
 * the outcome. Misses are the diagnostic path operators need most, so callers
 * must namespace both hits and misses rather than decorating successful reuse
 * only.
 */
export function namespacePassingTaskVerdictDecision(decision, namespace) {
  const reason =
    typeof decision?.reason === "string" && decision.reason
      ? decision.reason
      : decision?.hit
        ? "hit"
        : "miss";
  return {
    ...decision,
    reason: `${namespace}:${reason}`,
  };
}

export function emptyPassingTaskVerdictCache() {
  return { version: PASSING_TASK_VERDICT_CACHE_VERSION, groups: {} };
}

/**
 * Read fail-closed: malformed, incomplete, or version-skewed state is an empty cache with an
 * operator-visible reason. A cache file can only save work; it never gets to block the gate.
 */
export function readPassingTaskVerdictCache(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== PASSING_TASK_VERDICT_CACHE_VERSION) {
      return {
        cache: emptyPassingTaskVerdictCache(),
        reason: "cache-version-mismatch",
      };
    }
    if (!parsed.groups || typeof parsed.groups !== "object" || Array.isArray(parsed.groups)) {
      return {
        cache: emptyPassingTaskVerdictCache(),
        reason: "cache-shape-invalid",
      };
    }
    for (const group of Object.values(parsed.groups)) {
      if (
        !group ||
        typeof group !== "object" ||
        Array.isArray(group) ||
        typeof group.updatedAt !== "string" ||
        !group.entries ||
        typeof group.entries !== "object" ||
        Array.isArray(group.entries)
      ) {
        return {
          cache: emptyPassingTaskVerdictCache(),
          reason: "cache-shape-invalid",
        };
      }
    }
    return { cache: parsed, reason: "cache-ready" };
  } catch (error) {
    return {
      cache: emptyPassingTaskVerdictCache(),
      reason: error?.code === "ENOENT" ? "cache-file-missing" : "cache-corrupt",
    };
  }
}

/** Read one task verdict from the immutable candidate proof group that produced it. */
export function passingTaskVerdictCacheEntry(cache, cacheGroup, taskKey) {
  if (typeof cacheGroup !== "string" || cacheGroup.trim() === "") return undefined;
  return cache?.groups?.[cacheGroup]?.entries?.[taskKey];
}

/** Write via same-directory rename so a reader observes the old complete file or the new one. */
export function writePassingTaskVerdictCacheAtomic(
  path,
  cache,
  nonce = `${process.pid}-${Date.now()}`,
) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${nonce}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function digestFile(root, file, digestCache) {
  if (typeof file !== "string" || !file || isAbsolute(file)) {
    return { ok: false, reason: "provenance-incomplete:invalid-path" };
  }
  const abs = resolve(root, file);
  const back = relative(root, abs);
  if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    return {
      ok: false,
      reason: `provenance-incomplete:path-escaped-root:${file}`,
    };
  }
  if (digestCache?.has(abs)) return { ok: true, ...digestCache.get(abs) };
  try {
    const stat = lstatSync(abs);
    let kind;
    let content;
    if (stat.isSymbolicLink()) {
      kind = "symlink";
      content = Buffer.from(readlinkSync(abs));
    } else if (stat.isFile()) {
      kind = "file";
      content = readFileSync(abs);
    } else {
      return {
        ok: false,
        reason: `provenance-incomplete:unsupported-file-type:${file}`,
      };
    }
    const value = {
      kind,
      mode: stat.mode & 0o777,
      digest: sha256(content),
    };
    digestCache?.set(abs, value);
    return { ok: true, ...value };
  } catch {
    return {
      ok: false,
      reason: `provenance-incomplete:unreadable-file:${file}`,
    };
  }
}

/**
 * Hash the exact paths, file kinds/modes, and bytes in a task's dependency closure. Callers pass
 * any known enumeration gaps via `unavailable`; uncertainty is a miss rather than a smaller hash.
 */
export function hashDependencyFileSet({
  root,
  files,
  unavailable = [],
  digestCache = new Map(),
}) {
  if (unavailable.length > 0) {
    return {
      ok: false,
      reason: `provenance-incomplete:unscanned-submodule:${[...unavailable].sort()[0]}`,
    };
  }
  const unique = [...new Set(files)].sort();
  if (unique.length === 0) {
    return {
      ok: false,
      reason: "provenance-incomplete:empty-dependency-closure",
    };
  }
  const hash = createHash("sha256");
  hash.update("passing-task-dependency-closure-v1\0");
  // WI-595883: the MEMBERSHIP hash is kept separate from the content hash on purpose. A closure
  // whose file LIST moved and a closure whose file BYTES moved both change `hash` identically,
  // so the single aggregate cannot tell an agent which of the two happened — and those two have
  // opposite repairs (exclude a churning path vs. investigate a digest). Two hashes discriminate
  // them for ~64 bytes per task.
  const listHash = createHash("sha256");
  listHash.update("passing-task-dependency-closure-list-v1\0");
  for (const file of unique) {
    const digest = digestFile(root, file, digestCache);
    if (!digest.ok) return digest;
    listHash.update(file);
    listHash.update("\0");
    hash.update(file);
    hash.update("\0");
    hash.update(digest.kind);
    hash.update("\0");
    hash.update(String(digest.mode));
    hash.update("\0");
    hash.update(digest.digest);
    hash.update("\0");
  }
  return {
    ok: true,
    hash: hash.digest("hex"),
    listHash: listHash.digest("hex"),
    fileCount: unique.length,
    // The sorted closure itself, so a `dependency-closure-changed` miss can be diffed against the
    // previous run's observations WITHOUT re-deriving the closure. These are the same string
    // objects already held by the tracked scan, so retaining them costs references, not bytes.
    files: unique,
  };
}

// ---------------------------------------------------------------------------
// WI-595883 — closure-delta diagnostics.
//
// `dependency-closure-changed` is emitted whenever the closure component of the identity moved,
// and on its own it is UNACTIONABLE: it says a hash differs, not which of ~1,100 files caused it.
// On a shared tree that peers edit continuously, that one string is equally consistent with
// "a peer touched scripts/" (environmental, repair = narrow the closure) and with "the digest is
// unstable" (a bug, repair = fix the hash). The sidecar below records what each run OBSERVED, so
// the next run's miss can name the moved path instead of leaving the reader to guess.
//
// It is a SIDECAR, not an entry field, because closure digests are shared across every task in a
// run: one global map costs ~100KB, while the same data per-entry would cost tens of megabytes.
// It can only ever produce a better error message, so every read of it fails open.
// ---------------------------------------------------------------------------

export const CLOSURE_DIGEST_MANIFEST_VERSION = 1;
/** Bounds the sidecar for a repo-wide guard task, whose closure is the entire tracked tree. */
export const CLOSURE_DIGEST_MANIFEST_MAX_FILES = 40000;

export function closureDigestManifestPath(cachePath) {
  return `${cachePath}.closure-manifest.json`;
}

export function emptyClosureDigestManifest() {
  return {
    version: CLOSURE_DIGEST_MANIFEST_VERSION,
    updatedAt: null,
    files: {},
    tasks: {},
    // cacheGroup -> { key: digest }. One record per group, not per task: the identity environment
    // is the same for every task in a run, so this costs a few KB rather than a few MB.
    identityEnv: {},
  };
}

/** The full identity of one file AS THE CLOSURE HASH SEES IT — kind and mode included. */
export function closureDigestToken({ kind, mode, digest }) {
  return `${kind}:${mode}:${digest}`;
}

/**
 * Project the run's `digestCache` (absolute path keys) into repo-relative observations.
 * Anything outside the root is dropped rather than recorded under an ambiguous key.
 */
export function observedClosureDigests(root, digestCache) {
  const observed = {};
  for (const [abs, value] of digestCache ?? []) {
    if (!value || value.ok === false) continue;
    const rel = relative(root, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    observed[rel.split(sep).join("/")] = closureDigestToken(value);
  }
  return observed;
}

export function readClosureDigestManifest(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed?.version !== CLOSURE_DIGEST_MANIFEST_VERSION ||
      !parsed.files ||
      typeof parsed.files !== "object" ||
      Array.isArray(parsed.files)
    ) {
      return {
        manifest: emptyClosureDigestManifest(),
        reason: "manifest-unusable",
      };
    }
    return {
      manifest: {
        ...emptyClosureDigestManifest(),
        ...parsed,
        tasks:
          parsed.tasks && typeof parsed.tasks === "object" && !Array.isArray(parsed.tasks)
            ? parsed.tasks
            : {},
        identityEnv:
          parsed.identityEnv &&
          typeof parsed.identityEnv === "object" &&
          !Array.isArray(parsed.identityEnv)
            ? parsed.identityEnv
            : {},
      },
      reason: "manifest-ready",
    };
  } catch (error) {
    return {
      manifest: emptyClosureDigestManifest(),
      reason: error?.code === "ENOENT" ? "manifest-missing" : "manifest-corrupt",
    };
  }
}

/**
 * Fold this run's observations over the prior ones. A file the current run did not digest KEEPS
 * its last observed value: the sidecar answers "what was this path when anyone last looked", and
 * a narrow run must not erase a wide run's record. Newest observations win the size cap.
 */
export function mergeClosureDigestManifest({
  prior,
  observed,
  taskShapes = {},
  identityEnv = {},
  updatedAt = new Date().toISOString(),
  cap = CLOSURE_DIGEST_MANIFEST_MAX_FILES,
}) {
  const files = { ...(prior?.files ?? {}), ...observed };
  const observedKeys = new Set(Object.keys(observed));
  let retained = files;
  const names = Object.keys(files);
  if (names.length > cap) {
    // Evict paths this run did not observe first; they are the least likely to be asked about.
    const ordered = [
      ...names.filter((name) => observedKeys.has(name)),
      ...names.filter((name) => !observedKeys.has(name)),
    ].slice(0, cap);
    retained = Object.fromEntries(ordered.map((name) => [name, files[name]]));
  }
  return {
    version: CLOSURE_DIGEST_MANIFEST_VERSION,
    updatedAt,
    files: retained,
    tasks: { ...(prior?.tasks ?? {}), ...taskShapes },
    identityEnv: { ...(prior?.identityEnv ?? {}), ...identityEnv },
  };
}

/**
 * Explain one `dependency-closure-changed` miss.
 *
 * Membership is checked FIRST because it subsumes content: if the file list moved, per-file
 * digests are the wrong question. `unknownPrior` is deliberately distinct from `changed` — a path
 * absent from the sidecar was never observed, which is not evidence that it moved.
 */
export function diffClosureDigests({
  prior,
  observed,
  files,
  listHash,
  taskKey,
  limit = 8,
}) {
  const priorFiles = prior?.files ?? {};
  const priorShape = taskKey ? prior?.tasks?.[taskKey] : undefined;
  const membershipChanged =
    priorShape != null &&
    typeof priorShape.listHash === "string" &&
    typeof listHash === "string" &&
    priorShape.listHash !== listHash;
  const changed = [];
  const unknownPrior = [];
  for (const file of files ?? []) {
    const before = priorFiles[file];
    const now = observed?.[file];
    if (before === undefined || now === undefined) {
      unknownPrior.push(file);
      continue;
    }
    if (before !== now) changed.push(file);
  }
  return {
    fileCount: files?.length ?? 0,
    priorFileCount: priorShape?.fileCount ?? null,
    membershipChanged,
    changedCount: changed.length,
    unknownPriorCount: unknownPrior.length,
    changed: changed.slice(0, limit),
    unknownPrior: unknownPrior.slice(0, limit),
    // The case the whole sidecar exists to make visible: the aggregate hash moved while every
    // file it covers is byte-, mode- and membership-identical. That is not environmental churn,
    // it is an unstable hash, and nothing else in this run distinguishes the two.
    unexplained:
      priorShape != null &&
      !membershipChanged &&
      changed.length === 0 &&
      unknownPrior.length === 0,
  };
}

/**
 * WI-595883 — the same diagnostic, one component up.
 *
 * `environment-changed` is exactly as unactionable as `dependency-closure-changed`: it says one of
 * ~126 hashed variables moved, not which. Locating `OLDPWD` by hand took five probes; this makes
 * the next one a single grep.
 *
 * VALUES ARE NEVER STORED. This environment carries live credentials (ANTHROPIC_API_KEY,
 * GITHUB_PERSONAL_ACCESS_TOKEN, OPENROUTER_API_KEY, OAuth tokens). The sidecar keeps a truncated
 * digest per key, and every report names KEYS ONLY.
 */
export function identityEnvDigests(environment) {
  const digests = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    digests[key] = sha256(`${typeof value}\0${String(value)}`).slice(0, 16);
  }
  return digests;
}

export function diffIdentityEnvDigests({ prior, observed, limit = 8 }) {
  const before = prior ?? null;
  const now = observed ?? {};
  if (before === null) {
    return {
      known: false,
      changedCount: 0,
      addedCount: 0,
      removedCount: 0,
      changedKeys: [],
      addedKeys: [],
      removedKeys: [],
      unexplained: false,
    };
  }
  const changedKeys = [];
  const addedKeys = [];
  const removedKeys = [];
  for (const key of Object.keys(now)) {
    if (!(key in before)) addedKeys.push(key);
    else if (before[key] !== now[key]) changedKeys.push(key);
  }
  for (const key of Object.keys(before)) {
    if (!(key in now)) removedKeys.push(key);
  }
  changedKeys.sort();
  addedKeys.sort();
  removedKeys.sort();
  return {
    known: true,
    changedCount: changedKeys.length,
    addedCount: addedKeys.length,
    removedCount: removedKeys.length,
    changedKeys: changedKeys.slice(0, limit),
    addedKeys: addedKeys.slice(0, limit),
    removedKeys: removedKeys.slice(0, limit),
    // The environment hash moved while every variable it covers is identical — the same
    // "unstable hash, not churn" signal `diffClosureDigests` reports for the closure.
    unexplained:
      changedKeys.length === 0 && addedKeys.length === 0 && removedKeys.length === 0,
  };
}

/** Keys only — see the credential note on `identityEnvDigests`. */
export function formatIdentityEnvDeltaLine({ taskKey, reason, delta, manifestReason }) {
  return [
    "AFFECTED_TASK_CACHE_ENV_DELTA",
    `task=${JSON.stringify(taskKey)}`,
    `reason=${reason}`,
    `manifest=${manifestReason}`,
    `priorKnown=${delta.known}`,
    `changed=${delta.changedCount}`,
    `added=${delta.addedCount}`,
    `removed=${delta.removedCount}`,
    `unexplained=${delta.unexplained}`,
    `changedKeys=${JSON.stringify(delta.changedKeys)}`,
    `addedKeys=${JSON.stringify(delta.addedKeys)}`,
    `removedKeys=${JSON.stringify(delta.removedKeys)}`,
  ].join(" ");
}

/** One greppable line per explained miss — the instrument an A/B run reads. */
export function formatClosureDeltaLine({ taskKey, reason, delta, manifestReason }) {
  return [
    "AFFECTED_TASK_CACHE_CLOSURE_DELTA",
    `task=${JSON.stringify(taskKey)}`,
    `reason=${reason}`,
    `manifest=${manifestReason}`,
    `fileCount=${delta.fileCount}`,
    `priorFileCount=${delta.priorFileCount ?? "unknown"}`,
    `membershipChanged=${delta.membershipChanged}`,
    `changed=${delta.changedCount}`,
    `unknownPrior=${delta.unknownPriorCount}`,
    `unexplained=${delta.unexplained}`,
    `changedPaths=${JSON.stringify(delta.changed)}`,
    `unknownPriorPaths=${JSON.stringify(delta.unknownPrior)}`,
  ].join(" ");
}

const pathInsideDir = (file, dir) => file === dir || file.startsWith(`${dir}/`);

/**
 * Root files whose bytes can change how an ordinary workspace test resolves or executes.
 *
 * This replaces the former `!file.includes("/")` rule, which admitted every tracked root doc,
 * image, handoff, and report into every task proof. Keep this list about executable/configuration
 * inputs; task-owned files and workspace package.json/config already arrive through the workspace
 * closure below.
 */
export const PASSING_TASK_SHARED_ROOT_INPUTS = Object.freeze([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "tsconfig.base.json",
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "quarantine.txt",
]);

/** Non-module runtime inputs on the affected-test launch path. */
export const PASSING_TASK_SHARED_RUNTIME_INPUTS = Object.freeze([
  "scripts/pc-heavy.sh",
  "libs/test-config/package.json",
]);

/**
 * Canonical module entrypoints that shape every ordinary affected-test invocation.
 *
 * `vitest-config.ts` supplies setup/global-setup/reporter paths; `lane-split.ts` decides which
 * files a lane executes. Their path-loaded children are derived by `staticImportClosure`, not
 * copied into this list. Tests pin these entries against the package export table.
 */
export const PASSING_TASK_SHARED_MODULE_INPUTS = Object.freeze([
  "scripts/affected-tests.mjs",
  "libs/test-config/src/vitest-config.ts",
  "libs/test-config/src/lane-split.ts",
]);

/**
 * Derive the shared runner/config inputs common to ordinary affected-test tasks.
 *
 * The module portion comes from the actual transitive static graph rooted at
 * `scripts/affected-tests.mjs`, not the whole `scripts/` directory. External package imports are
 * represented by the lockfiles above. Any graph hole or untracked runtime module fails closed and
 * makes every ordinary task execute; a broken proof must never be interpreted as an empty proof.
 */
export function passingTaskVerdictSharedInputProvenance({ root, trackedScan }) {
  if (!trackedScan || trackedScan.files.length === 0) {
    return {
      ok: false,
      reason: "provenance-incomplete:shared-input-tracked-file-enumeration-empty",
    };
  }
  const tracked = new Set(trackedScan.files);
  const graph = staticImportClosure({
    rootDir: root,
    entryFiles: PASSING_TASK_SHARED_MODULE_INPUTS.map((file) => resolve(root, file)),
  });
  if (!graph.ok) {
    return {
      ok: false,
      reason: `provenance-incomplete:shared-input-module-graph:${graph.unresolved[0] ?? "empty"}`,
    };
  }

  const files = new Set();
  for (const absolute of graph.files) {
    const file = relative(root, absolute).split(sep).join("/");
    if (!file || file === ".." || file.startsWith("../") || isAbsolute(file)) {
      return {
        ok: false,
        reason: `provenance-incomplete:shared-input-outside-root:${file || absolute}`,
      };
    }
    if (!tracked.has(file)) {
      return {
        ok: false,
        reason: `provenance-incomplete:shared-input-untracked:${file}`,
      };
    }
    files.add(file);
  }

  if (!tracked.has("package.json")) {
    return {
      ok: false,
      reason: "provenance-incomplete:shared-input-missing:package.json",
    };
  }
  for (const file of PASSING_TASK_SHARED_ROOT_INPUTS) {
    if (tracked.has(file)) files.add(file);
  }
  for (const file of PASSING_TASK_SHARED_RUNTIME_INPUTS) {
    if (!tracked.has(file)) {
      return {
        ok: false,
        reason: `provenance-incomplete:shared-input-missing:${file}`,
      };
    }
    files.add(file);
  }

  return { ok: true, files: [...files].sort() };
}

/**
 * Resolve the semantic and execution content proofs for one affected-test task.
 *
 * Kept here, beside the hash it feeds, so the production cache and its repair-chain
 * recurrence tests exercise one policy. Integration tasks remain deliberately
 * non-reusable; repo-wide guards bind every tracked path; ordinary tasks bind their
 * workspace plus its transitive local dependency closure AND shared semantic inputs.
 * Setup, membership, dependency resolution and result interpretation are not transport:
 * changing them invalidates an earlier pass. Only the admission wrapper is execution-only;
 * per-invocation scheduler/transport values are separately normalized by the identity helpers.
 * Shared inputs are also exposed as execution provenance. The legacy aggregate
 * fields remain as compatibility aliases for callers that have not migrated yet.
 */
export function passingTaskVerdictDependencyProvenance({
  root,
  taskKey,
  script,
  workspaceName,
  workspaces,
  trackedScan,
  repoWideTaskKeys,
  sharedInputProvenance = null,
  digestCache = new Map(),
}) {
  if (script === "test:integration" || script === "test:el-suite") {
    return {
      ok: false,
      reason: "provenance-incomplete:external-integration-task",
    };
  }
  if (!trackedScan || trackedScan.files.length === 0) {
    return {
      ok: false,
      reason: "provenance-incomplete:tracked-file-enumeration-empty",
    };
  }

  const closureDirs = new Set();
  const seen = new Set();
  const queue = [workspaceName];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const workspace = workspaces.get(name);
    if (!workspace) continue;
    closureDirs.add(workspace.dir);
    for (const dependency of workspace.deps) {
      if (workspaces.has(dependency)) queue.push(dependency);
    }
  }
  const sortedClosureDirs = [...closureDirs].sort();
  for (const dir of sortedClosureDirs) {
    if (!trackedScan.files.some((file) => pathInsideDir(file, dir))) {
      return {
        ok: false,
        reason: `provenance-incomplete:workspace-not-enumerated:${dir}`,
      };
    }
  }

  const wholeTree = repoWideTaskKeys.has(taskKey);
  const unavailable = trackedScan.unscannedPresent.filter(
    (submodule) =>
      wholeTree ||
      sortedClosureDirs.some(
        (dir) => pathInsideDir(dir, submodule) || pathInsideDir(submodule, dir),
      ),
  );
  if (!wholeTree && sharedInputProvenance && !sharedInputProvenance.ok) {
    return sharedInputProvenance;
  }

  const sharedInputFiles = sharedInputProvenance?.ok
    ? new Set(sharedInputProvenance.files)
    : null;
  // Keep the old fallback for direct callers that do not have the derived shared-input scan yet.
  // The production affected-tests path always supplies sharedInputProvenance, but preserving this
  // fallback keeps older recurrence fixtures fail-closed and source-compatible during migration.
  const executionFiles = wholeTree
    ? []
    : trackedScan.files.filter(
        (file) =>
          sharedInputFiles
            ? sharedInputFiles.has(file)
            : !file.includes("/") ||
              file.startsWith("scripts/") ||
              file.startsWith("libs/test-config/"),
      );
  // R-3: absence from the workspace closure is NOT evidence that a shared input
  // cannot change the test's meaning. Reuse the derived graph, rather than a
  // second setup/config allowlist that could silently omit a new imported oracle.
  const sharedSemanticFiles = new Set(
    executionFiles.filter((file) => file !== "scripts/pc-heavy.sh"),
  );
  const semanticFiles = wholeTree
    ? trackedScan.files
    : trackedScan.files.filter((file) =>
        sharedSemanticFiles.has(file) ||
        sortedClosureDirs.some((dir) => pathInsideDir(file, dir)),
      );
  const semantic = hashDependencyFileSet({
    root,
    files: semanticFiles,
    unavailable,
    digestCache,
  });
  if (!semantic.ok) return semantic;

  const execution =
    executionFiles.length === 0
      ? null
      : hashDependencyFileSet({
          root,
          files: executionFiles,
          digestCache,
        });
  if (execution && !execution.ok) return execution;

  // Preserve the former aggregate shape for callers that have not adopted the split. New cache
  // identity code must use `semantic`, so execution-only runner changes no longer invalidate it.
  const legacy = hashDependencyFileSet({
    root,
    files: [...semanticFiles, ...executionFiles],
    unavailable,
    digestCache,
  });
  if (!legacy.ok) return legacy;
  return {
    ok: true,
    semantic,
    execution,
    hash: legacy.hash,
    listHash: legacy.listHash,
    fileCount: legacy.fileCount,
    files: legacy.files,
  };
}

/** A clean first pass is the only evidence strong enough to suppress a later task. */
export function shouldStorePassingTaskVerdict({
  enabled,
  cacheStatus,
  initialStatus,
  finalStatus,
  absorptionRan,
  identity,
}) {
  return (
    enabled &&
    cacheStatus === "miss" &&
    initialStatus === 0 &&
    finalStatus === 0 &&
    !absorptionRan &&
    identity != null
  );
}

export function buildPassingTaskVerdictIdentity({
  taskKey,
  command,
  environment,
  gateConfig,
  dependencyHash,
  implementationVersion = PASSING_TASK_VERDICT_IMPLEMENTATION_VERSION,
}) {
  const components = {
    command: sha256(stableJson(command)),
    environment: sha256(stableJson(environment)),
    gateConfig: sha256(stableJson(gateConfig)),
    implementation: sha256(String(implementationVersion)),
    dependencyClosure: dependencyHash,
  };
  return {
    taskKey,
    components,
    fingerprint: sha256(stableJson({ taskKey, components })),
  };
}

const COMPONENT_REASON_ORDER = [
  ["implementation", "implementation-version-changed"],
  ["command", "command-changed"],
  ["environment", "environment-changed"],
  ["gateConfig", "gate-config-changed"],
  ["dependencyClosure", "dependency-closure-changed"],
];

export function decidePassingTaskVerdict({
  enabled,
  cacheRead,
  entry,
  identity,
}) {
  if (!enabled) return { hit: false, reason: "cache-disabled" };
  if (!identity) return { hit: false, reason: "provenance-incomplete" };
  if (!entry) {
    return {
      hit: false,
      reason:
        cacheRead?.reason === "cache-ready"
          ? "no-prior-verdict"
          : cacheRead?.reason,
    };
  }
  for (const [component, reason] of COMPONENT_REASON_ORDER) {
    if (entry.components?.[component] !== identity.components[component]) {
      return { hit: false, reason };
    }
  }
  if (entry.fingerprint !== identity.fingerprint) {
    return { hit: false, reason: "identity-fingerprint-mismatch" };
  }
  return { hit: true, reason: "identity-match" };
}

export function passingTaskVerdictEntry(
  identity,
  passedAt = new Date().toISOString(),
) {
  return {
    fingerprint: identity.fingerprint,
    components: identity.components,
    passedAt,
  };
}

export function mergePassingTaskVerdictUpdates(
  cache,
  cacheGroup,
  updates,
  updatedAt = new Date().toISOString(),
) {
  if (typeof cacheGroup !== "string" || cacheGroup.trim() === "") {
    return cache?.version === PASSING_TASK_VERDICT_CACHE_VERSION
      ? cache
      : emptyPassingTaskVerdictCache();
  }
  const groups = {
    ...(cache?.groups ?? {}),
    [cacheGroup]: {
      updatedAt,
      entries: {
        ...(cache?.groups?.[cacheGroup]?.entries ?? {}),
        ...updates,
      },
    },
  };
  // The MAX_GROUPS cap is an LRU designed for per-RUN groups, which are disposable by
  // construction. The cross-run group is the opposite: it is the only one whose whole value is
  // surviving into later runs, and evicting it does not fail loudly — it silently degrades to
  // "no reuse", which is indistinguishable from the deadlock it exists to break. Pin it out of
  // the LRU and let the cap govern the per-run groups it was written for.
  const crossRunGroup = groups[PASSING_TASK_VERDICT_CROSS_RUN_GROUP];
  const retainedGroups = Object.fromEntries(
    Object.entries(groups)
      .filter(([name]) => name !== PASSING_TASK_VERDICT_CROSS_RUN_GROUP)
      .sort(([, a], [, b]) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, PASSING_TASK_VERDICT_CACHE_MAX_GROUPS),
  );
  if (crossRunGroup) {
    retainedGroups[PASSING_TASK_VERDICT_CROSS_RUN_GROUP] = crossRunGroup;
  }
  return {
    version: PASSING_TASK_VERDICT_CACHE_VERSION,
    groups: retainedGroups,
  };
}
