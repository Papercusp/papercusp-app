/**
 * NEGATIVE CONTROL for WI-40369 — deliberately wrong, never wire this up.
 *
 * This reproduces the EXACT defect that `./switch.ts` used to carry: calling a
 * workspace-registry seam at MODULE-EVAL time. Under a partial
 * `vi.mock('../../../../workspace-registry', ...)` that omits `workspacesRoot`,
 * merely importing this module throws.
 *
 * It exists so the guard in `../switch-lazy-registry-path.test.ts` is provably
 * FALSIFIABLE without mutating a tracked source file — mutating one on this
 * shared tree races the git-sync sweep, which commits the working tree on a
 * schedule and can capture the mutant even when nothing goes wrong. A permanent
 * control has no such window, and unlike a one-off probe it cannot be skipped.
 *
 * If this module ever STOPS throwing under that partial mock, the guard beside
 * it proves nothing and must be re-derived rather than trusted.
 */
import { join } from 'node:path';
import { workspacesRoot } from '../../../../workspace-registry';

// The eager form. This is the bug, on purpose.
export const EAGER_REGISTRY_PATH = join(workspacesRoot(), 'registry.json');
