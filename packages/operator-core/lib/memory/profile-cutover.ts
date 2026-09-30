/** Atomic serving-profile cutover for side-by-side memory migrations. */
import { getOrgPg } from '@papercusp/db-org';
import {
  EMBEDDER_DIM_SPECS,
  VEC_TABLE,
  invalidateMemoryClient,
  memoryProfileCoverageSql,
  normalizeMemoryProfileCoverage,
  type EmbeddingProfileId,
  type MemoryProfileCoverage,
  type ResolvedVecMode,
} from '@papercusp/memory';
import { invalidateOperatorStateCache } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import { notifySyncInvalidate } from '../sync-sse';
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from '../voice-prefs';

export type MemoryProfileCutoverInput = {
  userId: string;
  fromMode: ResolvedVecMode;
  toMode: ResolvedVecMode;
  fromProfileId: EmbeddingProfileId;
  toProfileId: EmbeddingProfileId;
};

export type MemoryProfileCutoverResult = {
  coverage: MemoryProfileCoverage;
  servingMode: ResolvedVecMode;
  servingProfileId: EmbeddingProfileId;
  previousMode: ResolvedVecMode;
  previousProfileId: EmbeddingProfileId;
  selectionLayer: 'user';
};

export class MemoryProfileCutoverError extends Error {
  constructor(
    readonly code:
      | 'source_profile_mismatch'
      | 'target_profile_mismatch'
      | 'source_profile_not_serving'
      | 'target_coverage_incomplete',
    message: string,
    readonly coverage?: MemoryProfileCoverage,
  ) {
    super(message);
    this.name = 'MemoryProfileCutoverError';
  }
}

function assertDeclaredProfiles(input: MemoryProfileCutoverInput): void {
  const from = EMBEDDER_DIM_SPECS[input.fromMode];
  const to = EMBEDDER_DIM_SPECS[input.toMode];
  if (input.fromProfileId !== from.profileId) {
    throw new MemoryProfileCutoverError(
      'source_profile_mismatch',
      `mode ${input.fromMode} resolves ${from.profileId}, got ${input.fromProfileId}`,
    );
  }
  if (input.toProfileId !== to.profileId) {
    throw new MemoryProfileCutoverError(
      'target_profile_mismatch',
      `mode ${input.toMode} resolves ${to.profileId}, got ${input.toProfileId}`,
    );
  }
}

/**
 * Recheck coverage and change the serving selector in ONE transaction.
 * SHARE ROW EXCLUSIVE prevents a concurrent canonical/vector writer from
 * opening a gap between the count and selector update, while ordinary recall
 * (ACCESS SHARE) remains available. Table names come only from VEC_TABLE.
 */
export async function cutoverMemoryProfile(
  input: MemoryProfileCutoverInput,
): Promise<MemoryProfileCutoverResult> {
  assertDeclaredProfiles(input);
  if (input.fromMode === input.toMode) {
    throw new MemoryProfileCutoverError('target_profile_mismatch', 'source and target profiles must differ');
  }

  const workspaceId = activeWorkspaceId();
  const { sql } = getOrgPg();
  const result = await sql.begin(async (tx) => {
    const tables = [
      'harness_shared.memory_canonical',
      `harness_shared.${VEC_TABLE[input.fromMode]}`,
      `harness_shared.${VEC_TABLE[input.toMode]}`,
      'harness_shared.operator_voice_prefs',
      'harness_shared.user_preferences',
    ].sort();
    await tx.unsafe(`LOCK TABLE ${tables.join(', ')} IN SHARE ROW EXCLUSIVE MODE`);

    const rows = await tx.unsafe(memoryProfileCoverageSql('harness_shared', input.fromMode, input.toMode));
    const coverage = normalizeMemoryProfileCoverage(rows[0] as Record<string, unknown> | undefined);
    if (coverage.missing !== 0 || coverage.target !== coverage.eligible) {
      throw new MemoryProfileCutoverError(
        'target_coverage_incomplete',
        `target ${input.toProfileId} is missing ${coverage.missing} of ${coverage.eligible} eligible vectors`,
        coverage,
      );
    }

    await tx`
      INSERT INTO harness_shared.operator_voice_prefs (workspace_id, payload, updated_at)
      VALUES (${workspaceId}, ${JSON.stringify(DEFAULT_VOICE_PREFS)}::text::jsonb, ${Date.now()})
      ON CONFLICT (workspace_id) DO NOTHING
    `;
    const currentRows = await tx<{ payload: Partial<VoicePrefs> }[]>`
      SELECT payload
        FROM harness_shared.operator_voice_prefs
       WHERE workspace_id = ${workspaceId}
       FOR UPDATE
    `;
    await tx`
      INSERT INTO harness_shared.user_preferences (user_id, workspace_id, payload, updated_at)
      VALUES (${input.userId}, ${workspaceId}, '{}'::jsonb, now())
      ON CONFLICT (user_id, workspace_id) DO NOTHING
    `;
    const userRows = await tx<{ payload: Record<string, unknown> }[]>`
      SELECT payload
        FROM harness_shared.user_preferences
       WHERE user_id = ${input.userId}
         AND workspace_id = ${workspaceId}
       FOR UPDATE
    `;
    const workspace = { ...DEFAULT_VOICE_PREFS, ...(currentRows[0]?.payload ?? {}) };
    const userMode = userRows[0]?.payload.memoryEmbedderMode;
    const currentMode = typeof userMode === 'string' && userMode.length > 0
      ? userMode
      : workspace.memoryEmbedderMode;
    if (currentMode !== input.fromMode) {
      throw new MemoryProfileCutoverError(
        'source_profile_not_serving',
        `serving selector is ${currentMode}, expected ${input.fromMode}/${input.fromProfileId}`,
        coverage,
      );
    }

    const patch = {
      memoryEmbedderMode: input.toMode,
      previousMemoryEmbedderMode: input.fromMode,
      previousMemoryEmbedderProfileId: input.fromProfileId,
    };
    await tx`
      UPDATE harness_shared.user_preferences
         SET payload = payload || ${JSON.stringify(patch)}::text::jsonb,
             updated_at = now()
       WHERE user_id = ${input.userId}
         AND workspace_id = ${workspaceId}
    `;
    return {
      coverage,
      servingMode: input.toMode,
      servingProfileId: input.toProfileId,
      previousMode: input.fromMode,
      previousProfileId: input.fromProfileId,
      selectionLayer: 'user' as const,
    };
  });

  invalidateOperatorStateCache('operator_voice_prefs', workspaceId);
  invalidateMemoryClient();
  await Promise.all([
    notifySyncInvalidate('voicePrefs.workspace', {}),
    notifySyncInvalidate('voicePrefs.effective', {}),
    notifySyncInvalidate('userPreferences.current', {}),
  ]).catch(() => {});
  return result;
}
