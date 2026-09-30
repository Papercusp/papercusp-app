/**
 * Host-specialized seams — types the framework references but does not own.
 *
 * In Papercusp these were concrete unions (`AgentRole`), capability strings,
 * and a subprocess executor. In the generic framework they are open seams:
 * a role is any string, a capability is any string, and `spawn` is an
 * optional host-supplied subprocess runner.
 *
 * **Roles are host-configured, not baked in (plan P-010 / D-005).** The core
 * never enumerates roles — it only compares strings. A host registers its
 * known roles by augmenting `RoleRegistry` via declaration merging; that
 * narrows `AgentRole` editor autocomplete program-wide while keeping the type
 * `string`-assignable (plugins register arbitrary custom roles at runtime, so
 * the set is never closed). A consumer that registers nothing — e.g. the
 * standalone example (P-051) — gets `AgentRole = string`, fully generic.
 *
 * `Capability` is still a bare `string`; its host-injection (the `tierFor`
 * rule) is P-012, not P-010.
 */

/**
 * Host role registry. Augment via declaration merging to register the roles
 * your host knows about; each key is a role id. The framework only reads
 * `keyof` this interface to shape `AgentRole`'s suggestions — values are
 * ignored (use `true`).
 *
 * @example
 * ```ts
 * declare module '@papercusp/tooldef' {
 *   interface RoleRegistry { scoper: true; worker: true; reviewer: true }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface RoleRegistry {}

/** The host-registered role ids, or `never` when nothing is registered. */
type RegisteredRole = Extract<keyof RoleRegistry, string>;

/**
 * An agent/caller role. Resolves to the host's registered roles (as an
 * autocomplete-friendly suggestion union that stays `string`-assignable) when
 * `RoleRegistry` has been augmented, or to bare `string` otherwise. The
 * framework only ever compares roles as strings — it does not enforce the set.
 */
export type AgentRole = [RegisteredRole] extends [never]
  ? string
  : RegisteredRole | (string & {});

/** A declarative permission string, e.g. `"tasks:read"`. Host-defined. */
export type Capability = string;

/** Options for a host-supplied subprocess spawn. */
export interface PluginSpawnOptions {
  /** Working directory. */
  cwd?: string;
  /** Additional env vars merged on top of the host process env. */
  env?: Record<string, string>;
  /** Stdin payload to write before closing stdin. */
  stdin?: string | Uint8Array;
  /** Hard timeout in ms; the host SIGKILLs on expiry. */
  timeoutMs?: number;
  /** Max captured stdout/stderr size in bytes. */
  maxBufferBytes?: number;
}

/** Result of a host-supplied subprocess spawn. */
export interface PluginSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True if the process was killed by the host (timeout, abort). */
  killed: boolean;
}

/**
 * A host-supplied subprocess executor handed to tool handlers as `ctx.spawn`.
 * Optional — tools that don't shell out never receive it.
 */
export type PluginSpawn = (
  bin: string,
  args: readonly string[],
  opts?: PluginSpawnOptions,
) => Promise<PluginSpawnResult>;
