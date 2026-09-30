/**
 * Re-export shim → `@papercusp/locks` (path validation + canonicalization).
 *
 * The repo-relative POSIX path rules moved to the package (P-010); the
 * canonical source is now `packages/locks/src/path-normalize.ts`. This shim
 * keeps `@/lib/agent-tools/locks/path-normalize` resolving unchanged.
 *
 * Deliberately PURE — no `./configure` import — so pure path-validation
 * consumers (and the OMP coord-hook parity test, which asserts the hook's
 * mirrored rules match these) don't pull in embedded-pg discovery. The
 * package barrel re-exports these names via su-lock-store, so they're all
 * present here.
 *
 * NOTE: the OMP hook (`scripts/hooks/omp/coord-hook.ts`) mirrors these rules
 * in its own self-contained copy and CANNOT import this module at runtime —
 * if you change the rules in the package, update the hook to match.
 */
export {
  InvalidPathError,
  MAX_PATH_LEN,
  validatePath,
  canonicalizePath,
  normalizePaths,
} from '@papercusp/locks';
