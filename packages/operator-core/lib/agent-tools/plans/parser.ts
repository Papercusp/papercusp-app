/**
 * Re-export shim — the pure plan parser now lives in @papercusp/plan-parser
 * (extracted per papercusp-systems-abstraction-2026-05-29, P-022 / D-005).
 * This path is kept so the operator's plans-lifecycle consumers resolve
 * unchanged; new code should import from '@papercusp/plan-parser' directly.
 */
export * from '@papercusp/plan-parser';
