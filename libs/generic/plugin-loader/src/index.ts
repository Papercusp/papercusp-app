/**
 * @papercusp/plugin-loader-core — a generic, domain-free plugin-loader
 * kernel. Three composable pieces:
 *
 *   - `createPluginLoader(ports)` — the filesystem → typed-plugin
 *     discovery pipeline (read+validate manifest → optional alternate-
 *     runtime dispatch → import entry → validate → dedupe). All host
 *     specifics inject through `ports`.
 *   - `createManifestValidator(schema)` — a pluggable JSON-Schema
 *     manifest validator that returns field-pathed issues (ajv).
 *   - `satisfies(version, range)` — a minimal semver-range matcher for
 *     runtime-compatibility checks.
 *
 * The lib names no consuming app; a host (e.g. the Papercusp plugin
 * adapter) maps its manifest shape, validation rules, runtime kinds, and
 * search-path resolution onto these seams.
 */
export {
  createPluginLoader,
  defaultImportEntry,
  listSubdirs,
  type PluginLoader,
  type PluginLoaderPorts,
  type LoadedPlugin,
  type LoadFromDirResult,
  type ManifestError,
  type DiscoverRoot,
} from './loader';

export {
  createManifestValidator,
  type ManifestValidator,
  type ManifestValidatorOptions,
  type ManifestValidationResult,
  type ManifestValidationIssue,
  type AjvErrorObject,
} from './manifest-validator';

export { satisfies } from './semver';
