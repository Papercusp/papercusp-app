import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type postgres from 'postgres';
import { defaultRunGit, type RunGit } from './storage';
import { hashBlob } from './sigrefs';
import { makeSignedProtocolContext, type SignedProtocolContext, type SignedProtocolScope } from './signed-context';
import type { GitServingRequest } from './serving-capability';

/** Local Git metadata outside fetched namespaces. PG alone cannot detect a
 * deleted/rebuilt bare store, so the physical incarnation marker lives in Git. */
export const STORE_INCARNATION_REF = 'refs/papercusp/store-incarnation';

export async function ensureStoreIncarnation(repoPath: string, runGit: RunGit = defaultRunGit): Promise<string> {
  const read = async (): Promise<string | null> => {
    const r = await runGit(['rev-parse', '--verify', '--quiet', STORE_INCARNATION_REF], repoPath);
    if (r.code === 1) return null;
    if (r.code !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.stdout.trim())) {
      throw new Error(`pot-git: cannot read store incarnation: ${r.stderr.trim()}`);
    }
    return r.stdout.trim();
  };
  const existing = await read();
  if (existing) return existing;
  const nonce = await hashBlob(repoPath, randomBytes(32).toString('hex'), runGit);
  const write = await runGit(['update-ref', STORE_INCARNATION_REF, nonce, '0'.repeat(nonce.length)], repoPath);
  if (write.code === 0) return nonce;
  const winner = await read();
  if (winner) return winner;
  throw new Error(`pot-git: cannot initialize store incarnation: ${write.stderr.trim()}`);
}

interface StoreGenerationRecord extends SignedProtocolScope {
  device: string;
  incarnation: string;
  ordinal: number;
}

/** Reuses the git-sync routine row. Locking serializes minting across processes;
 * failed persistence never produces a signed announcement. */
export async function resolveStoreProtocolContext(input: {
  sql: postgres.Sql;
  slug: string;
  workspaceId: string;
  repoPath: string;
  scope: SignedProtocolScope;
  device: string;
  runGit?: RunGit;
}): Promise<SignedProtocolContext> {
  const incarnation = await ensureStoreIncarnation(input.repoPath, input.runGit);
  const context = await input.sql.begin(async (sql) => {
    const rows = await sql<{ generation: StoreGenerationRecord | null }[]>`
      SELECT metadata->'pot_git_generation' AS generation FROM harness_shared.routines
       WHERE install_slug = ${input.slug} AND workspace_id = ${input.workspaceId}
         AND target_role = 'system:git-sync' FOR UPDATE
    `;
    if (rows.length !== 1) throw new Error('pot-git: expected one durable git-sync generation owner');
    const prior = rows[0]!.generation;
    if (prior && (!Number.isSafeInteger(prior.ordinal) || prior.ordinal < 1)) {
      throw new Error('pot-git: invalid durable generation ordinal');
    }
    const same = prior?.incarnation === incarnation && prior.device === input.device &&
      prior.hive_id === input.scope.hive_id && prior.repo_key === input.scope.repo_key;
    const ordinal = same ? prior.ordinal : (prior?.ordinal ?? 0) + 1;
    const result = makeSignedProtocolContext(input.scope.hive_id, input.scope.repo_key, `sg2-${ordinal}-${incarnation}`);
    if (!same) {
      const record: StoreGenerationRecord = { ...input.scope, device: input.device, incarnation, ordinal };
      await sql`
        UPDATE harness_shared.routines
           SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('pot_git_generation', ${sql.json({ ...record })})
         WHERE install_slug = ${input.slug} AND workspace_id = ${input.workspaceId}
           AND target_role = 'system:git-sync'
      `;
    }
    return result;
  });
  return context as SignedProtocolContext;
}

/** Capability issuance is existing-only: the server verifies registry scope
 * and the physical store before allocating D-021's durable generation. */
export async function resolveServingStoreContext(request: GitServingRequest, device: string): Promise<SignedProtocolContext | null> {
  const [{ loadHarnessRegistry }, { canonicalRepoKey }, { hiveGitRepoPath }, { getOrgPg }] = await Promise.all([
    import('../../harness-registry'), import('./repo-identity'), import('./storage'), import('@papercusp/db-org'),
  ]);
  const entry = (await loadHarnessRegistry(request.workspaceId)).projects.find(p => p.slug === request.installSlug);
  const home = entry?.hive_slug ?? (entry?.self_repo ? entry.slug : undefined);
  if (!entry || home !== request.potHomeSlug || canonicalRepoKey(entry) !== request.scope.repo_key) {
    throw new Error('requested repository is not registered in the serving hive');
  }
  const repoPath = hiveGitRepoPath(home, request.scope.repo_key);
  try {
    if (!(await stat(repoPath)).isDirectory()) throw new Error('Git repository path is not a directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return resolveStoreProtocolContext({ sql: getOrgPg().sql, slug: request.installSlug,
    workspaceId: request.workspaceId, repoPath, scope: request.scope, device });
}
