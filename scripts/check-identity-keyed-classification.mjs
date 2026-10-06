#!/usr/bin/env node
/**
 * check-identity-keyed-classification.mjs — close the cross-repo atomicity
 * window that guarantees a transient gate red per identity-keyed migration.
 * (EI-20012634773877104.)
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * `identity-keyed-state-inventory.test.ts` asserts an invariant whose two
 * halves live in DIFFERENT REPOS:
 *
 *   - the schema it scans — `libs/papercusp/libs/db/src/schema/generated.ts`
 *     — is a SUBMODULE file, rewritten by pull-schema.mjs;
 *   - the ALLOWLIST that classifies each identity-keyed column is in the
 *     SUPERPROJECT test file itself.
 *
 * git-sync commits the submodule and the superproject as SEPARATE commits and
 * sweeps the whole tree on a schedule, so those two halves can never land
 * atomically. Measured (2026-08-09): the submodule commit carrying a new
 * `fleet_brief_snapshots.owner_id` landed at 16:52, the superproject pinned it
 * at 17:08 with no classification yet, and the classification landed at 17:12.
 * Any gate candidate cut in that ~16 minute window judges an internally
 * INCONSISTENT tree and reds — correctly, per the test's own contract. Cost
 * that day: a full gate suite, a release-fixer dispatch, and main held ~1h,
 * for work that was already correct 4m21s later. The class recurred for at
 * least 10 further identity-keyed columns between 2026-08-09 and 2026-08-31.
 *
 * WHY THE FIX IS HERE AND NOT IN THE TEST
 * ---------------------------------------
 * The test's contract is RIGHT and is deliberately left alone. Grace-periods,
 * new-table exemptions, or any "tolerate an unclassified column for a while"
 * softening would reintroduce exactly the WI-3642 blind spot the test exists
 * to close — so none of that is done here.
 *
 * Instead the window is closed at its SOURCE. The inconsistent state only ever
 * reaches disk because pull-schema.mjs promotes a new schema into generated.ts
 * while the classification is still absent; once it is on disk, the next
 * git-sync sweep commits it and the gate can see it. So pull-schema.mjs calls
 * this guard BEFORE promotion: if the candidate schema would introduce an
 * unclassified identity-keyed column, generated.ts is never written, nothing
 * inconsistent is ever committable, and the author is told immediately — in
 * their own working state, where the fix is one ALLOWLIST entry — instead of
 * the fleet discovering it as a gate red fifteen minutes later.
 *
 * WHY IT SHELLS OUT TO THE TEST INSTEAD OF RE-SCANNING
 * ----------------------------------------------------
 * The identity-keyed column predicate is subtle (frozen `bak_*` snapshot
 * skipping, upstream `_`-prefixed scratch-table stripping, allowlist-rot and
 * rebindIdentity surface cross-checks). A second copy of it here would be
 * code-describing metadata maintained by hand — the exact drift the repo's
 * derived-truth ladder forbids — and its worst failure mode is silent: the
 * guard passes while the gate reds. Running the real test against a CANDIDATE
 * schema (via IDENTITY_KEYED_SCHEMA_PATH) makes guard and gate the SAME
 * assertion by construction, so they cannot disagree.
 *
 * Usage:
 *   node scripts/check-identity-keyed-classification.mjs [--schema <path>]
 *
 * Exit 0 = every identity-keyed column in the candidate schema is classified.
 * Exit 1 = unclassified column(s), or the check could not be run at all.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

/** The census test that owns the predicate — the single source of truth. */
export const CENSUS_TEST_REL =
  'lib/agent-tools/coordination/identity-keyed-state-inventory.test.ts';
export const OPERATOR_CORE_REL = 'packages/operator-core';

/** Strip ANSI so output matching does not depend on vitest's colour mode. */
/**
 * The gate's pass-reuse skip-list channel. Local literal (not imported) so this
 * script stays dependency-light for pull-schema.mjs; pinned equal to
 * libs/test-config's PC_TEST_REUSE_SKIP_LIST_ENV by identity-keyed-classification-gate.test.ts.
 */
export const TEST_REUSE_SKIP_LIST_ENV = 'PC_TEST_REUSE_SKIP_LIST';

/**
 * The lane selector the gate exports per operator-core lane leg (PC_TEST_LANE=pure|stateful);
 * libs/test-config/src/vitest-config.ts turns it into a lane-split `exclude`. Local literal for
 * the same reason as above, pinned by identity-keyed-classification-gate.test.ts.
 */
export const TEST_LANE_ENV = 'PC_TEST_LANE';

/**
 * The gate's file-selection list (scripts/affected-tests.mjs --related writes it;
 * libs/test-config/src/vitest-config.ts narrows `include` to the files it lists). Local
 * literal for the same reason as above, pinned by identity-keyed-classification-gate.test.ts.
 */
export const TEST_FILTER_LIST_ENV = 'PC_TEST_FILTER_LIST';

/**
 * Every channel through which a parent runner narrows which files a vitest invocation
 * selects. The nested census run targets exactly one file and must always run it, so the
 * child never inherits any of them. identity-keyed-classification-gate.test.ts pins this
 * set equal to the `PC_TEST_*_ENV` constants exported anywhere in libs/test-config/src, so
 * a new selection channel there fails that test until it is listed here.
 */
export const TEST_SELECTION_ENVS = Object.freeze([
  TEST_REUSE_SKIP_LIST_ENV,
  TEST_LANE_ENV,
  TEST_FILTER_LIST_ENV,
]);

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Build the child env for the nested census run.
 *
 * WI-10002179 — WHY `PAPERCUSP_MUTATION_PROBE` IS SET HERE, AND WHY IT IS NOT
 * COSMETIC. The vitest reporter that writes `harness_shared.test_runs` is
 * auto-wired into EVERY workspace by defineVitestConfig, so it also runs in
 * this NESTED `vitest run`. Under the fleet gate this function inherits the
 * gate's own stamps via `{ ...process.env }` — `PAPERCUSP_TEST_RUN_SOURCE=ci`,
 * `PAPERCUSP_TEST_RUN_GROUP=<runId>` and the judged `commit_sha`
 * (buildGreenCheckpointEnv, green-checkpoint.ts). A nested run against an
 * OVERRIDE subject therefore recorded a row that was byte-for-byte
 * indistinguishable from a genuine gate failure of the TRACKED census file:
 * `source='ci'`, `worktree_dirty=false`, `commit_sha=<the frozen candidate>`.
 *
 * That is exactly the `gate.greenCheckpoint.candidateFailures` query shape, so
 * the guard's OWN falsifiability probe — which fails BY DESIGN, that being the
 * whole point of `expect(verdict.ok).toBe(false)` — manufactured a phantom
 * failing file on the gate's own candidate. Measured 2026-09-21: phantom `fail`
 * rows at candidates 6e6405037324 and 80959359392e carrying the deliberate
 * fixture's message (`ei20012634773877104_probe.owner_id`), sitting beside
 * PASSING rows for the same file at the same sha in the same minute. It cost at
 * least two agents a full triage cycle chasing a Postgres table that never
 * existed — it is a drizzle table *definition* in a temp fixture string.
 *
 * `mutation-probe` is a first-class `TestRunSource` (testing-run-source.ts)
 * meaning "a deliberate probe, not a verdict". Setting it keeps the row for
 * auditability while taking it out of every `source='ci'` gate read. It is
 * scoped to the override branch on purpose: an ordinary run against the tracked
 * mirror IS a real verdict on the tracked file and must keep recording as one.
 *
 * @param {NodeJS.ProcessEnv} base
 * @param {string | null} schemaAbs absolute candidate schema, or null for the
 *   tracked mirror (the test's own default).
 * @returns {NodeJS.ProcessEnv}
 */
export function buildCensusChildEnv(base, schemaAbs) {
  const env = { ...base, NO_COLOR: '1', FORCE_COLOR: '0' };
  // WI-10004340: the gate's selection channels are meant for the gate's OWN vitest
  // invocation. Inherited here, each one can drop the census file from the nested run,
  // which then exits "No test files found" and BOTH branches report a false verdict.
  // It leaked one channel at a time: the pass-reuse skip list (verify 1b0ba635), the
  // lane selector (verify 05c11967), then the related-files filter list (verify
  // 4988081a, repairHead d740fc38). So the whole set is scrubbed, not one name.
  for (const name of TEST_SELECTION_ENVS) delete env[name];
  if (schemaAbs) {
    env.IDENTITY_KEYED_SCHEMA_PATH = schemaAbs;
    env.PAPERCUSP_MUTATION_PROBE = '1';
  }
  return env;
}

/**
 * Run the identity-keyed census assertion against a candidate schema file.
 *
 * @param {{ schemaPath?: string, repoRoot?: string, timeoutMs?: number }} [opts]
 *   schemaPath — the candidate schema to scan. Omit to check the tracked
 *   generated.ts (the test's own default).
 * @returns {{ ok: boolean, code: string, message: string, output: string }}
 */
export function checkIdentityKeyedClassification(opts = {}) {
  const repoRoot = opts.repoRoot ? resolve(opts.repoRoot) : REPO_ROOT;
  const operatorCore = join(repoRoot, OPERATOR_CORE_REL);
  const testAbs = join(operatorCore, CENSUS_TEST_REL);

  // A missing superproject/test is NOT a failure to report as "unclassified" —
  // it means this check could not run at all, and callers (pull-schema.mjs in
  // a standalone submodule checkout) must be able to tell those apart.
  if (!existsSync(testAbs)) {
    return {
      ok: false,
      code: 'check-unavailable',
      message: `census test not found at ${testAbs} — cannot verify identity-keyed classification`,
      output: '',
    };
  }

  let schemaAbs = null;
  if (opts.schemaPath) {
    schemaAbs = resolve(opts.schemaPath);
    if (!existsSync(schemaAbs)) {
      return {
        ok: false,
        code: 'check-unavailable',
        message: `candidate schema not found at ${schemaAbs}`,
        output: '',
      };
    }
  }
  const env = buildCensusChildEnv(process.env, schemaAbs);

  const run = spawnSync('npx', ['vitest', 'run', CENSUS_TEST_REL], {
    cwd: operatorCore,
    env,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 180_000,
  });

  const output = stripAnsi(`${run.stdout ?? ''}${run.stderr ?? ''}`);

  if (run.error) {
    return {
      ok: false,
      code: 'check-unavailable',
      message: `could not run the census test: ${run.error.message}`,
      output,
    };
  }

  // A zero-work green is the failure mode this repo documents repeatedly: a
  // vitest invocation that matched NO test file still exits 0, and its empty
  // output is indistinguishable from a real pass. Require positive evidence
  // that a test file actually ran before believing the exit code.
  const passedFiles = output.match(/Test Files\s+(\d+)\s+passed/);
  if (run.status === 0 && !passedFiles) {
    return {
      ok: false,
      code: 'check-unavailable',
      message:
        'the census test reported success but no test file was measured — ' +
        'treating as UNVERIFIED rather than green (zero-work false green).',
      output,
    };
  }

  // The non-zero dual: when selection dropped the census file, vitest exits 1 with
  // "No test files found". Nothing was measured, so that is not an `unclassified`
  // verdict either (WI-10004340: three gate reds read as unclassified this way).
  if (run.status !== 0 && /No test files found/.test(output)) {
    return {
      ok: false,
      code: 'check-unavailable',
      message:
        'the census run selected no test file (an inherited selection channel ' +
        'excluded it), so classification was not measured.',
      output,
    };
  }

  if (run.status === 0) {
    return {
      ok: true,
      code: 'classified',
      message: 'all identity-keyed columns classified',
      output,
    };
  }

  return {
    ok: false,
    code: 'unclassified',
    message:
      'the candidate schema introduces an identity-keyed column with no classification.\n' +
      `Add it to ALLOWLIST in ${OPERATOR_CORE_REL}/${CENSUS_TEST_REL} — as 'covered'\n` +
      "(with a rebindIdentity surface) or 'exempt' (with a one-line reason) — and re-run.\n" +
      'This is deliberately blocking: promoting the schema without it would commit a tree\n' +
      'whose two halves disagree, and red the fleet-wide green-checkpoint for everyone.',
    output,
  };
}

if (isCliEntry(import.meta.url)) {
  const idx = process.argv.indexOf('--schema');
  const schemaPath = idx >= 0 ? process.argv[idx + 1] : undefined;
  const result = checkIdentityKeyedClassification({ schemaPath });
  if (!result.ok) {
    console.error(result.output.trim());
    console.error(`\nIDENTITY_KEYED_CLASSIFICATION: ${result.code}\n${result.message}`);
    process.exit(1);
  }
  console.log(`IDENTITY_KEYED_CLASSIFICATION: ${result.code} — ${result.message}`);
}
