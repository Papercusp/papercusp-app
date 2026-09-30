import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { replayAgentSpecification, type SessionActivation, type CompiledAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { trackDetached } from '../detached-imports';
import { applyPackageResourceDependent, beginPackageInstallation, beginPackageInstallationReleaseInTransaction,
  carryAppliedPackageInstallation } from './package-resource-receipts';
import { blueprintPackageProvisioners, provisionBlueprintPackages } from './compile-packages';
import { planKnowledgePackageResources, releasePackageInstallation } from './package-knowledge-resources';
import { planRecipePackageResource } from './package-recipe-resources';
import { planKnowledgeDocResources } from './package-doc-resources';
import { resolveWearerPackageDocKeys } from './package-memory-visibility';

/** Package kinds whose rows the installation journal owns. Rubrics are
 * immutable seeds and stay outside it. */
const JOURNALED_PACKAGE_KINDS = new Set(['knowledge-pack', 'recipe']);

/** An installation fenced inside an activation transaction; external cleanup
 * runs after that transaction commits (D-018). */
export interface SessionPackageFence { workspaceId: string; dependentId: string }

/** A host that persists attemptId with its launch/activation receipt BEFORE
 * external preparation reuses it on recovery. A host that does not (every
 * production launch path today) omits it and gets a durable derived attempt
 * (see sessionPackageAttempt). Either way a compensated attempt is terminal. */
export function sessionPackageDependentId(ownerId: string, revision: SessionActivation['desired'], attemptId?: string): string {
  if (!ownerId.trim() || !revision.specificationRevision?.trim() || !revision.stateRevision?.trim()) {
    throw new Error('package installation requires wearer and exact activation revision');
  }
  if (attemptId !== undefined && (!attemptId.trim() || attemptId.length > 200)) {
    throw new Error('package installation requires a non-empty attempt token of at most 200 characters');
  }
  return 'session-package:' + createHash('sha256').update(JSON.stringify([
    ownerId, revision.specificationRevision, revision.stateRevision,
    ...(attemptId === undefined ? [] : [attemptId]),
  ])).digest('hex');
}

/** D-018: the attempt is derived from the durable journal instead of a token
 * threaded through every launch record. Attempt 0 keeps the pre-attempt id;
 * a retry takes the first `attempt:<n>` with no row. An id whose rows are all
 * live (preparing/applied) is reused, so a replay converges on one install. */
async function sessionPackageAttempt(db: Sql | TransactionSql, ownerId: string,
  revision: SessionActivation['desired']): Promise<string> {
  const rows = await db<Array<{ dependent_id: string; phase: string }>>`
    SELECT dependent_id, phase FROM harness_shared.blueprint_package_installations
     WHERE owner_id = ${ownerId} AND specification_revision = ${revision.specificationRevision}
       AND state_revision = ${revision.stateRevision}`;
  const terminal = new Set(rows.filter((row) => row.phase !== 'preparing' && row.phase !== 'applied')
    .map((row) => row.dependent_id));
  // At most rows.length ids are taken, so one of these rows.length + 1 is free or live.
  for (let n = 0; n <= rows.length; n++) {
    const id = sessionPackageDependentId(ownerId, revision, n === 0 ? undefined : 'attempt:' + n);
    if (!terminal.has(id)) return id;
  }
  throw new Error('package attempt derivation exhausted its candidates');
}

function journaledPackages(artifact: CompiledAgentSpecification): boolean {
  return artifact.inputs.some((entry) => entry.kind === 'package' && JOURNALED_PACKAGE_KINDS.has(entry.packageKind));
}

async function expectedPackageResources(artifact: CompiledAgentSpecification, workspaceId?: string) {
  const byWorkspace = new Map<string, Map<string, string>>();
  const manifest = (scopeWorkspaceId: string) => {
    if (workspaceId !== undefined && scopeWorkspaceId !== workspaceId) throw new Error('package activation workspace mismatch');
    const expected = byWorkspace.get(scopeWorkspaceId) ?? new Map<string, string>();
    byWorkspace.set(scopeWorkspaceId, expected); // keep explicit empty selection
    return expected;
  };
  const expect = (expected: Map<string, string>, key: string, hash: string) => {
    const prior = expected.get(key);
    if (prior && prior !== hash) throw new Error('conflicting resource content in installation');
    expected.set(key, hash);
  };
  await provisionBlueprintPackages(artifact, {
    rubric: async () => {},
    recipe: async (pin, scope) => {
      const planned = planRecipePackageResource(pin, scope.workspaceId);
      expect(manifest(scope.workspaceId), planned.resourceKey, planned.address.installedHash);
    },
    knowledge: async (pin, scope) => {
      const expected = manifest(scope.workspaceId);
      for (const write of planKnowledgePackageResources({ pin, workspaceId: scope.workspaceId,
        harnessSlug: scope.harnessSlug, memoryTarget: scope.memoryTarget!,
        shapes: scope.knowledgeSelection!.shapes, domains: scope.knowledgeSelection!.domains })) {
        expect(expected, write.resourceKey, write.address.installedHash);
      }
      // P-009 / D-022: the pin's doc items are members of the same installation.
      for (const write of planKnowledgeDocResources({ pin, workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug })) {
        expect(expected, write.resourceKey, write.address.installedHash);
      }
    },
  });
  return byWorkspace;
}

/** Existing host launch/identity-mutation callers use this before publishing a
 * desired revision. Persist every manifest first; any partial preparation has a
 * durable release fence and exact-address compensation on error or replay. */
export async function provisionSessionPackageResources(sql: Sql, input: {
  ownerId: string; revision: SessionActivation['desired']; artifacts: readonly CompiledAgentSpecification[];
  attemptId?: string;
}): Promise<{ dependentId: string }> {
  // A crash between an activation's commit and its cleanup leaves fenced
  // installations; they resume here, at the wearer's next provisioning.
  await resumeSessionPackageReleases(sql, input.ownerId);
  const manifests = new Map<string, Map<string, string>>();
  for (const artifact of input.artifacts) {
    if (artifact.specificationRevision !== input.revision.specificationRevision) throw new Error('package preparation artifact revision mismatch');
    for (const [workspaceId, expected] of await expectedPackageResources(artifact)) {
      const previous = manifests.get(workspaceId) ?? new Map<string, string>();
      for (const [key, hash] of expected) {
        if (previous.has(key) && previous.get(key) !== hash) throw new Error('conflicting resource content in installation');
        previous.set(key, hash);
      }
      manifests.set(workspaceId, previous);
    }
  }
  const dependentId = input.attemptId !== undefined
    ? sessionPackageDependentId(input.ownerId, input.revision, input.attemptId)
    : await sessionPackageAttempt(sql, input.ownerId, input.revision);
  // A refusal here must never compensate an existing, differently authored
  // installation that merely reused its id. Only enroll successful manifests.
  const enrolled: string[] = [];
  try {
    for (const [workspaceId, expectedResources] of manifests) {
      await beginPackageInstallation(sql, { workspaceId, dependentId, ownerId: input.ownerId,
        ...input.revision, expectedResources });
      enrolled.push(workspaceId);
    }
    const provisioners = blueprintPackageProvisioners(sql, { dependentId });
    for (const artifact of input.artifacts) await provisionBlueprintPackages(artifact, provisioners);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const workspaceId of enrolled) {
      try {
        const receipts = await releasePackageInstallation(sql, workspaceId, dependentId, undefined, { onlyUnapplied: true });
        for (const receipt of receipts) if (receipt.phase === 'cleanup_failed') cleanupErrors.push(new Error(receipt.error ?? 'cleanup failed'));
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors],
      'package preparation failed; compensation remains retryable in the resource journal', { cause: error });
    throw error;
  }
  return { dependentId };
}

/** Reuse the applied installation when only the host state changes. The host
 * supplies its authoritative applied receipt, persists the target attempt with
 * the desired revision, and runs this in that SAME transaction. Recovery reuses
 * those tokens; a failed target never reopens a released installation.
 */
export async function carrySessionPackageResources(tx: TransactionSql, input: {
  ownerId: string;
  workspaceId: string;
  from: { revision: SessionActivation['desired']; attemptId?: string };
  revision: SessionActivation['desired'];
  artifact: CompiledAgentSpecification;
  attemptId: string;
}): Promise<void> {
  const artifact = replayAgentSpecification(input.artifact);
  if (artifact.specificationRevision !== input.revision.specificationRevision ||
      input.from.revision.specificationRevision !== input.revision.specificationRevision) {
    throw new Error('package carry requires an unchanged verified specification');
  }
  const fromDependentId = sessionPackageDependentId(input.ownerId, input.from.revision, input.from.attemptId);
  const dependentId = sessionPackageDependentId(input.ownerId, input.revision, input.attemptId);
  const expected = await expectedPackageResources(artifact, input.workspaceId);
  const expectedResources = expected.get(input.workspaceId);
  if (!expectedResources) return; // no journaled package; an empty pack still has a manifest
  await carryAppliedPackageInstallation(tx, { workspaceId: input.workspaceId, ownerId: input.ownerId,
    fromDependentId, dependentId, ...input.revision, expectedResources });
}

/** Fence the wearer's other applied installations in this workspace. Runs in
 * the activation transaction, BEFORE the new dependent's locks are taken. */
async function fenceSessionPackages(tx: TransactionSql, ownerId: string, workspaceId: string,
  keep: string | null): Promise<SessionPackageFence[]> {
  const rows = await tx<Array<{ dependent_id: string }>>`
    SELECT dependent_id FROM harness_shared.blueprint_package_installations
     WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId} AND phase = 'applied'
       AND dependent_id IS DISTINCT FROM ${keep}
     ORDER BY dependent_id`;
  const fenced: SessionPackageFence[] = [];
  for (const { dependent_id: dependentId } of rows) {
    if (await beginPackageInstallationReleaseInTransaction(tx, workspaceId, dependentId)) {
      fenced.push({ workspaceId, dependentId });
    }
  }
  return fenced;
}

/** Run inside the existing activation transaction. Never opens visibility by
 * updating memories independently of that authoritative applied revision.
 * Returns the installations it fenced; the caller releases them after commit
 * with releaseSupersededSessionPackages. */
export async function applySessionPackageResources(tx: TransactionSql, input: {
  ownerId: string;
  workspaceId: string;
  revision: SessionActivation['desired'];
  artifact: CompiledAgentSpecification | null;
  attemptId?: string;
}): Promise<{ superseded: SessionPackageFence[] }> {
  if (input.attemptId !== undefined && !input.artifact) {
    throw new Error('package activation attempt requires a verified artifact');
  }
  const artifact = input.artifact ? replayAgentSpecification(input.artifact) : null;
  if (artifact && artifact.specificationRevision !== input.revision.specificationRevision) {
    throw new Error('package activation artifact revision mismatch');
  }
  // A legacy launch record carries no artifact, so it says nothing about packages.
  if (!artifact) return { superseded: [] };
  const expected = journaledPackages(artifact)
    ? (await expectedPackageResources(artifact, input.workspaceId)).get(input.workspaceId) : undefined;
  // The applied identity wears no journaled package here: detach the prior ones.
  if (!expected) return { superseded: await fenceSessionPackages(tx, input.ownerId, input.workspaceId, null) };
  let dependentId: string;
  if (input.attemptId !== undefined) {
    dependentId = sessionPackageDependentId(input.ownerId, input.revision, input.attemptId);
  } else {
    dependentId = await sessionPackageAttempt(tx, input.ownerId, input.revision);
    const [live] = await tx`SELECT 1 FROM harness_shared.blueprint_package_installations
      WHERE workspace_id = ${input.workspaceId} AND dependent_id = ${dependentId}
        AND phase IN ('preparing', 'applied')`;
    // Never provisioned (an in-place control change): the prior applied pins
    // keep covering the wearer until a provisioned revision supersedes them.
    if (!live) return { superseded: [] };
  }
  // Lock order: superseded dependents before the new one, the same order a
  // concurrent release takes, so the two cannot deadlock.
  const superseded = await fenceSessionPackages(tx, input.ownerId, input.workspaceId, dependentId);
  await applyPackageResourceDependent(tx, input.workspaceId, dependentId, expected);
  return { superseded };
}

/** P-009 / D-022: the pack-doc keys the wearer holds once `revision` applies —
 * the SAME decision applySessionPackageResources makes, read-only, so the
 * turn-start channel can deliver the parts before the next turn acknowledges
 * the activation. A legacy record (no artifact) or an unprovisioned revision
 * keeps the applied pins; an identity that wears no journaled package here
 * holds none. Sorted. */
export async function sessionPackageDocKeysForRevision(sql: Sql, input: {
  ownerId: string;
  workspaceId: string;
  revision: SessionActivation['desired'];
  artifact: CompiledAgentSpecification | null;
}): Promise<string[]> {
  const applied = () => resolveWearerPackageDocKeys(sql, input);
  if (!input.artifact) return applied();
  const artifact = replayAgentSpecification(input.artifact);
  if (artifact.specificationRevision !== input.revision.specificationRevision) {
    throw new Error('package activation artifact revision mismatch');
  }
  if (!journaledPackages(artifact) || !(await expectedPackageResources(artifact, input.workspaceId)).has(input.workspaceId)) {
    return [];
  }
  const rows = await sql<Array<{ resource_key: string | null }>>`
    SELECT r.resource_key
      FROM harness_shared.blueprint_package_installations i
      LEFT JOIN LATERAL jsonb_object_keys(i.expected_resources) AS k(resource_key) ON true
      LEFT JOIN harness_shared.blueprint_package_resources r
        ON r.workspace_id = i.workspace_id AND r.resource_key = k.resource_key
       AND r.resource_kind = 'doc-part' AND r.phase = 'ready'
     WHERE i.workspace_id = ${input.workspaceId} AND i.owner_id = ${input.ownerId}
       AND i.specification_revision = ${input.revision.specificationRevision}
       AND i.state_revision = ${input.revision.stateRevision}
       AND i.phase IN ('preparing', 'applied')`;
  // No live installation: never provisioned, so the prior applied pins keep covering.
  if (!rows.length) return applied();
  return [...new Set(rows.flatMap((row) => row.resource_key ? [row.resource_key] : []))].sort();
}

/** External cleanup for fences that already COMMITTED. Resume-only: an
 * installation that is not releasing/cleanup_failed (for example, because its
 * activation rolled back) is left untouched. Failures stay durable on the
 * installation row and are retried at the wearer's next provisioning. */
export async function releaseSupersededSessionPackages(sql: Sql, fences: readonly SessionPackageFence[]): Promise<void> {
  const errors: unknown[] = [];
  for (const fence of fences) {
    try {
      await releasePackageInstallation(sql, fence.workspaceId, fence.dependentId, undefined, { onlyReleasing: true });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'superseded package cleanup is incomplete; it resumes at the next provisioning');
}

/** Post-commit, fire-and-forget form for activation hosts. */
export function scheduleSupersededSessionPackageRelease(sql: Sql, fences: readonly SessionPackageFence[]): void {
  if (!fences.length) return;
  void trackDetached(releaseSupersededSessionPackages(sql, fences)).catch((error: unknown) => {
    console.warn(`[session-packages] superseded cleanup deferred: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function resumeSessionPackageReleases(sql: Sql, ownerId: string): Promise<void> {
  const rows = await sql<Array<{ workspace_id: string; dependent_id: string }>>`
    SELECT workspace_id, dependent_id FROM harness_shared.blueprint_package_installations
     WHERE owner_id = ${ownerId} AND phase IN ('releasing', 'cleanup_failed')
     ORDER BY updated_at LIMIT 50`;
  try {
    await releaseSupersededSessionPackages(sql, rows.map((row) => ({ workspaceId: row.workspace_id, dependentId: row.dependent_id })));
  } catch (error) {
    // Durable on each installation row; never blocks the wearer's launch.
    console.warn(`[session-packages] resumed cleanup incomplete: ${error instanceof Error ? error.message : String(error)}`);
  }
}
