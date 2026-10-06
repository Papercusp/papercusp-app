/** WI-10004263: identity learning reuses memory provenance and the candidate queue. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getMemoryBackend } from '../memory/backend';
import { withMemoryToolTimeout } from '../memory/op-deadline';
import { resolveSeedPackKey } from './seed-pack-key';

/** Read APPLIED content, never the desired stack which may not have reached the agent. */
export async function wornMemoryIdentityIds(ownerId: string, workspaceId: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ applied: { specificationRevision: string; stateRevision: string } | null }[]>`
    SELECT control_state->'activation'->'applied' AS applied
      FROM harness_shared.session_briefs
     WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId} LIMIT 1`;
  if (!rows[0]?.applied) return [];
  const [{ readGateSelectedLaunchSpec }, { appliedOrCurrentIdentityArtifact }] = await Promise.all([
    import('../agent-tools/coordination/control-anchor'),
    import('../capability-envelope/identity-grants-port'),
  ]);
  // Narrowed to the applied receipt (WI-10004801): the selection below reads nothing else.
  const artifact = appliedOrCurrentIdentityArtifact(
    await readGateSelectedLaunchSpec(sql, ownerId, workspaceId, [rows[0].applied]), rows[0].applied);
  if (!artifact) throw new Error('Applied identity content is unavailable; refusing unstamped memory write.');
  return [...new Set(artifact.inputs.filter((input) => input.kind === 'package' && input.packageKind === 'blueprint')
    .map((input) => input.ref))];
}

export class IdentityLearningRefused extends Error {
  constructor(readonly reason: string, message: string) { super(message); }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The same source catalog as identity launch; installed releases are never authoring targets. */
export async function resolveIdentityLearningTarget(identityId: string, requestedPack?: string) {
  const [{ getIdentitySource, localDirs }, { availableBlueprintSources }] = await Promise.all([
    import('../agent-identities/source'), import('../blueprint/installed-blueprints'),
  ]);
  const source = await getIdentitySource(identityId, { repoDir: process.cwd() });
  if (!source.ok || !source.sourcePath) throw new IdentityLearningRefused('identity_unavailable',
    'The identity source is unavailable: ' + JSON.stringify('error' in source ? source.error : source.errors));
  const packs = [...new Set([
    ...((source.identity.bundles ?? []).filter((bundle) => bundle.kind === 'knowledge-pack').map((bundle) => bundle.ref)),
    ...(resolveSeedPackKey(source.identity).packId ? [resolveSeedPackKey(source.identity).packId!] : []),
  ])];
  const packId = requestedPack ?? (packs.length === 1 ? packs[0] : undefined);
  if (!packId || !packs.includes(packId) || !/^[a-z0-9][a-z0-9-]*$/.test(packId)) {
    throw new IdentityLearningRefused('identity_pack_required', 'Choose one knowledge pack declared by this identity.');
  }
  const location = availableBlueprintSources({ localDirs: localDirs(process.cwd()) }).find((entry) => entry.id === identityId);
  return { identityId, packId, sourcePath: source.sourcePath, tier: location?.tier };
}

export async function resolveWritableIdentityPack(identityId: string, packId: string): Promise<{ dir: string; sourcePath: string }> {
  const target = await resolveIdentityLearningTarget(identityId, packId);
  if (target.tier !== 'local') {
    throw new IdentityLearningRefused('immutable_identity_pack', 'Installed and builtin identity packs are immutable. Propose the lesson to the upstream author, or author a local identity.');
  }
  const root = await fs.realpath(dirname(target.sourcePath));
  const { INSTALLED_BLUEPRINTS_DIR } = await import('../blueprint/installed-blueprints');
  const installed = await fs.realpath(INSTALLED_BLUEPRINTS_DIR()).catch(() => INSTALLED_BLUEPRINTS_DIR());
  const dir = await fs.realpath(join(root, 'packages', 'knowledge-pack', packId));
  if (inside(installed, root) || !inside(root, dir) || inside(installed, dir)) {
    throw new IdentityLearningRefused('immutable_identity_pack', 'The target must be a local vendored pack, outside installed release content.');
  }
  return { dir, sourcePath: target.sourcePath };
}

export async function proposeIdentityMemory(input: {
  memoryId: string; identityId: string; packId?: string; ownerId: string; workspaceId: string;
}) {
  const memory = await withMemoryToolTimeout(getMemoryBackend().get(input.memoryId), 'identity memory proposal');
  if (!memory) return { ok: false, reason: 'memory_not_found' };
  const meta = memory.metadata ?? {};
  if (!input.ownerId || !input.workspaceId || meta.source_session !== input.ownerId || meta.workspace_id !== input.workspaceId) {
    return { ok: false, reason: 'memory_writer_required' };
  }
  if (!Array.isArray(meta.worn_identity_ids) || !meta.worn_identity_ids.includes(input.identityId)) {
    return { ok: false, reason: 'identity_not_worn_at_write' };
  }
  try {
    const target = await resolveIdentityLearningTarget(input.identityId, input.packId);
    const { stageKnowledgePackCandidate } = await import('./candidates');
    const signature = 'identity-memory:' + createHash('sha256')
      .update(JSON.stringify([input.workspaceId, input.identityId, target.packId, input.memoryId])).digest('hex');
    const result = await stageKnowledgePackCandidate({
      signature, title: memory.text.split('\n')[0] || 'Identity lesson', draftText: memory.text,
      kind: ['user', 'feedback', 'project', 'reference'].includes(String(meta.kind)) ? meta.kind as 'feedback' : 'feedback',
      scopes: [], recurrenceCount: 0, createdBy: input.ownerId,
      identityTarget: { workspaceId: input.workspaceId, identityId: input.identityId, packId: target.packId, memoryId: input.memoryId },
    });
    return { ok: result.staged, ...result };
  } catch (error) {
    if (error instanceof IdentityLearningRefused) return { ok: false, reason: error.reason, error: error.message };
    throw error;
  }
}
