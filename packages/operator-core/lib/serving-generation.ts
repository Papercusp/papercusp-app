/**
 * A serving generation ties the MCP surface to the exact operator process and
 * database schema frontier that served it. This is deliberately separate from
 * `projectedToolRegistryRevision`: that function remains a pure identity for
 * the projected tool definitions, while this module composes all three inputs
 * at the operator boundary.
 */
import { createHash } from 'node:crypto';
import { projectedToolRegistryRevision } from '@papercusp/agent-mcp';
import {
  readAppliedMigrationLedgerIdentity,
  type AppliedMigrationLedgerIdentity,
} from './migration-drift';
import { getServingHostIdentity } from './serving-host-identity';

export type ServingGenerationUnknownReason =
  | 'build-sha-unknown'
  | 'applied-migrations-unknown'
  | 'tool-registry-revision-unknown';

export interface KnownServingGeneration {
  state: 'known';
  revision: string;
  buildSha: string;
  appliedMigrationDigest: string;
  toolRegistryRevision: string;
}

export interface UnknownServingGeneration {
  state: 'unknown';
  reason: ServingGenerationUnknownReason;
  migrationReason?: 'query-failed' | 'malformed-ledger';
}

export type ServingGeneration = KnownServingGeneration | UnknownServingGeneration;

export interface ServingGenerationInputs {
  /** SHA baked into the process that is answering, never inferred from checkout HEAD. */
  buildSha: string | null | undefined;
  /** Exact applied filename+sha256 frontier, with query failure kept explicit. */
  appliedMigrations: AppliedMigrationLedgerIdentity;
  /** Pure revision of the projected tool contracts. */
  toolRegistryRevision: string | null | undefined;
}

export function composeServingGeneration(input: ServingGenerationInputs): ServingGeneration {
  if (!input.buildSha?.trim()) return { state: 'unknown', reason: 'build-sha-unknown' };
  if (input.appliedMigrations.state !== 'known') {
    return {
      state: 'unknown',
      reason: 'applied-migrations-unknown',
      migrationReason: input.appliedMigrations.reason,
    };
  }
  if (!input.toolRegistryRevision?.trim() || input.toolRegistryRevision === 'unknown') {
    return { state: 'unknown', reason: 'tool-registry-revision-unknown' };
  }

  const parts = {
    schemaVersion: 'papercusp-serving-generation-v1',
    buildSha: input.buildSha.trim(),
    appliedMigrationDigest: input.appliedMigrations.digest,
    toolRegistryRevision: input.toolRegistryRevision,
  };
  const digest = createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
  return {
    state: 'known',
    revision: `serving-generation-v1:${digest}`,
    buildSha: parts.buildSha,
    appliedMigrationDigest: parts.appliedMigrationDigest,
    toolRegistryRevision: parts.toolRegistryRevision,
  };
}

/**
 * Read the current serving generation. There is no cache: a migration may be
 * applied while a process stays alive, and tools/call must observe that change
 * before dispatch. The optional seams are for list snapshots and deterministic
 * tests; production callers use the process identity, DB ledger, and live MCP
 * projection by default.
 */
export async function readServingGeneration(opts: {
  buildSha?: string | null;
  appliedMigrations?: AppliedMigrationLedgerIdentity;
  readAppliedMigrations?: () => Promise<AppliedMigrationLedgerIdentity>;
  toolRegistryRevision?: string | null;
} = {}): Promise<ServingGeneration> {
  let buildSha = opts.buildSha;
  if (buildSha === undefined) {
    try {
      buildSha = getServingHostIdentity().buildSha;
    } catch {
      buildSha = null;
    }
  }

  let toolRevision = opts.toolRegistryRevision;
  if (toolRevision === undefined) {
    try {
      toolRevision = projectedToolRegistryRevision();
    } catch {
      toolRevision = null;
    }
  }

  let migrations = opts.appliedMigrations;
  if (migrations === undefined) {
    try {
      migrations = await (opts.readAppliedMigrations ?? readAppliedMigrationLedgerIdentity)();
    } catch {
      migrations = { state: 'unknown', reason: 'query-failed' };
    }
  }

  return composeServingGeneration({
    buildSha,
    appliedMigrations: migrations,
    toolRegistryRevision: toolRevision,
  });
}

export function describeServingGeneration(generation: ServingGeneration): string {
  return generation.state === 'known' ? generation.revision : `unknown (${generation.reason})`;
}
