/**
 * testing-domain-glob — re-export shim.
 *
 * The implementation was promoted to the borrowable @papercusp/testing-shell
 * lib as a server-only subpath (`@papercusp/testing-shell/glob`) — M5 of
 * testing-shell-cross-project-2026-06-01. All importers keep using this path;
 * the canonical, shared implementation now lives in the submodule.
 */
export * from '@papercusp/testing-shell/glob';
