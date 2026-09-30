import { afterAll, beforeAll } from 'vitest';

/**
 * Let an ENV-GATED LIVE-HARDWARE suite reach a real Postgres, without weakening the
 * unit-layer rail for anyone else (WI-1199821).
 *
 * WHY THIS EXISTS. `libs/test-config/src/setup-no-real-pg.ts` pins
 * `PAPERCUSP_FORBID_REAL_PG=1` across the whole unit layer, so `buildClient` throws on any
 * real pool (EI-19311807188719573). The `*-live.test.ts` desktop/computer suites live in
 * that layer by filename, but they are not unit tests: they drive the REAL production entry
 * points against real X/GL/AT-SPI hardware on this host. `runComputerAction` reaches the
 * resource governor, which opens the `org-admin` pool:
 *
 *     runComputerAction -> realExec -> runGovernedOperation -> governedExecutionRuntime
 *       -> new PgWorkItemAdmissionQueueStore -> getOrgPg -> assertRealPgAllowed  THROWS
 *
 * That throw propagates out of `runComputerAction`, so the affected suites could not call
 * the thing they exist to measure at all.
 *
 * WHY THIS IS THE SANCTIONED ESCAPE, NOT A HOLE IN THE RAIL. `setup-no-real-pg.ts` names
 * this exact remedy in its own doc comment — "a unit test that genuinely needs a live pool
 * can delete the var in its own beforeAll/test body — that runs AFTER this module-level set
 * and so still wins" — and `cell-assessment-reality.test.ts` already does it by hand. The
 * rail stays armed for every other test in the tree, and stays armed even in these files
 * unless their own live gate is on, which requires a deliberate `PAPERCUSP_*_LIVE=1` plus
 * the required binaries. The default `npm run test:affected` run is untouched.
 *
 * WHY NOT rename the suites to `*.integration.test.ts` — the rail's other suggestion: the
 * integration lane runs against a throwaway testcontainer, while these suites need the real
 * Xvfb / GL / AT-SPI stack on THIS machine. They are live-hardware suites, not
 * testcontainer suites, so that lane cannot host them.
 *
 * WHY A SHARED HELPER rather than the three-line dance copied into each suite: the restore
 * half is the part that matters and the easy part to get wrong. Vitest reuses a worker
 * process across test files, so a missed restore leaves the rail DISABLED for whatever file
 * runs next in that worker — turning a local opt-in into a silent tree-wide hole whose
 * symptom (a unit test somewhere else quietly opening a real pool) points nowhere near the
 * file that caused it. Centralising it means that can be got right once.
 *
 * Call at module scope in the suite, passing its own live gate:
 *
 *     allowRealPgForLiveSuite(liveEnabled);
 *
 * @param liveEnabled the suite's own live gate. When false this registers hooks that do
 *   nothing, so the rail is left fully armed for the ordinary skipped run.
 */
export function allowRealPgForLiveSuite(liveEnabled: boolean): void {
  const gate = makeRealPgGateForLiveSuite(liveEnabled);
  beforeAll(() => gate.lift());
  afterAll(() => gate.restore());
}

/**
 * The lift/restore logic behind {@link allowRealPgForLiveSuite}, separated from the hook
 * wiring purely so it can be driven directly by a test.
 *
 * It has to be exported to be testable at all: the wrapper above registers vitest hooks at
 * a suite's module scope, and a test cannot control when those fire. What actually needs
 * guarding is not the wiring (two lines, obviously correct) but the RULE that the opt-out
 * can never escape its live gate — see live-suite-real-pg.test.ts.
 */
export function makeRealPgGateForLiveSuite(liveEnabled: boolean): {
  lift: () => void;
  restore: () => void;
} {
  let previous: string | undefined;
  let lifted = false;

  return {
    lift(): void {
      if (!liveEnabled) return;
      previous = process.env.PAPERCUSP_FORBID_REAL_PG;
      delete process.env.PAPERCUSP_FORBID_REAL_PG;
      lifted = true;
    },
    restore(): void {
      // Guarded by `lifted`, NOT by `liveEnabled`, so this can only ever restore what this
      // gate actually changed. A restore that runs without its lift — a hook ordering
      // surprise, an aborted suite — must not write the env at all, because writing it
      // would be indistinguishable from a suite legitimately re-arming the rail and could
      // just as easily DISARM it for whatever runs next in this worker.
      if (!lifted) return;
      if (previous === undefined) delete process.env.PAPERCUSP_FORBID_REAL_PG;
      else process.env.PAPERCUSP_FORBID_REAL_PG = previous;
      lifted = false;
      previous = undefined;
    },
  };
}
