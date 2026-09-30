/**
 * PG-backed capability-class registry and provider-conformance seam.
 *
 * P-016 deliberately extends the datatype-registry pattern: a registry resolves a
 * versioned contract locally, while later Cupboard work distributes it. Provider
 * conformance is append-only evidence derived from the live projected-tool
 * registry; pot bindings may only reference a provider backed by a passing run.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  pgvectorMetricSpec,
  type EmbedderProfileSpec,
  type EmbeddingDistanceMetric,
  type EmbeddingProfileId,
  type PgvectorIndexOperatorClass,
} from '@papercusp/memory';
import { canonicalJson } from './authority/authority-rpc-envelope';
import type { IdentityRecipeClassConformanceReport } from './agent-identities/recipe-provider-conformance';

export type JsonObject = Record<string, unknown>;

export interface CapabilityClassVerb {
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  /**
   * The capability a CLASS-FIRED reaction runs under (P-028, D-054 §4).
   *
   * A standalone rule fires `class:<ref>#<verb>` and its provider is resolved
   * per-pot at fire time, so the sandbox cannot be sourced from the fired tool
   * the way a plugin rule's is — installing a different provider would silently
   * widen what the rule may do. The class owns it instead. Optional because
   * classes predate this field; `validateClassFireTarget` refuses to register a
   * rule against a verb that lacks one rather than falling back to the tool's.
   */
  capability?: string;
}

export type CapabilityClassVerbs = Record<string, CapabilityClassVerb>;

export interface CapabilityClassVectorStorageProfile {
  readonly acceptedProfileIds: readonly EmbeddingProfileId[];
  readonly table: 'capability_class_registry';
  readonly column: 'embedding';
  readonly profileColumn: 'embedding_profile';
  readonly dimensions: number;
  readonly distanceMetric: EmbeddingDistanceMetric;
  readonly indexOperatorClass: PgvectorIndexOperatorClass;
  readonly indexName: 'capability_class_registry_embedding_hnsw_idx';
}

/** Physical storage facts, deliberately independent from the emitter registry.
 * Adding or changing an embedding profile never silently changes this table. */
export const CAPABILITY_CLASS_VECTOR_STORAGE_PROFILE: CapabilityClassVectorStorageProfile =
  Object.freeze({
    acceptedProfileIds: [
      'gemma-embeddinggemma-300m-768@v1',
      'openai-text-embedding-3-small-768@v1',
    ] as const,
    table: 'capability_class_registry',
    column: 'embedding',
    profileColumn: 'embedding_profile',
    dimensions: 768,
    distanceMetric: 'cosine',
    indexOperatorClass: 'vector_cosine_ops',
    indexName: 'capability_class_registry_embedding_hnsw_idx',
  });

export function validateCapabilityClassVectorStorageCompatibility(
  profile: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'>,
): string[] {
  const storage = CAPABILITY_CLASS_VECTOR_STORAGE_PROFILE;
  const problems: string[] = [];
  if (!storage.acceptedProfileIds.includes(profile.profileId)) {
    problems.push(
      `storage ${storage.table}.${storage.column} does not accept profile ${profile.profileId}; ` +
        `accepted=${storage.acceptedProfileIds.join(',') || '(none)'}`,
    );
  }
  if (storage.dimensions !== profile.targetDims) {
    problems.push(
      `storage ${storage.table}.${storage.column} has ${storage.dimensions} dimensions; ` +
        `profile ${profile.profileId} emits ${profile.targetDims}`,
    );
  }
  if (storage.distanceMetric !== profile.distanceMetric) {
    problems.push(
      `storage ${storage.table}.${storage.column} uses ${storage.distanceMetric}; ` +
        `profile ${profile.profileId} requires ${profile.distanceMetric}`,
    );
  }
  const metric = pgvectorMetricSpec(storage.distanceMetric);
  if (!metric) {
    problems.push(`storage ${storage.table}.${storage.column} has unsupported metric ${storage.distanceMetric}`);
  } else if (metric.indexOperatorClass !== storage.indexOperatorClass) {
    problems.push(
      `storage ${storage.table}.${storage.column} index ${storage.indexName} uses ` +
        `${storage.indexOperatorClass}; ${storage.distanceMetric} requires ${metric.indexOperatorClass}`,
    );
  }
  return problems;
}

export function capabilityClassVectorStorageAcceptsProfile(
  profile: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'>,
): boolean {
  return validateCapabilityClassVectorStorageCompatibility(profile).length === 0;
}

export interface CapabilityClassRow {
  id: string;
  version: string;
  ref: string;
  workspaceId: string;
  title: string;
  description: string;
  interfaceVerbs: CapabilityClassVerbs;
  behavioralSuiteRef: string | null;
  status: string;
  published: boolean;
  reviewStatus: string;
  tags: string[];
  hasEmbedding: boolean;
  embeddingProfile: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

export interface DefineCapabilityClassInput {
  workspaceId: string;
  id: string;
  version: string;
  title: string;
  description: string;
  interfaceVerbs: CapabilityClassVerbs;
  behavioralSuiteRef?: string | null;
  tags?: string[];
  embedding?: number[] | null;
  embeddingProfile?: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'> | null;
  createdBy?: string | null;
}

type ClassDbRow = {
  id: string;
  version: string;
  workspace_id: string;
  title: string;
  description: string;
  interface_verbs: unknown;
  behavioral_suite_ref: string | null;
  status: string;
  published: boolean;
  review_status: string;
  tags: string[] | null;
  has_embedding: boolean;
  embedding_profile: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  score?: number | string | null;
};

const asIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

function jsonObject(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function mapClassRow(row: ClassDbRow): CapabilityClassRow {
  return {
    id: row.id,
    version: row.version,
    ref: `${row.id}@${row.version}`,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    interfaceVerbs: jsonObject(row.interface_verbs) as CapabilityClassVerbs,
    behavioralSuiteRef: row.behavioral_suite_ref,
    status: row.status,
    published: row.published,
    reviewStatus: row.review_status,
    tags: row.tags ?? [],
    hasEmbedding: row.has_embedding,
    embeddingProfile: row.embedding_profile,
    createdBy: row.created_by,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    ...(row.score == null ? {} : { score: Number(row.score) }),
  };
}

const CLASS_SELECT = (sql: postgres.Sql | postgres.TransactionSql) => sql`
  id, version, workspace_id, title, description, interface_verbs,
  behavioral_suite_ref, status, published, review_status, tags,
  (embedding IS NOT NULL) AS has_embedding, embedding_profile,
  created_by, created_at, updated_at
`;

/** Namespace.job id, e.g. `crm.email`; punctuation never creates a second spelling. */
export function normalizeCapabilityClassId(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
}

export function capabilityClassRef(id: string, version: string): string {
  return `${normalizeCapabilityClassId(id)}@${version.trim()}`;
}

export function parseCapabilityClassRef(ref: string): { id: string; version: string } | null {
  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) return null;
  const id = normalizeCapabilityClassId(ref.slice(0, at));
  const version = ref.slice(at + 1).trim();
  return id && version ? { id, version } : null;
}

/** The one spelling of a class contract's identity rules, shared by the
 * platform-only classes:define tool and the Cupboard class-contract importer. */
export const CAPABILITY_CLASS_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
export const CAPABILITY_CLASS_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const CAPABILITY_CLASS_VERB_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** The immutable contract bytes compared for same-version replays. */
export function capabilityClassDefinitionShape(
  row: Pick<CapabilityClassRow, 'id' | 'version' | 'title' | 'description' | 'interfaceVerbs' | 'behavioralSuiteRef' | 'tags'>,
): JsonObject {
  return definitionShape(row);
}

function definitionShape(row: Pick<CapabilityClassRow, 'id' | 'version' | 'title' | 'description' | 'interfaceVerbs' | 'behavioralSuiteRef' | 'tags'>): JsonObject {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    description: row.description,
    interfaceVerbs: row.interfaceVerbs,
    behavioralSuiteRef: row.behavioralSuiteRef,
    tags: row.tags,
  };
}

/** Immutable per id@version: an identical replay is a no-op; changed bytes conflict. */
export async function defineCapabilityClass(
  sql: postgres.Sql,
  input: DefineCapabilityClassInput,
): Promise<{ created: boolean; capabilityClass: CapabilityClassRow; conflict: boolean }> {
  const embeddingLiteral = input.embedding?.length ? `[${input.embedding.join(',')}]` : null;
  if (embeddingLiteral && !input.embeddingProfile) {
    throw new Error('defineCapabilityClass: a stored embedding requires exact profile provenance');
  }
  if (
    embeddingLiteral
    && input.embeddingProfile
    && !capabilityClassVectorStorageAcceptsProfile(input.embeddingProfile)
  ) {
    throw new Error(
      `defineCapabilityClass: profile ${input.embeddingProfile.profileId} is incompatible with ` +
        `${CAPABILITY_CLASS_VECTOR_STORAGE_PROFILE.table}.${CAPABILITY_CLASS_VECTOR_STORAGE_PROFILE.column}`,
    );
  }
  const embeddingProfileId: string | null =
    embeddingLiteral && input.embeddingProfile ? input.embeddingProfile.profileId : null;
  const rows = await sql<ClassDbRow[]>`
    INSERT INTO harness_shared.capability_class_registry
      (workspace_id, id, version, title, description, interface_verbs,
       behavioral_suite_ref, tags, embedding, embedding_profile, created_by)
    VALUES (
      ${input.workspaceId}, ${input.id}, ${input.version}, ${input.title}, ${input.description},
      ${JSON.stringify(input.interfaceVerbs)}::text::jsonb,
      ${input.behavioralSuiteRef ?? null}, ${input.tags ?? []},
      ${embeddingLiteral}::vector, ${embeddingProfileId},
      ${input.createdBy ?? null}
    )
    ON CONFLICT (workspace_id, id, version) DO NOTHING
    RETURNING ${CLASS_SELECT(sql)}`;
  if (rows[0]) return { created: true, capabilityClass: mapClassRow(rows[0]), conflict: false };

  const existing = await getCapabilityClass(sql, input.workspaceId, input.id, input.version);
  if (!existing) throw new Error(`capability class ${input.id}@${input.version} conflicted but could not be re-read`);
  const proposed = definitionShape({
    ...input,
    behavioralSuiteRef: input.behavioralSuiteRef ?? null,
    tags: input.tags ?? [],
  });
  return {
    created: false,
    capabilityClass: existing,
    conflict: canonicalJson(definitionShape(existing)) !== canonicalJson(proposed),
  };
}

export async function getCapabilityClass(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  id: string,
  version?: string,
): Promise<CapabilityClassRow | null> {
  const versionClause = version ? sql`AND version = ${version}` : sql``;
  const rows = await sql<ClassDbRow[]>`
    SELECT ${CLASS_SELECT(sql)}
      FROM harness_shared.capability_class_registry
     WHERE workspace_id = ${workspaceId} AND id = ${id} ${versionClause}
     ORDER BY created_at DESC, version DESC
     LIMIT 1`;
  return rows[0] ? mapClassRow(rows[0]) : null;
}

export interface ListCapabilityClassesOptions {
  query?: string;
  tag?: string;
  includeInactive?: boolean;
  includeVersions?: boolean;
  limit?: number;
  embedding?: number[] | null;
  embeddingProfile?: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'> | null;
}

export async function listCapabilityClasses(
  sql: postgres.Sql,
  workspaceId: string,
  opts: ListCapabilityClassesOptions = {},
): Promise<CapabilityClassRow[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const statusClause = opts.includeInactive ? sql`` : sql`AND status = 'active'`;
  const tagClause = opts.tag ? sql`AND ${opts.tag} = ANY(tags)` : sql``;
  const tokens = (opts.query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2);
  const textQuery = tokens.length ? tokens.join(' | ') : null;
  const embeddingLiteral =
    opts.embedding?.length
    && opts.embeddingProfile
    && capabilityClassVectorStorageAcceptsProfile(opts.embeddingProfile)
      ? `[${opts.embedding.join(',')}]`
      : null;
  const embeddingProfileId = embeddingLiteral ? opts.embeddingProfile?.profileId ?? null : null;
  const exactEmbedding = embeddingProfileId
    ? sql`embedding IS NOT NULL AND embedding_profile = ${embeddingProfileId}`
    : sql`FALSE`;

  let rows: ClassDbRow[];
  if (textQuery && embeddingLiteral) {
    rows = await sql<ClassDbRow[]>`
      SELECT ${CLASS_SELECT(sql)},
             GREATEST(
               ts_rank(title_tsv, to_tsquery('english', ${textQuery})),
               0.4 * ts_rank(title_tsv, to_tsquery('english', ${textQuery}))
                 + 0.6 * CASE WHEN ${exactEmbedding}
                              THEN 1 - (embedding <=> ${embeddingLiteral}::vector)
                              ELSE 0 END
             ) AS score
        FROM harness_shared.capability_class_registry
       WHERE workspace_id = ${workspaceId} ${statusClause} ${tagClause}
         AND (title_tsv @@ to_tsquery('english', ${textQuery}) OR ${exactEmbedding})
       ORDER BY score DESC, updated_at DESC, id, version DESC
       LIMIT ${limit * (opts.includeVersions ? 1 : 4)}`;
  } else if (textQuery) {
    rows = await sql<ClassDbRow[]>`
      SELECT ${CLASS_SELECT(sql)}, ts_rank(title_tsv, to_tsquery('english', ${textQuery})) AS score
        FROM harness_shared.capability_class_registry
       WHERE workspace_id = ${workspaceId} ${statusClause} ${tagClause}
         AND title_tsv @@ to_tsquery('english', ${textQuery})
       ORDER BY score DESC, updated_at DESC, id, version DESC
       LIMIT ${limit * (opts.includeVersions ? 1 : 4)}`;
  } else {
    rows = await sql<ClassDbRow[]>`
      SELECT ${CLASS_SELECT(sql)}
        FROM harness_shared.capability_class_registry
       WHERE workspace_id = ${workspaceId} ${statusClause} ${tagClause}
       ORDER BY updated_at DESC, id, version DESC
       LIMIT ${limit * (opts.includeVersions ? 1 : 4)}`;
  }

  const mapped = rows.map(mapClassRow);
  if (opts.includeVersions) return mapped.slice(0, limit);
  const seen = new Set<string>();
  return mapped.filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id))).slice(0, limit);
}

export interface ProviderToolContract {
  name: string;
  pluginName: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject | null;
}

export interface ProviderConformanceCheck {
  verb: string;
  tool: string | null;
  ok: boolean;
  problems: string[];
}

export interface ProviderConformanceReport {
  schemaVersion: 'capability-class-structural-v1';
  ok: boolean;
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  registryRevision: string;
  checks: ProviderConformanceCheck[];
  behavioral: { status: 'not-required' | 'not-run'; suiteRef: string | null };
}

/** Pure structural conformance: every class verb is bound to a real tool owned by this provider. */
export function validateProviderInterface(input: {
  capabilityClass: CapabilityClassRow;
  providerPackage: string;
  providerVersion: string;
  registryRevision: string;
  verbBindings: Record<string, string>;
  lookup: (toolName: string) => ProviderToolContract | null;
}): ProviderConformanceReport {
  const declared = Object.keys(input.capabilityClass.interfaceVerbs).sort();
  const supplied = Object.keys(input.verbBindings).sort();
  const extras = supplied.filter((verb) => !declared.includes(verb));
  const checks = declared.map((verb): ProviderConformanceCheck => {
    const toolName = input.verbBindings[verb] ?? null;
    const problems: string[] = [];
    if (!toolName) problems.push('missing provider tool binding');
    const actual = toolName ? input.lookup(toolName) : null;
    if (toolName && !actual) problems.push('tool is not present in the live projected-tool registry');
    if (actual && actual.pluginName !== input.providerPackage) {
      problems.push(`tool is owned by ${actual.pluginName}, not provider package ${input.providerPackage}`);
    }
    const expected = input.capabilityClass.interfaceVerbs[verb]!;
    if (actual && canonicalJson(actual.inputSchema) !== canonicalJson(expected.inputSchema)) {
      problems.push('input schema differs from the class contract');
    }
    if (actual && expected.outputSchema && canonicalJson(actual.outputSchema) !== canonicalJson(expected.outputSchema)) {
      problems.push(actual.outputSchema ? 'output schema differs from the class contract' : 'tool declares no output schema');
    }
    return { verb, tool: toolName, ok: problems.length === 0, problems };
  });
  for (const extra of extras) {
    checks.push({
      verb: extra,
      tool: input.verbBindings[extra] ?? null,
      ok: false,
      problems: ['binding names a verb the class does not declare'],
    });
  }
  return {
    schemaVersion: 'capability-class-structural-v1',
    ok: checks.every((check) => check.ok),
    classRef: input.capabilityClass.ref,
    providerPackage: input.providerPackage,
    providerVersion: input.providerVersion,
    registryRevision: input.registryRevision,
    checks,
    behavioral: {
      status: input.capabilityClass.behavioralSuiteRef ? 'not-run' : 'not-required',
      suiteRef: input.capabilityClass.behavioralSuiteRef,
    },
  };
}

/** The blueprint-declared contract of one operation, as a compiled specification pins it. */
export interface ProviderOperationContract {
  inputSchema: JsonObject;
  resultSchema: JsonObject;
}

export interface OperationProviderConformanceReport {
  schemaVersion: 'capability-class-operation-v1';
  ok: boolean;
  classRef: string;
  /** `blueprint:<harnessSlug>` — the harness blueprint that declares the operations. */
  providerPackage: string;
  providerVersion: string;
  /** The compiled specification revision every operation was checked against. */
  registryRevision: string;
  harnessSlug: string;
  checks: ProviderConformanceCheck[];
  behavioral: { status: 'not-required' | 'not-run'; suiteRef: string | null };
}

/** The provider package an operation provider must carry (D-030 §1). */
export function blueprintOperationProviderPackage(harnessSlug: string): string {
  return `blueprint:${harnessSlug}`;
}

/**
 * Pure structural conformance for an `operation` provider (portable-identity-
 * packages D-030 §1): every class verb is bound to an operation the harness's
 * compiled specification declares, with the verb's input schema and, when the
 * verb declares one, its output schema as the operation's result schema.
 */
export function validateOperationProviderInterface(input: {
  capabilityClass: CapabilityClassRow;
  harnessSlug: string;
  providerVersion: string;
  specificationRevision: string;
  verbBindings: Record<string, string>;
  lookup: (operationId: string) => ProviderOperationContract | null;
}): OperationProviderConformanceReport {
  const declared = Object.keys(input.capabilityClass.interfaceVerbs).sort();
  const extras = Object.keys(input.verbBindings).filter((verb) => !declared.includes(verb)).sort();
  const checks = declared.map((verb): ProviderConformanceCheck => {
    const operationId = input.verbBindings[verb] ?? null;
    const problems: string[] = [];
    if (!operationId) problems.push('missing provider operation binding');
    const actual = operationId ? input.lookup(operationId) : null;
    if (operationId && !actual) problems.push('operation is not declared by the compiled blueprint specification');
    const expected = input.capabilityClass.interfaceVerbs[verb]!;
    if (actual && canonicalJson(actual.inputSchema) !== canonicalJson(expected.inputSchema)) {
      problems.push('input schema differs from the class contract');
    }
    if (actual && expected.outputSchema && canonicalJson(actual.resultSchema) !== canonicalJson(expected.outputSchema)) {
      problems.push('result schema differs from the class output contract');
    }
    return { verb, tool: operationId, ok: problems.length === 0, problems };
  });
  for (const extra of extras) {
    checks.push({
      verb: extra,
      tool: input.verbBindings[extra] ?? null,
      ok: false,
      problems: ['binding names a verb the class does not declare'],
    });
  }
  return {
    schemaVersion: 'capability-class-operation-v1',
    ok: checks.every((check) => check.ok),
    classRef: input.capabilityClass.ref,
    providerPackage: blueprintOperationProviderPackage(input.harnessSlug),
    providerVersion: input.providerVersion,
    registryRevision: input.specificationRevision,
    harnessSlug: input.harnessSlug,
    checks,
    behavioral: {
      status: input.capabilityClass.behavioralSuiteRef ? 'not-run' : 'not-required',
      suiteRef: input.capabilityClass.behavioralSuiteRef,
    },
  };
}

export type CapabilityProviderKind = 'tool' | 'recipe' | 'operation';
export type CapabilityProviderLatencyClass = 'sync' | 'async';

/** Attested execution metadata returned by current registry reads. Historical
 * tool-only snapshots retain ProviderBindingRow's original contract; a new
 * execution consumer must require this contract as well, never infer a kind. */
export interface ProviderExecutionContract {
  providerKind: CapabilityProviderKind;
  latencyClass: CapabilityProviderLatencyClass;
  /** Present only for recipes inspected through the canonical host inspector.
   * Legacy/synthetic kind-only rows remain unavailable to execution consumers. */
  recipeInspections?: IdentityRecipeClassConformanceReport['recipes'];
  /** Present only for an `operation` provider: the harness whose blueprint declares the operations. */
  operationHarnessSlug?: string;
}

export interface ProviderBindingRow {
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  verbBindings: Record<string, string>;
  conformanceRunId: string;
  conformanceStatus: 'passed';
  behavioralStatus: string;
  behavioralRunRef: string | null;
  registryRevision: string;
  status: string;
  updatedAt: string;
}

/**
 * Install-time evidence for one active provider candidate.
 *
 * Price is intentionally not stored here: it belongs to the distributable
 * provider listing, not the conformance registry. P-017's resolver joins that
 * evidence through an injected seam and represents an unavailable price as
 * null rather than inventing a free/zero value. The registry does own the two
 * facts below: immutable structural-run history and current pot adoption.
 */
export interface CapabilityProviderCandidateRow extends ProviderBindingRow {
  passingStructuralRuns: number;
  totalStructuralRuns: number;
  activePotBindings: number;
}

export interface PotCapabilityProviderBindingRow extends ProviderBindingRow {
  potSlug: string;
  boundBy: string | null;
  boundAt: string;
}

export interface CapabilityProviderDependentRow {
  potSlug: string;
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  boundBy: string | null;
  boundAt: string;
  updatedAt: string;
}

type BindingDbRow = {
  class_id: string;
  class_version: string;
  provider_package: string;
  provider_version: string;
  provider_kind: string;
  latency_class: string;
  verb_bindings: unknown;
  conformance_run_id: string;
  structural_passed: boolean;
  behavioral_status: string;
  behavioral_run_ref: string | null;
  registry_revision: string;
  report?: unknown;
  status: string;
  updated_at: Date | string;
};

type CandidateDbRow = BindingDbRow & {
  passing_structural_runs: number | string;
  total_structural_runs: number | string;
  active_pot_bindings: number | string;
};

type PotBindingDbRow = BindingDbRow & {
  pot_slug: string;
  bound_by: string | null;
  bound_at: Date | string;
};

type ProviderDependentDbRow = {
  pot_slug: string;
  class_id: string;
  class_version: string;
  provider_package: string;
  provider_version: string;
  bound_by: string | null;
  bound_at: Date | string;
  updated_at: Date | string;
};

function mapBinding(row: BindingDbRow): ProviderBindingRow & ProviderExecutionContract {
  if (!row.structural_passed) {
    throw new Error(`provider binding ${row.conformance_run_id} does not reference a passing conformance run`);
  }
  if (!(
    ((row.provider_kind === 'tool' || row.provider_kind === 'recipe') && row.latency_class === 'sync') ||
    (row.provider_kind === 'operation' && row.latency_class === 'async')
  )) {
    throw new Error(`provider binding ${row.conformance_run_id} has an invalid execution contract`);
  }
  const report = jsonObject(row.report);
  const recipeInspections = row.provider_kind === 'recipe' && report.schemaVersion === 'capability-class-recipe-v1'
    ? jsonObject(report.recipes) as IdentityRecipeClassConformanceReport['recipes'] : undefined;
  const operationHarnessSlug = row.provider_kind === 'operation' &&
    report.schemaVersion === 'capability-class-operation-v1' && typeof report.harnessSlug === 'string'
    ? report.harnessSlug : undefined;
  return {
    classRef: `${row.class_id}@${row.class_version}`,
    providerPackage: row.provider_package,
    providerVersion: row.provider_version,
    providerKind: row.provider_kind as CapabilityProviderKind,
    latencyClass: row.latency_class as CapabilityProviderLatencyClass,
    ...(recipeInspections ? { recipeInspections } : {}),
    ...(operationHarnessSlug ? { operationHarnessSlug } : {}),
    verbBindings: jsonObject(row.verb_bindings) as Record<string, string>,
    conformanceRunId: row.conformance_run_id,
    conformanceStatus: 'passed',
    behavioralStatus: row.behavioral_status,
    behavioralRunRef: row.behavioral_run_ref,
    registryRevision: row.registry_revision,
    status: row.status,
    updatedAt: asIso(row.updated_at),
  };
}

const BINDING_SELECT = (sql: postgres.Sql | postgres.TransactionSql) => sql`
  b.class_id, b.class_version, b.provider_package, b.provider_version, b.provider_kind, b.latency_class,
  r.verb_bindings, b.conformance_run_id, r.structural_passed,
  r.behavioral_status, r.behavioral_run_ref, r.registry_revision, r.report,
  b.status, b.updated_at
`;

/** Record every run; only a passing structural run can create/update a provider binding. */
export async function recordProviderConformance(
  sql: postgres.Sql,
  input: {
    workspaceId: string;
    classId: string;
    classVersion: string;
    providerPackage: string;
    providerVersion: string;
    verbBindings: Record<string, string>;
    report: ProviderConformanceReport | IdentityRecipeClassConformanceReport | OperationProviderConformanceReport;
    performedBy?: string | null;
  },
): Promise<{ runId: string; binding: (ProviderBindingRow & ProviderExecutionContract) | null }> {
  const expectedClassRef = `${input.classId}@${input.classVersion}`;
  if (
    input.report.classRef !== expectedClassRef ||
    input.report.providerPackage !== input.providerPackage ||
    input.report.providerVersion !== input.providerVersion
  ) {
    throw new Error('conformance report identity does not match the class/provider tuple being recorded');
  }
  if (input.report.ok !== input.report.checks.every((check) => check.ok)) {
    throw new Error('conformance report verdict does not match its per-verb checks');
  }
  if (input.report.schemaVersion !== 'capability-class-structural-v1' &&
      input.report.schemaVersion !== 'capability-class-recipe-v1' &&
      input.report.schemaVersion !== 'capability-class-operation-v1') {
    throw new Error('unsupported provider conformance report schema');
  }
  if (input.report.schemaVersion === 'capability-class-operation-v1') {
    // D-030 §1: the operations belong to the blueprint the package names, and
    // each check's binding is exactly the one being recorded.
    if (input.report.providerPackage !== blueprintOperationProviderPackage(input.report.harnessSlug)) {
      throw new Error('an operation provider package must be blueprint:<the harness whose blueprint declares the operations>');
    }
    if (input.report.checks.some((check) => (input.verbBindings[check.verb] ?? null) !== check.tool)) {
      throw new Error('operation conformance checks do not match the verb bindings being recorded');
    }
  }
  const providerKind: CapabilityProviderKind =
    input.report.schemaVersion === 'capability-class-recipe-v1' ? 'recipe'
      : input.report.schemaVersion === 'capability-class-operation-v1' ? 'operation' : 'tool';
  const latencyClass: CapabilityProviderLatencyClass = providerKind === 'operation' ? 'async' : 'sync';
  const runId = randomUUID();
  return sql.begin(async (tx) => {
    if (input.report.schemaVersion === 'capability-class-recipe-v1') {
      const capabilityClass = await getCapabilityClass(tx, input.workspaceId, input.classId, input.classVersion);
      if (!capabilityClass) throw new Error('recipe conformance requires a registered class contract');
      const { assertIdentityRecipeClassConformance } = await import('./agent-identities/recipe-provider-conformance');
      assertIdentityRecipeClassConformance({ report: input.report, capabilityClass, verbBindings: input.verbBindings });
    }
    await tx`
      INSERT INTO harness_shared.capability_class_conformance_runs
        (id, workspace_id, class_id, class_version, provider_package, provider_version,
         provider_kind, latency_class, registry_revision, verb_bindings, structural_passed, behavioral_status,
         behavioral_run_ref, report, performed_by)
      VALUES (
        ${runId}, ${input.workspaceId}, ${input.classId}, ${input.classVersion},
        ${input.providerPackage}, ${input.providerVersion}, ${providerKind}, ${latencyClass}, ${input.report.registryRevision},
        ${JSON.stringify(input.verbBindings)}::text::jsonb, ${input.report.ok},
        ${input.report.behavioral.status}, NULL,
        ${JSON.stringify(input.report)}::text::jsonb, ${input.performedBy ?? null}
      )`;
    if (!input.report.ok) return { runId, binding: null };
    const rows = await tx<BindingDbRow[]>`
      WITH upserted AS (
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version,
         conformance_run_id, provider_kind, latency_class)
      VALUES (
        ${input.workspaceId}, ${input.classId}, ${input.classVersion},
        ${input.providerPackage}, ${input.providerVersion}, ${runId}, ${providerKind}, ${latencyClass}
      )
      ON CONFLICT (workspace_id, class_id, class_version, provider_package, provider_version)
      DO UPDATE SET
        conformance_run_id = EXCLUDED.conformance_run_id,
        provider_kind = EXCLUDED.provider_kind,
        latency_class = EXCLUDED.latency_class,
        status = 'active',
        updated_at = now()
      RETURNING
        class_id, class_version, provider_package, provider_version,
        conformance_run_id, provider_kind, latency_class, status, updated_at
      )
      SELECT
        u.class_id, u.class_version, u.provider_package, u.provider_version, u.provider_kind, u.latency_class,
        r.verb_bindings, u.conformance_run_id, r.structural_passed,
        r.behavioral_status, r.behavioral_run_ref, r.registry_revision, r.report,
        u.status, u.updated_at
      FROM upserted u
      JOIN harness_shared.capability_class_conformance_runs r
        ON r.id = u.conformance_run_id`;
    return { runId, binding: mapBinding(rows[0]!) };
  });
}

export async function listProviderBindings(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  classId: string,
  classVersion: string,
): Promise<Array<ProviderBindingRow & ProviderExecutionContract>> {
  const rows = await sql<BindingDbRow[]>`
    SELECT ${BINDING_SELECT(sql)}
      FROM harness_shared.capability_class_provider_bindings b
      JOIN harness_shared.capability_class_conformance_runs r
        ON r.id = b.conformance_run_id
     WHERE b.workspace_id = ${workspaceId}
       AND b.class_id = ${classId}
       AND b.class_version = ${classVersion}
       AND b.status = 'active'
       AND r.structural_passed = true
     ORDER BY b.provider_package, b.provider_version DESC`;
  return rows.map(mapBinding);
}

function mapCandidate(row: CandidateDbRow): CapabilityProviderCandidateRow & ProviderExecutionContract {
  return {
    ...mapBinding(row),
    passingStructuralRuns: Number(row.passing_structural_runs),
    totalStructuralRuns: Number(row.total_structural_runs),
    activePotBindings: Number(row.active_pot_bindings),
  };
}

function mapPotBinding(row: PotBindingDbRow): PotCapabilityProviderBindingRow & ProviderExecutionContract {
  return {
    ...mapBinding(row),
    potSlug: row.pot_slug,
    boundBy: row.bound_by,
    boundAt: asIso(row.bound_at),
  };
}

/**
 * Exact current pot choice. Only an active provider backed by a passing run can
 * satisfy a new identity install; a retired provider therefore cannot silently
 * satisfy a grant merely because an old pot row still points at it.
 */
export async function getPotCapabilityProviderBinding(
  sql: postgres.Sql | postgres.TransactionSql,
  input: {
    workspaceId: string;
    potSlug: string;
    classId: string;
    classVersion: string;
    includeInactiveProvider?: boolean;
    /** Legacy grant/compiler callers resolve tools only. New typed execution
     * callers opt in to other kinds, then enforce their own admission policy. */
    providerKinds?: readonly CapabilityProviderKind[];
  },
): Promise<(PotCapabilityProviderBindingRow & ProviderExecutionContract) | null> {
  const providerKinds = input.providerKinds ?? ['tool'];
  if (providerKinds.length === 0) return null;
  const statusClause = input.includeInactiveProvider ? sql`` : sql`AND b.status = 'active'`;
  const rows = await sql<PotBindingDbRow[]>`
    SELECT ${BINDING_SELECT(sql)},
           p.pot_slug, p.bound_by, p.bound_at
      FROM harness_shared.pot_capability_class_bindings p
      JOIN harness_shared.capability_class_provider_bindings b
        ON b.workspace_id = p.workspace_id
       AND b.class_id = p.class_id
       AND b.class_version = p.class_version
       AND b.provider_package = p.provider_package
       AND b.provider_version = p.provider_version
       AND b.provider_kind = p.provider_kind
       AND b.latency_class = p.latency_class
      JOIN harness_shared.capability_class_conformance_runs r
        ON r.id = b.conformance_run_id
     WHERE p.workspace_id = ${input.workspaceId}
       AND p.pot_slug = ${input.potSlug}
       AND p.class_id = ${input.classId}
       AND p.class_version = ${input.classVersion}
       AND b.provider_kind IN ${sql(providerKinds)}
       ${statusClause}
       AND r.structural_passed = true
     LIMIT 1`;
  return rows[0] ? mapPotBinding(rows[0]) : null;
}

/**
 * Active conformant candidates plus the evidence the local registry can prove.
 * Marketplace price evidence is deliberately joined by the install resolver,
 * because a missing price must remain unknown rather than becoming zero.
 */
export async function listActiveCapabilityProviderCandidates(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  classId: string,
  classVersion: string,
  /** Same opt-in contract as getPotCapabilityProviderBinding: tools unless a
   * typed caller names other kinds and enforces their admission (P-013). */
  options: { providerKinds?: readonly CapabilityProviderKind[] } = {},
): Promise<Array<CapabilityProviderCandidateRow & ProviderExecutionContract>> {
  const providerKinds = options.providerKinds ?? ['tool'];
  if (providerKinds.length === 0) return [];
  const rows = await sql<CandidateDbRow[]>`
    SELECT ${BINDING_SELECT(sql)},
           (
             SELECT count(*)::int
               FROM harness_shared.capability_class_conformance_runs history
              WHERE history.workspace_id = b.workspace_id
                AND history.class_id = b.class_id
                AND history.class_version = b.class_version
                AND history.provider_package = b.provider_package
                AND history.provider_version = b.provider_version
                AND history.structural_passed = true
           ) AS passing_structural_runs,
           (
             SELECT count(*)::int
               FROM harness_shared.capability_class_conformance_runs history
              WHERE history.workspace_id = b.workspace_id
                AND history.class_id = b.class_id
                AND history.class_version = b.class_version
                AND history.provider_package = b.provider_package
                AND history.provider_version = b.provider_version
           ) AS total_structural_runs,
           (
             SELECT count(*)::int
               FROM harness_shared.pot_capability_class_bindings pot_binding
              WHERE pot_binding.workspace_id = b.workspace_id
                AND pot_binding.class_id = b.class_id
                AND pot_binding.class_version = b.class_version
                AND pot_binding.provider_package = b.provider_package
                AND pot_binding.provider_version = b.provider_version
           ) AS active_pot_bindings
      FROM harness_shared.capability_class_provider_bindings b
      JOIN harness_shared.capability_class_conformance_runs r
        ON r.id = b.conformance_run_id
     WHERE b.workspace_id = ${workspaceId}
       AND b.class_id = ${classId}
       AND b.class_version = ${classVersion}
       AND b.provider_kind IN ${sql(providerKinds)}
       AND b.status = 'active'
       AND r.structural_passed = true
     ORDER BY b.provider_package, b.provider_version DESC`;
  return rows.map(mapCandidate);
}

/**
 * Reverse edge used by provider uninstall review. These are current pot/class
 * dependents, regardless of whether the provider binding has since retired:
 * retirement must make the warning louder, not erase the dependency.
 */
export async function listCapabilityProviderDependents(
  sql: postgres.Sql | postgres.TransactionSql,
  input: {
    workspaceId: string;
    providerPackage: string;
    providerVersion?: string;
  },
): Promise<CapabilityProviderDependentRow[]> {
  const versionClause = input.providerVersion
    ? sql`AND provider_version = ${input.providerVersion}`
    : sql``;
  const rows = await sql<ProviderDependentDbRow[]>`
    SELECT pot_slug, class_id, class_version, provider_package, provider_version,
           bound_by, bound_at, updated_at
      FROM harness_shared.pot_capability_class_bindings
     WHERE workspace_id = ${input.workspaceId}
       AND provider_package = ${input.providerPackage}
       ${versionClause}
     ORDER BY pot_slug, class_id, class_version, provider_version`;
  return rows.map((row) => ({
    potSlug: row.pot_slug,
    classRef: `${row.class_id}@${row.class_version}`,
    providerPackage: row.provider_package,
    providerVersion: row.provider_version,
    boundBy: row.bound_by,
    boundAt: asIso(row.bound_at),
    updatedAt: asIso(row.updated_at),
  }));
}

/** Storage seam for P-017's resolver/picker; FK proves the provider already conformed. */
export async function bindCapabilityProviderToPot(
  sql: postgres.Sql | postgres.TransactionSql,
  input: {
    workspaceId: string;
    potSlug: string;
    classId: string;
    classVersion: string;
    providerPackage: string;
    providerVersion: string;
    boundBy?: string | null;
    /** Omission is the old tool-only selection contract. A typed caller must
     * explicitly select any other kind; the DB proves its run and latency. */
    providerKind?: CapabilityProviderKind;
    /** Never replace an existing pot choice (the install journal's write, P-014):
     * a conflicting row refuses exactly like an absent provider. */
    createOnly?: boolean;
  },
): Promise<void> {
  const onConflict = input.createOnly ? sql`DO NOTHING` : sql`
    DO UPDATE SET
      provider_package = EXCLUDED.provider_package,
      provider_version = EXCLUDED.provider_version,
      provider_kind = EXCLUDED.provider_kind,
      latency_class = EXCLUDED.latency_class,
      bound_by = EXCLUDED.bound_by,
      updated_at = now()`;
  const rows = await sql<{ pot_slug: string }[]>`
    INSERT INTO harness_shared.pot_capability_class_bindings
      (workspace_id, pot_slug, class_id, class_version, provider_package, provider_version, bound_by,
       provider_kind, latency_class)
    SELECT b.workspace_id, ${input.potSlug}, b.class_id, b.class_version,
           b.provider_package, b.provider_version, ${input.boundBy ?? null}, b.provider_kind, b.latency_class
      FROM harness_shared.capability_class_provider_bindings b
     WHERE b.workspace_id = ${input.workspaceId} AND b.class_id = ${input.classId}
       AND b.class_version = ${input.classVersion} AND b.provider_package = ${input.providerPackage}
       AND b.provider_version = ${input.providerVersion}
       AND b.provider_kind = ${input.providerKind ?? 'tool'} AND b.status = 'active'
    ON CONFLICT (workspace_id, pot_slug, class_id, class_version)
    ${onConflict}
    RETURNING pot_slug`;
  if (rows.length === 0) {
    throw new Error(input.createOnly
      ? 'capability provider is absent, inactive, of a different execution kind, or the pot already binds this class'
      : 'capability provider is absent, inactive, or has a different execution kind');
  }
}

/**
 * Compensation seam for an install that selected a new binding but failed
 * before its blueprint release committed. The expected provider tuple prevents
 * deleting a choice another concurrent actor changed after this installer ran.
 */
export async function deletePotCapabilityProviderBinding(
  sql: postgres.Sql | postgres.TransactionSql,
  input: {
    workspaceId: string;
    potSlug: string;
    classId: string;
    classVersion: string;
    expectedProviderPackage: string;
    expectedProviderVersion: string;
    /** Also require the writer's stamp, so a re-bind to the same provider by
     * another owner is never deleted as if it were the original write. */
    expectedBoundBy?: string;
  },
): Promise<boolean> {
  const boundByClause = input.expectedBoundBy === undefined ? sql`` : sql`AND bound_by = ${input.expectedBoundBy}`;
  const rows = await sql<{ pot_slug: string }[]>`
    DELETE FROM harness_shared.pot_capability_class_bindings
     WHERE workspace_id = ${input.workspaceId}
       AND pot_slug = ${input.potSlug}
       AND class_id = ${input.classId}
       AND class_version = ${input.classVersion}
       AND provider_package = ${input.expectedProviderPackage}
       AND provider_version = ${input.expectedProviderVersion}
       ${boundByClause}
    RETURNING pot_slug`;
  return rows.length > 0;
}
