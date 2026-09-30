/**
 * FROZEN fuzzy tool-name resolution parameters (plan `fuzzy-tool-name-resolution-2026-07-02`,
 * P-003). Chosen by `resolve-name-sweep.ts` (`pickBest(sweep())`) over the golden (P-001) and
 * adversarial (P-002) corpora: the (T, M) with the MOST golden mangles recovered at ZERO
 * false-resolves, ties broken toward the smallest T. `resolve-name-sweep.test.ts` pins these
 * to the sweep optimum, so changing a corpus or the matcher without re-freezing fails there.
 *
 * - `T` — per-part (group AND verb) normalized edit distance an eligible candidate may have.
 *   Plateau: recovery is flat from 0.20 to 0.50, so the smallest T on it is used.
 * - `M` — RAW-edit margin every other candidate must trail the best by. M = 1 lets raw ties
 *   between real neighbours resolve (10 hard false-resolves); M = 2 costs no golden recovery.
 */
export const FUZZY_RESOLVE_T = 0.2;
export const FUZZY_RESOLVE_M = 2;
