/**
 * @papercusp/locks — SU-agent file-lock coordination substrate.
 *
 * Public surface = the union of the storage layer, the per-workspace
 * transaction wrapper, the refcounted LISTEN/janitor module, the
 * FileClaimCoordinator adapter, and the host seam. Path-validation rules
 * (`path-normalize`) are re-exported transitively via `su-lock-store`, so
 * this barrel deliberately does NOT `export *` from `./path-normalize`
 * again — a second star-export of the same names is an ambiguous re-export
 * that ESM silently drops, which would break `normalizePaths` et al.
 *
 * Call `configureLocks({ getAdminBaseUrl })` once before any other API.
 */
export * from './config';
export * from './su-lock-store';
export * from './resource-lock-store';
export * from './resource-atomic';
// The pure Gray-1976 matrix moved to @papercusp/locks-core (generalize-libs).
// Re-export exactly the intention symbols so this barrel's public surface is
// unchanged — explicit, not `export *`, to avoid leaking locks-core's HLC/CRDT
// modules into @papercusp/locks's surface.
export {
  ROOT_NODE,
  MODE_COMPATIBLE,
  compatible,
  intentionFor,
  normalizeNode,
  ancestorsOf,
  lockSetFor,
  findConflicts,
  type GranularMode,
  type NodeLock,
  type HeldNodeLock,
  type GranularConflict,
} from '@papercusp/locks-core';
export * from './granular-lock-store';
export * from './in-workspace-txn';
export * from './workspace-listener';
export * from './coordinator';
export * from './rebind-owner';
