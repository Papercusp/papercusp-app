/**
 * @papercusp/plugin-wit — canonical WIT (WebAssembly Interface Type)
 * definitions for the Papercusp plugin protocol.
 *
 * Shared source of truth between:
 *   - the JS host (jco-transpiled, in @papercusp/plugin-loader)
 *   - the Rust runtime (wasmtime + bindgen!, in
 *     papercup-rust-server/crates/papercup-plugin-wit/)
 *
 * Versioning: each protocol version lives in its own subdirectory
 * under wit/. Never edit a published version in place — bump by
 * adding wit/<next>/. Plugin manifests pin the version they're
 * built against via [plugin.protocol] papercup-plugin = "<range>".
 *
 * Cross-runtime sync: the Rust crate currently lives in a separate
 * repo; until that's unified, the canonical source is HERE and the
 * Rust side mirrors. WIT bumps go through the plugin agent (me) only;
 * both runtimes pull. Coord rule, enforced by review.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Protocol versions shipped by this package. Order is irrelevant
 * (versions are independent — older runtimes can support multiple).
 */
export const SHIPPED_VERSIONS = ['0.1.0'] as const;

/** Current protocol version — what the host emits as default. */
export const CURRENT_VERSION = '0.1.0' as const;

/**
 * Resolve the on-disk path to a WIT package's plugin.wit file.
 * Returns an absolute path that jco's transpile + the loader's
 * bindgen pipeline can read. Throws if the requested version isn't
 * shipped by this package — versions are explicit, not implicit.
 */
export function witPath(version: ProtocolVersion): string {
  if (!(SHIPPED_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(
      `unknown WIT version ${version}; shipped versions: ${SHIPPED_VERSIONS.join(', ')}`,
    );
  }
  // Resolve relative to this file regardless of how the package is loaded
  // (bundled, linked, installed). __dirname pattern via import.meta.url.
  const here = dirname(fileURLToPath(import.meta.url));
  // src/index.ts → src/, then ../wit/<version>/plugin.wit
  return join(here, '..', 'wit', dirToVersion(version), 'plugin.wit');
}

export type ProtocolVersion = (typeof SHIPPED_VERSIONS)[number];

/**
 * Convert a semver "0.1.0" → directory-safe "v0_1_0". Mirrors the
 * Rust crate's directory layout convention (cargo doesn't allow dots
 * in module names; we keep parity for sync simplicity).
 */
export function dirToVersion(version: ProtocolVersion): string {
  return `v${version.replace(/\./g, '_')}`;
}
