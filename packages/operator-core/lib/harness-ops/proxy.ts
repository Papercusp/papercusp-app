/**
 * Harness-op PROXY CoordOps (`harness-provided-cadence-ops-2026-06-26` P-002 /
 * D-001).
 *
 * A blueprint may declare deterministic step-ops in its `ops:` manifest that live
 * in + execute from the HARNESS, not operator-core. For each such entry the
 * platform registers a PROXY CoordOp into the SAME coord-op registry the built-in
 * ops use — so `validateBlueprint({knownOps})` resolves the op name (no
 * `unknown-op`) and the durable `coordProgramWorkflow` checkpoints it exactly like
 * a built-in. The proxy is the ONLY new shape: its `argsSchema`/`resultSchema` are
 * compiled from the manifest's JSON Schema, and its `run()` does NOT execute
 * harness code in operator-core — it DISPATCHES the call over the harness transport
 * (`dispatchHarnessOp`) to the harness's own runtime, then validates the response
 * against `resultSchema` (the trust boundary).
 *
 * Registration is hooked at the blueprint-admission chokepoints (`_resolve`,
 * `install-blueprint-core`, `project-to-pg`) — each calls
 * `registerHarnessOpProxies(blueprint.ops)` right BEFORE it snapshots the op
 * registry for validation, so the just-declared ops are present. Idempotent (the
 * registry is a Map) and default-inert (a blueprint with no `ops:` registers
 * nothing). A proxy NEVER shadows a real built-in op of the same name (the guard
 * below) — so the in-flight `oddsmith:prospect` migration can't be hijacked by a
 * manifest before the built-in is deleted (P-007).
 */
import type { CoordOp, CoordOpCtx } from '../coord-ops/types.js';
import { registerCoordOp, getCoordOp } from '../coord-ops/registry.js';
import { jsonSchemaToZod } from './json-schema-to-zod.js';
import { dispatchHarnessOp } from './transport.js';

/** A manifest `ops:` entry, as the orchestrator `OpManifestEntrySchema` parses it. */
export interface HarnessOpManifestEntry {
  name: string;
  description?: string;
  argsSchema?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  handler?: { kind?: string };
}

/** Marker flag so the registrar can tell a proxy from a built-in op. */
export interface HarnessOpProxy extends CoordOp {
  isHarnessProxy: true;
}

/** True if an op is a harness-op proxy (not a compiled-in built-in). */
export function isHarnessOpProxy(op: CoordOp | undefined): op is HarnessOpProxy {
  return !!op && (op as Partial<HarnessOpProxy>).isHarnessProxy === true;
}

/**
 * The serializable slice of `CoordOpCtx` the harness handler receives — never the
 * capability bag (`caps`), which is non-serializable + operator-internal. The
 * harness runs the op against ITS OWN connectors/DB; it only needs to know which
 * workspace/harness/program/work-item the call belongs to.
 */
function serializableCtx(ctx: CoordOpCtx): Record<string, unknown> {
  return {
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.harnessSlug,
    blueprintId: ctx.blueprintId,
    workItemId: ctx.workItemId,
    ownerId: ctx.identity?.ownerId,
  };
}

/**
 * The dispatch fn a proxy's `run()` calls — `dispatchHarnessOp` in prod, a fake in
 * tests. The DI seam (mirroring the codebase's `_deps` pattern) keeps the proxy
 * unit-testable without a live sidecar.
 */
export type HarnessOpDispatchFn = (
  slug: string,
  opName: string,
  args: unknown,
  opts: { workspaceId?: string; ctx?: Record<string, unknown> },
) => Promise<unknown>;

/** Build a proxy CoordOp from one manifest entry. `dispatch` is injectable for tests. */
export function makeHarnessOpProxy(
  entry: HarnessOpManifestEntry,
  dispatch: HarnessOpDispatchFn = dispatchHarnessOp,
): HarnessOpProxy {
  const argsSchema = jsonSchemaToZod(entry.argsSchema ?? {});
  const resultSchema = jsonSchemaToZod(entry.resultSchema ?? {});
  return {
    name: entry.name,
    description:
      entry.description?.trim() ||
      `Harness-provided op '${entry.name}' — dispatched to the harness runtime.`,
    argsSchema,
    resultSchema,
    isHarnessProxy: true,
    async run(args: unknown, ctx: CoordOpCtx): Promise<unknown> {
      const slug = ctx.harnessSlug;
      if (!slug) {
        throw new Error(
          `harness op '${entry.name}' requires ctx.harnessSlug to know which harness runtime to ` +
            `dispatch to (the proxy is harness-agnostic; the dispatch target is the running harness).`,
        );
      }
      ctx.log?.(`harness-op ${entry.name} → dispatch to '${slug}'`);
      const result = await dispatch(slug, entry.name, args, {
        workspaceId: ctx.workspaceId,
        ctx: serializableCtx(ctx),
      });
      // The trust boundary (D-001): validate the harness's response against the
      // manifest resultSchema before binding it into program data. A `{}` schema
      // compiles to accept-any, so an undeclared result still passes.
      return resultSchema.parse(result);
    },
  };
}

/**
 * Register a proxy CoordOp for each declared harness op. Idempotent; default-inert
 * (empty `ops` registers nothing). Returns the names registered (for tests/logging).
 *
 * GUARD: never overwrite an existing NON-proxy op of the same name — a built-in op
 * (e.g. the in-flight `oddsmith:prospect` before P-007 deletes it) stays
 * authoritative, and a manifest can't hijack a platform op name. A prior proxy of
 * the same name IS replaced (re-admission picks up an edited manifest).
 */
export function registerHarnessOpProxies(
  ops: HarnessOpManifestEntry[] | undefined,
  log?: (msg: string) => void,
): string[] {
  if (!ops || ops.length === 0) return [];
  const registered: string[] = [];
  for (const entry of ops) {
    if (!entry?.name) continue;
    const existing = getCoordOp(entry.name);
    if (existing && !isHarnessOpProxy(existing)) {
      log?.(
        `[harness-ops] skip proxy for '${entry.name}': a built-in coord-op of that name is ` +
          `already registered (the built-in stays authoritative).`,
      );
      continue;
    }
    registerCoordOp(makeHarnessOpProxy(entry));
    registered.push(entry.name);
  }
  return registered;
}
