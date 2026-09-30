/**
 * Strict Papercusp manifest validation. Refuses unknown fields, validates
 * id + semver shape, surfaces a precise field path on failure. The same
 * validator is used by the loader (load-time) and the `papercusp plugin
 * lint` CLI (build-time) so authors see errors before deploy.
 *
 * This is the **Papercusp adapter** over the generic JSON-Schema validator
 * engine in `@papercusp/plugin-loader-core`: that lib owns the ajv
 * mechanics + the field-path issue mapping (incl. the
 * `additionalProperties` "unknown property — typo?" rewrite); this module
 * binds it to the Papercusp plugin schema and supplies the two
 * Papercusp-specific message rewrites (the plugin-id regex hint and the
 * semver hint).
 *
 * Schema is statically imported so it becomes part of the dependency
 * graph and is bundled by Next/Turbopack into the standalone build.
 * Previously this used a deferred `readFileSync` against `__dirname`-
 * relative paths, which silently failed in standalone (the JSON file
 * wasn't traced as a dependency). Every plugin then load-failed with a
 * misleading "missing or invalid papercusp.json" — bug regressed twice
 * before this comment landed; please don't switch back without solving
 * the standalone-bundling story first.
 *
 * Edge-runtime safe: ESM JSON imports are inlined as JS literals at
 * build time and don't pull `node:*` modules at runtime.
 */

import {
  createManifestValidator,
  type ManifestValidationIssue,
  type ManifestValidationResult,
} from '@papercusp/plugin-loader-core';
import schemaJson from '../../plugin-sdk/papercusp-plugin.schema.json' with { type: 'json' };

export type { ManifestValidationIssue, ManifestValidationResult };

const _validator = createManifestValidator(schemaJson as object, {
  customizeMessage: (e, manifest) => {
    const path = e.instancePath || '/';
    if (e.keyword === 'pattern' && path === '/name') {
      return `plugin id must match ^(@scope/)?[a-z][a-z0-9_.-]{2,62}$ (got "${(manifest as { name?: unknown }).name}")`;
    }
    if (e.keyword === 'pattern' && path === '/version') {
      return `version must be valid semver (got "${(manifest as { version?: unknown }).version}")`;
    }
    return undefined;
  },
});

/**
 * Validates a parsed manifest against the JSON schema. Returns issues
 * with field paths so callers can render precise error messages.
 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  return _validator.validate(manifest);
}

/**
 * Throws on invalid manifest with all issues concatenated. Used at load
 * time where partial loading is wrong.
 */
export function assertManifestValid(manifest: unknown, sourceLabel = 'manifest'): void {
  _validator.assertValid(manifest, sourceLabel);
}
