/**
 * @papercusp/plan-parser — the pure tier of the plan-document system.
 *
 * Browser-safe markdown+frontmatter parsing, the item/decision algebra, and
 * effective-status resolution (blocked-by graph). Zero I/O, zero domain
 * coupling — the plans *lifecycle* (revisions, promote, launch, runs, CAS
 * writes, git history) stays in the operator and consumes this.
 *
 * Node-only hashing and the project-history assembler are explicit subpaths
 * (`@papercusp/plan-parser/content-hash` and `/project-history`). Keeping them
 * out of this barrel is load-bearing: Vite evaluates every re-export in dev,
 * so a transitive `node:crypto` import here blanks the browser SPA before React
 * mounts.
 *
 * Extracted per papercusp-systems-abstraction-2026-05-29 (P-022 / D-005).
 */
export * from "./parser";
export * from "./risk-model";
export * from "./effective-status";
export * from "./next-pointer";
export * from "./lifecycle";
export * from "./renderer";
export * from "./parts";
export * from "./spec-triad";
