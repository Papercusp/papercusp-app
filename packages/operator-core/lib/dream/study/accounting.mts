import { dreamEvaluationProtocolHash, DreamEvaluationProtocolSchema, type DreamEvaluationArm } from '../../dream/dream-evaluation.ts';
import type { Sql } from 'postgres';
import { sumBlenderTicks, type BlenderTick } from './blender-guard.mts';

// These are blocks of ONE finite study. Changing model never resets admission.
export const STUDY_BLOCKS = {
  haiku: { file: 'protocol.json', pin: '23b3288077d2751dc57a1eeebe8f373809154e86e2a882302546a8100ed0b408' },
  luna: { file: 'protocol-luna.json', pin: '29a0a6e4914c26e79b13fbb561373596b18aca44966ab733feb72ac660ee7ddf' },
} as const;
export interface StudyTotal { pin: string; arm: DreamEvaluationArm; attempts: number; cost: number }

/** Read the existing production ledgers; a model block or entrypoint never resets the study. */
export async function readStudyTotals(sql: Sql, workspaceId: string): Promise<StudyTotal[]> {
  const pins = Object.values(STUDY_BLOCKS).map(block => block.pin);
  const dreams = await sql<StudyTotal[]>`
    SELECT outcome->'capabilityRun'->'evaluation'->>'protocolPin' AS pin,
           outcome->'capabilityRun'->'evaluation'->>'arm' AS arm,
           COUNT(*)::int AS attempts,
           SUM(cost_usd + COALESCE((
             SELECT SUM(CASE WHEN call->>'status' = 'settled'
                              AND call->>'model' NOT LIKE 'local:%'
                              AND (call->'usage'->>'costUsd')::float8 = 0
                              AND COALESCE((call->'usage'->>'inputTokens')::bigint, 0) + COALESCE((call->'usage'->>'outputTokens')::bigint, 0) > 0
                             THEN (call->>'reservedUsd')::float8 ELSE 0 END)
             FROM jsonb_array_elements(outcome->'capabilityRun'->'calls') AS call
           ), 0))::float8 AS cost
      FROM harness_shared.dream_runs
     WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'
       AND outcome->'capabilityRun'->'evaluation'->>'protocolPin' = ANY(${pins}::text[])
     GROUP BY 1, 2`;
  const blender = await sql<BlenderTick[]>`
    SELECT detail->'study'->>'cycleId' AS "cycleId", detail->'study'->>'protocolPin' AS pin,
           (detail->'study'->>'reservedUsd')::float8 AS "reservedUsd",
           COALESCE((detail->'study'->>'settled')::boolean, false) AS settled,
           (detail->'study'->>'costUsd')::float8 AS "costUsd"
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${workspaceId}
       AND detail->'study'->>'protocolPin' = ANY(${pins}::text[])
       AND detail->'study'->>'arm' = 'blender'`;
  return [...dreams, ...sumBlenderTicks(blender)];
}

export function validateStudyBlocks(blocks: Array<{ protocol: unknown; pin: string }>) {
  const expected = Object.values(STUDY_BLOCKS).map(b => b.pin);
  if (blocks.length !== expected.length || new Set(blocks.map(b => b.pin)).size !== expected.length)
    throw new Error('Study accounting must retain every historical block');
  for (const block of blocks) {
    if (!expected.includes(block.pin as typeof expected[number]) || dreamEvaluationProtocolHash(block.protocol) !== block.pin)
      throw new Error('Study protocol hash changed');
  }
  return DreamEvaluationProtocolSchema.parse(blocks[0]!.protocol).limits;
}

export function requireStudyRoom(rows: StudyTotal[], arm: DreamEvaluationArm, limits: ReturnType<typeof validateStudyBlocks>) {
  const pins = Object.values(STUDY_BLOCKS).map(b => b.pin);
  const seen = new Set<string>();
  let attempts = 0, cost = 0, armAttempts = 0, armCost = 0;
  for (const row of rows) {
    if (!pins.includes(row.pin as typeof pins[number]) || !['blender', 'uniform-pair', 'structured-pair', 'structured-triple'].includes(row.arm) ||
        !Number.isInteger(row.attempts) || row.attempts < 1 || typeof row.cost !== 'number' || !Number.isFinite(row.cost) || row.cost < 0 ||
        seen.has(row.pin + ':' + row.arm)) throw new Error('Invalid cumulative study accounting');
    seen.add(row.pin + ':' + row.arm);
    attempts += row.attempts;
    cost += row.cost; // dream_runs.cost_usd includes conservative unknown reservations.
    if (row.arm === arm) { armAttempts += row.attempts; armCost += row.cost; }
  }
  if (attempts >= limits.attempts || armAttempts >= limits.attemptsPerArm ||
      cost + limits.cycleUsd > limits.discoveryUsd || armCost + limits.cycleUsd > limits.discoveryUsdPerArm)
    throw new Error('Cumulative study attempt or conservative monetary admission cap reached');
  return { attempts, accountedUsd: cost, armAttempts, armAccountedUsd: armCost };
}
