/**
 * Blueprint → PG projection — the operator half of the file-read/parse loader
 * (`harness-blueprint-orchestration-2026-06-03` P-002 / D-006 / D-021).
 *
 * The git-canonical `.papercusp/blueprint.yaml` is resolved + validated by the
 * pure loader in `@papercusp/orchestrator/blueprint`; THIS module writes that
 * resolved result into the PG cache (`harness_shared.blueprints`) the interpreter
 * reads, and reads it back. The live-edit "commit → reproject" path (D-007)
 * calls `projectBlueprintToPg` after a commit; the runtime resolver
 * `getEffectiveBlueprint` reads the cache and lazily projects on a miss.
 *
 * NOT the Hyperbee CRDT projector (D-021) — a plain upsert keyed by
 * (workspace_id, harness_slug). Takes an injected `Sql` (the live admin pool),
 * mirroring the gym control-plane, so the routes and the loader share one core.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Sql, TransactionSql } from 'postgres';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  BlueprintSchema,
  blueprintHash,
  loadBlueprintFromFile,
  type Blueprint,
  type LoadedBlueprint,
  type CompiledAgentSpecification,
  replayAgentSpecification,
} from '@papercusp/orchestrator/blueprint';
import { compileBlueprintWithPackages, provisionBlueprintPackages, blueprintPackageProvisioners } from './compile-packages';
import { blueprintRegistrySets } from './registry-sets.js';
import { operatorResolveExtends } from './installed-blueprints';
import { registerHarnessOpProxies, type HarnessOpManifestEntry } from '../harness-ops/proxy.js';
import { resolveSeedPackKey } from '../knowledge-packs/seed-pack-key';

/**
 * P-002: register a PROXY CoordOp for each harness-provided op a blueprint SOURCE
 * file declares, BEFORE `loadBlueprintFromFile` validates it — `resolveBlueprint`
 * THROWS on an `unknown-op`, so a program blueprint whose spine references a
 * harness op would otherwise fail resolution on a cold cache (and silently fall
 * back to `coding`). Best-effort + direct-ops only (the blueprint that ships the
 * ops declares them on itself); a real parse error is surfaced by the load below.
 */
function preRegisterSourceFileOps(path: string): void {
  try {
    const raw = parseYaml(readFileSync(path, 'utf8')) as { ops?: unknown } | null;
    if (raw && Array.isArray(raw.ops)) {
      registerHarnessOpProxies(raw.ops as HarnessOpManifestEntry[]);
    }
  } catch {
    /* loadBlueprintFromFile surfaces the real parse error */
  }
}

/** Resolve a source blueprint's extends chain across project-local, installed, and built-in tiers. */
function resolveSourceBlueprintExtends(sourcePath: string | null | undefined) {
  return operatorResolveExtends({
    localDirs: sourcePath ? [join(dirname(sourcePath), 'blueprints')] : [],
  });
}

export interface ProjectBlueprintInput {
  workspaceId: string;
  harnessSlug: string;
  blueprint: Blueprint;
  /** Precomputed hash from the loader; recomputed if absent. */
  contentHash?: string;
  sourcePath?: string | null;
  sourceCommit?: string | null;
  /** Reuse the validated source stack when the caller has just loaded it. */
  loaded?: LoadedBlueprint;
  /** A replayed artifact avoids consulting mutable inputs during an explicit replay. */
  specification?: CompiledAgentSpecification;
}

/** Preserve an operation-bearing specification before moving the mutable
 * current-blueprint pointer. Replaying the artifact verifies its hash and
 * closure; an existing revision with different bytes is a hard collision. */
export async function retainBlueprintSpecificationSnapshot(
  sql: Sql | TransactionSql,
  input: { workspaceId: string; harnessSlug: string; specification: CompiledAgentSpecification },
): Promise<string> {
  const specification = replayAgentSpecification(input.specification);
  const artifact = JSON.stringify(specification);
  await sql`
    INSERT INTO harness_shared.blueprint_specifications
      (workspace_id, harness_slug, specification_revision, artifact)
    VALUES (${input.workspaceId}, ${input.harnessSlug}, ${specification.specificationRevision}, ${artifact}::text::jsonb)
    ON CONFLICT (workspace_id, harness_slug, specification_revision) DO NOTHING
  `;
  const rows = await sql<{ matches: boolean }[]>`
    SELECT artifact = ${artifact}::text::jsonb AS matches
      FROM harness_shared.blueprint_specifications
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND specification_revision = ${specification.specificationRevision}
  `;
  if (rows.length !== 1 || rows[0].matches !== true) {
    throw new Error('blueprint specification revision already exists with different content');
  }
  return specification.specificationRevision;
}

// A specification revision is immutable (the upsert above refuses different content
// under an existing revision), so a positive read can be reused for the process
// lifetime. WI-10003631: the blueprint execution program re-read + re-replayed the
// artifact ~7x per operation, the largest server cost on that path and a major share
// of client CPU. Only hits are cached; a miss always goes back to PG.
const snapshotCache = pinModuleState('@papercusp/operator-core.blueprint-specification-snapshots',
  () => new Map<string, CompiledAgentSpecification>());
const SNAPSHOT_CACHE_MAX = 256;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Test seam: drop cached snapshots. */
export function clearBlueprintSpecificationSnapshotCache(): void { snapshotCache.clear(); }

/** Read the accepted revision, never the mutable current blueprint cache. The result is
 * deep-frozen and shared across callers (immutable revision content). */
export async function readBlueprintSpecificationSnapshot(
  sql: Sql | TransactionSql,
  workspaceId: string,
  harnessSlug: string,
  specificationRevision: string,
): Promise<CompiledAgentSpecification | null> {
  const key = `${workspaceId}\u0000${harnessSlug}\u0000${specificationRevision}`;
  const cached = snapshotCache.get(key);
  if (cached) return cached;
  const specification = await readBlueprintSpecificationSnapshotUncached(sql, workspaceId, harnessSlug, specificationRevision);
  if (specification) {
    if (snapshotCache.size >= SNAPSHOT_CACHE_MAX) snapshotCache.delete(snapshotCache.keys().next().value!);
    snapshotCache.set(key, deepFreeze(specification));
  }
  return specification;
}

async function readBlueprintSpecificationSnapshotUncached(
  sql: Sql | TransactionSql,
  workspaceId: string,
  harnessSlug: string,
  specificationRevision: string,
): Promise<CompiledAgentSpecification | null> {
  const rows = await sql<{ artifact: unknown }[]>`
    SELECT artifact FROM harness_shared.blueprint_specifications
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND specification_revision = ${specificationRevision}
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  const specification = replayAgentSpecification(rows[0].artifact);
  if (specification.specificationRevision !== specificationRevision) {
    throw new Error('stored blueprint specification revision does not match its lookup key');
  }
  return specification;
}

/**
 * Upsert a resolved blueprint into the PG cache. Idempotent on
 * (workspace_id, harness_slug). Returns the content hash written.
 *
 * The jsonb binds as `${JSON.stringify}::text::jsonb` (EI-2 /
 * agent-insights/postgres-js-jsonb-binding) — `sql.json()` throws
 * "string argument … Received an instance of Object" under the getOrgPg
 * runtime pool, which made every lazy projection through that pool (the
 * `system:blueprint-run` resolver) silently fall back to `coding`.
 */
export async function projectBlueprintToPg(
  sql: Sql,
  input: ProjectBlueprintInput,
): Promise<{ contentHash: string; specification?: CompiledAgentSpecification }> {
  const loaded = input.loaded ?? (!input.specification && input.sourcePath
    ? loadBlueprintFromFile(input.sourcePath, resolveSourceBlueprintExtends(input.sourcePath), blueprintRegistrySets()) : undefined);
  const specification = input.specification ? replayAgentSpecification(input.specification)
    : loaded ? await compileBlueprintWithPackages(loaded, {
      workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
    }) : undefined;
  if (input.blueprint.operations?.length && !specification) {
    throw new Error('operation-bearing blueprint projection requires a compiled specification with a pinned input closure');
  }
  if (specification && blueprintHash(BlueprintSchema.parse(specification.configuration)) !== blueprintHash(input.blueprint)) {
    throw new Error('compiled specification does not describe the blueprint being projected');
  }
  const scopeInput = specification?.inputs.find((entry) => entry.kind === 'setting' && entry.ref === 'bundle-scope');
  if (scopeInput?.kind === 'setting') {
    const scope = scopeInput.value as { workspaceId?: string; harnessSlug?: string };
    if (scope?.workspaceId !== input.workspaceId || scope?.harnessSlug !== input.harnessSlug) {
      throw new Error('compiled specification belongs to a different workspace or harness');
    }
  }
  if (specification && ((specification.configuration.bundles?.length ?? 0) || resolveSeedPackKey(specification.configuration).packId)) {
    await provisionBlueprintPackages(specification, blueprintPackageProvisioners(sql));
  }
  // Legacy blueprints have no operation manifest and keep their current one-row
  // projection cost. Only externally invocable operations need historical pins.
  if (specification?.configuration.operations?.length) {
    await retainBlueprintSpecificationSnapshot(sql, {
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      specification,
    });
  }
  const contentHash = specification?.specificationRevision ?? input.contentHash ?? blueprintHash(input.blueprint);
  await sql`
    INSERT INTO harness_shared.blueprints
      (workspace_id, harness_slug, blueprint_id, version, resolved, content_hash, source_path, source_commit)
    VALUES (
      ${input.workspaceId}, ${input.harnessSlug}, ${input.blueprint.id}, ${input.blueprint.version},
      ${JSON.stringify(input.blueprint)}::text::jsonb, ${contentHash},
      ${input.sourcePath ?? null}, ${input.sourceCommit ?? null}
    )
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE SET
      blueprint_id  = EXCLUDED.blueprint_id,
      version       = EXCLUDED.version,
      resolved      = EXCLUDED.resolved,
      content_hash  = EXCLUDED.content_hash,
      source_path   = EXCLUDED.source_path,
      source_commit = EXCLUDED.source_commit,
      projected_at  = now()
  `;
  return { contentHash, ...(specification ? { specification } : {}) };
}

/**
 * Read the cached resolved blueprint, re-validated through the schema (D-021:
 * validate on load — a corrupt cache row never reaches the interpreter). Returns
 * null when no row exists.
 */
export async function readBlueprintFromPg(
  sql: Sql,
  workspaceId: string,
  harnessSlug: string,
): Promise<Blueprint | null> {
  const rows = await sql<{ resolved: unknown }[]>`
    SELECT resolved FROM harness_shared.blueprints
    WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return BlueprintSchema.parse(rows[0].resolved);
}

/** Read just the cached content hash — a cheap drift check (no deserialize). */
export async function readBlueprintHashFromPg(
  sql: Sql | TransactionSql,
  workspaceId: string,
  harnessSlug: string,
): Promise<string | null> {
  const rows = await sql<{ content_hash: string }[]>`
    SELECT content_hash FROM harness_shared.blueprints
    WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
    LIMIT 1
  `;
  return rows[0]?.content_hash ?? null;
}

export interface EffectiveBlueprintOpts {
  workspaceId: string;
  harnessSlug: string;
  /** The git-canonical source to load on a cache miss (e.g. `<harnessDir>/.papercusp/blueprint.yaml`). */
  blueprintPath?: string | null;
}

/**
 * Resolve the effective blueprint for a harness: PG cache first; on a miss, load
 * the git-canonical file, project it, and return. Returns null when neither a
 * cache row nor a source file exists (caller falls back to the built-in default).
 */
export async function getEffectiveBlueprint(
  sql: Sql,
  opts: EffectiveBlueprintOpts,
): Promise<Blueprint | null> {
  const cached = await readBlueprintFromPg(sql, opts.workspaceId, opts.harnessSlug);
  if (cached) {
    // P-002: this is also the RUNTIME admission point (the cadence dispatcher
    // resolves the effective blueprint to RUN it). Register the cached blueprint's
    // harness-op proxies so they're live in THIS process before the program's
    // `requireCoordOp` fires — a cache hit skips the file-load registration below.
    registerHarnessOpProxies((cached.ops ?? []) as HarnessOpManifestEntry[]);
    return cached;
  }
  if (!opts.blueprintPath || !existsSync(opts.blueprintPath)) return null;
  // P-002: pre-register the source file's harness-op proxies BEFORE the load —
  // `resolveBlueprint` throws on `unknown-op`, so a program spine that references a
  // harness op needs its proxy live for validation to resolve it.
  preRegisterSourceFileOps(opts.blueprintPath);
  // P-001: validate ops/roles against the live registries at the PG-projection
  // chokepoint — the point a blueprint is admitted to the durable pipeline — so an
  // unregistered op is rejected here, not surfaced as a `requireCoordOp` throw mid
  // `coordProgramWorkflow`.
  const loaded = loadBlueprintFromFile(
    opts.blueprintPath,
    resolveSourceBlueprintExtends(opts.blueprintPath),
    blueprintRegistrySets(),
  );
  // Defensive: also register from the resolved blueprint (covers ops merged in via
  // `extends`, which the raw-file pre-register above wouldn't have seen).
  registerHarnessOpProxies((loaded.blueprint.ops ?? []) as HarnessOpManifestEntry[]);
  await projectBlueprintToPg(sql, {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    blueprint: loaded.blueprint,
    loaded,
    contentHash: loaded.contentHash,
    sourcePath: loaded.sourcePath,
  });
  return loaded.blueprint;
}
