/**
 * CALIBRATION CONTROL — deliberately does NOT use `pinModuleState`.
 *
 * This fixture holds ordinary module-scoped state, so a fresh module record MUST
 * produce a fresh `CONTROL_IDENTITY`. The suite asserts exactly that.
 *
 * Why it exists: the real assertions ("two module records share one state
 * object") are only meaningful if the test harness genuinely creates a SECOND
 * module record. If `vi.resetModules()` ever stops doing so — a vitest change, a
 * config change, a caching layer — every pinned-state assertion would still pass
 * while testing nothing at all, because one module record trivially shares state
 * with itself.
 *
 * So this control must FAIL to share. Control-splits + subject-shares is the only
 * combination that carries information; if this fixture ever starts returning the
 * same identity across a reset, the subject results are vacuous and must not be
 * trusted.
 */

/** A fresh object per module evaluation. Identity is the whole signal. */
export const CONTROL_IDENTITY: { tag: string } = { tag: 'module-scoped-control' };

/** Mutable module-scoped state that a second module record must NOT observe. */
let writes = 0;

export function recordWrite(): number {
  writes += 1;
  return writes;
}

export function writeCount(): number {
  return writes;
}
