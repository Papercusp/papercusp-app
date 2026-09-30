/**
 * CONTROL fixture for the dual-instance suite in `index.test.ts` (EI-19451658870832332).
 *
 * This state is deliberately MODULE-SCOPED — the shape `index.ts` had before its state was
 * pinned to globalThis. It exists to calibrate the instrument, not to be used in production.
 *
 * The dual-instance tests assert that a re-evaluated copy of `index.ts` SHARES one inventory.
 * That assertion is only meaningful if `vi.resetModules()` genuinely produces a second module
 * instance. If it ever silently no-opped — a vitest change, a cache, a config flag — the
 * dynamic import would hand back the SAME instance and "the two instances share state" would
 * be trivially, vacuously true: a green suite proving nothing, while the real dual-instance
 * hazard walked straight back in.
 *
 * So the control runs the same reset and asserts the OPPOSITE outcome: module-scoped state
 * must come back EMPTY. Control green + subject green is the only combination that means the
 * subject is actually shared across two live instances.
 */

/** Module-scoped on purpose — MUST NOT survive a `vi.resetModules()`. */
export const marks: string[] = [];
