/**
 * `instance-spec` — the reproducible instance descriptor that re-homes the snapshot
 * system's one remaining job (the reproducible clone) onto a lightweight tuple
 * `(blueprintRef, repoSha, deploymentConfig, genome)`.
 *
 * Plan: `retire-snapshots-instance-spec-2026-06-09` (Phase A).
 * Canonical model: `self-improvement-stack-reconciliation-2026-06-09`.
 *
 *   capture(slug)        → InstanceSpec          (read a live harness)
 *   boot(spec, target)   → a new identical instance (reuses harness:create)
 *   vary(spec, delta)    → a same-origin clone   (the eval-battery's fair Δ-selection)
 *
 * The genome surface (`./genome`) is the ONE config-variation definition the whole
 * stack points at (D-002).
 */
export * from './genome';
export * from './genome-storage';
export * from './types';
export * from './vary';
export * from './capture';
export * from './boot';
export * from './instance-subject';
