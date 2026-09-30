/**
 * Planted-bug probe generator (P-006).
 *
 * A probe is a synthetic task that carries a CONCRETE pre-existing defect in the
 * area the work touches, plus a detection signature — so the `planted_bug_caught`
 * deterministic guardrail (P-003) is not vacuous. It is a cheap, near-un-gameable
 * MONITOR (the optimizer can't touch the planted defect), not an optimization
 * target (D-011). Generator and judge remain distinct calls even under the
 * owner-directed uniform learning-model policy.
 */
import { tryParseJson } from './parse-json';
import { parseGeneratedTask, type GymLlmCall } from './task-generator';

export interface PlantedBug {
  /** Where the defect lives (file + symbol / area). */
  location: string;
  /** What is wrong. */
  defect: string;
  /** What a correct validator would observe that reveals the defect. */
  detectionSignature: string;
}

export interface GenerateProbeInput {
  taskId: string;
  repoUrl: string;
  repoCommit: string;
  repoContext: string;
  generatorModel: string;
  judgeModel: string;
  focusArea?: string;
}

export interface GeneratedProbeRecord {
  taskId: string;
  pool: 'probe';
  repoUrl: string;
  repoCommit: string;
  intent: string;
  spec: string;
  plantedBug: PlantedBug;
  generatedBy: string;
}

export function buildProbePrompt(input: GenerateProbeInput): { system: string; user: string } {
  const system = [
    'You design ONE realistic synthetic feature request whose touched area ALSO contains a',
    'CONCRETE, PRE-EXISTING DEFECT that a competent reviewer/validator should catch while doing',
    'the work. Work intent-first (intent → mildly-underspecified spec), then plant the defect.',
    '',
    'The planted bug must be specific and checkable: name where it lives, what is wrong, and the',
    'DETECTION SIGNATURE — the concrete observation a correct validator would make that reveals it',
    '(e.g. a specific failing test, a wrong output for a stated input).',
    '',
    'Output ONLY a single JSON object (no prose, no fences):',
    '{"intent": "...", "spec": "...", "planted_bug": {"location": "...", "defect": "...", "detection_signature": "..."}}',
  ].join('\n');

  const user = [
    '## Repository',
    input.repoContext,
    ...(input.focusArea ? ['', '## Focus area', input.focusArea] : []),
  ].join('\n');

  return { system, user };
}

export interface ParsedProbeTask {
  intent: string;
  spec: string;
  plantedBug: PlantedBug;
}

export function parseProbeTask(raw: unknown): ParsedProbeTask {
  const base = parseGeneratedTask(raw); // validates intent + spec, throws on non-object
  const o = raw as Record<string, unknown>;
  const pb = o.planted_bug;
  if (typeof pb !== 'object' || pb === null) {
    throw new Error('probe task is missing the "planted_bug" object');
  }
  const b = pb as Record<string, unknown>;
  const location = typeof b.location === 'string' ? b.location.trim() : '';
  const defect = typeof b.defect === 'string' ? b.defect.trim() : '';
  const detectionSignature = typeof b.detection_signature === 'string' ? b.detection_signature.trim() : '';
  if (!location || !defect || !detectionSignature) {
    throw new Error('planted_bug requires non-empty location, defect, and detection_signature');
  }
  return { intent: base.intent, spec: base.spec, plantedBug: { location, defect, detectionSignature } };
}

export async function generateProbeTask(
  input: GenerateProbeInput,
  deps: { llmCall: GymLlmCall },
): Promise<GeneratedProbeRecord> {
  const { system, user } = buildProbePrompt(input);
  const res = await deps.llmCall({
    model: input.generatorModel,
    system,
    messages: [{ role: 'user', content: user }],
    responseFormat: 'json',
  });
  const parsed = parseProbeTask(res.json ?? tryParseJson(res.text));
  return {
    taskId: input.taskId,
    pool: 'probe',
    repoUrl: input.repoUrl,
    repoCommit: input.repoCommit,
    intent: parsed.intent,
    spec: parsed.spec,
    plantedBug: parsed.plantedBug,
    generatedBy: input.generatorModel,
  };
}
