import { readFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { installFlagOverrideStore } from '../../flag-override-store.ts';
import { productionDreamCycle } from '../../dream/dream-cycle-action.ts';
import { dreamEvaluationProtocolHash, DreamPilotPinSchema } from '../../dream/dream-evaluation.ts';
import { rerankCapabilityPriors } from '../../dream/capability-review.ts';
import { getPilotCapabilityManifest } from '../../dream/capability-catalog.ts';
import { buildCapabilityPacket } from '../../dream/capability-packets.ts';
import { buildCapabilitySamplingSnapshot, sampleCapabilityCombination } from '../../dream/capability-sampler.ts';
import { CAPABILITY_DREAM_PROMPT_VERSION } from '../../dream/capability-pass.ts';
import { studySampling } from './sampling.mts';
import { STUDY_BLOCKS, validateStudyBlocks, requireStudyRoom, readStudyTotals } from './accounting.mts';
import { DEFAULT_DREAM_REVIEW_CONFIG } from '../../dream/dream-config.ts';
import { getDreamRun } from '../../dream/dream-run-store.ts';
import { dreamCapabilityRun } from '../../dream/dream-run-provenance.ts';
import { captureStudyTiming } from './timing.mts';
import { enableStudyMaster, prepareStudyRoutine, restoreStudyControls, studyRestorationPorts, studyRoutinePorts } from './controls.mts';
import { moduleRepoRoot } from '../../module-repo-root.ts';

// This standalone driver does not inherit the operator service's environment.
// A fresh in-process model can miss the review deadline after generation is paid.
// Require the operator's configured local sidecar and prove readiness before any write.
const sidecar = process.env.PAPERCUSP_EMBED_SIDECAR_URL;
if (!sidecar || !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/?$/.test(sidecar))
  throw new Error('D017 study requires PAPERCUSP_EMBED_SIDECAR_URL from the local operator service before any settings change or paid call');

const here = dirname(fileURLToPath(import.meta.url));
const root = moduleRepoRoot(import.meta.url);
const workspaceId = 'papercusp-workspace';
process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
const blockArg = process.argv.find(arg => arg.startsWith('--block='))?.slice('--block='.length) ?? 'haiku';
if (blockArg !== 'haiku' && blockArg !== 'luna') throw new Error('Unknown study model block');
const blocks = await Promise.all(Object.values(STUDY_BLOCKS).map(async block => JSON.parse(await readFile(resolve(here, block.file), 'utf8'))));
const limits = validateStudyBlocks(blocks);
const frozen = blocks.find(block => block.pin === STUDY_BLOCKS[blockArg].pin)!;
if (dreamEvaluationProtocolHash(frozen.protocol) !== frozen.pin) throw new Error('Study protocol hash changed');
const arm = process.argv.find(arg => ['uniform-pair', 'structured-pair', 'structured-triple'].includes(arg)) ?? 'uniform-pair';
const pilot = DreamPilotPinSchema.parse({ ...frozen, arm });
const log = async (entry: unknown) => {
  const line = JSON.stringify({ at: new Date().toISOString(), entry });
  await appendFile(resolve(here, 'cycle-events.jsonl'), line + '\n');
  console.log(line);
};
async function tool(name: string, args: object) {
  const raw = await new Promise<string>((done, fail) => {
    const child = spawn('ptool', [name, '--workspace=' + workspaceId, '--harness=papercusp', '--json', '-'], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', code => code === 0 ? done(stdout) : fail(new Error(name + ' exit ' + code + ': ' + stderr.slice(-1000))));
    child.stdin.end(JSON.stringify(args));
  });
  let result = JSON.parse(raw);
  if (Array.isArray(result.content)) {
    const text = result.content.find((c: { type: string; text?: string }) => c.type === 'text' && c.text?.trim().startsWith('{'));
    if (text) result = JSON.parse(text.text);
  }
  await log({ tool: name, result });
  if (result.ok !== true || result.applied === false || result.reverted === true) throw new Error(name + ' did not confirm success');
  return result;
}
installFlagOverrideStore();
const { sql } = getOrgPg();
const ownerId = process.env.PAPERCUSP_SID;
if (!ownerId) throw new Error('Study cleanup requires the attributed PAPERCUSP_SID');
const restoration = studyRestorationPorts(sql, workspaceId, 'papercusp', ownerId);
const master = await sql<Array<{ enabled: boolean }>>`
  SELECT enabled FROM harness_shared.learning_pot_scope
  WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'`;
if (master.length !== 1 || master[0]!.enabled !== false) throw new Error('Expected disabled master; inspect current owner state before this temporary restore protocol');
const totals = await readStudyTotals(sql, workspaceId);
const cumulative = requireStudyRoom(totals, arm, limits);
if (arm === 'structured-pair' || arm === 'structured-triple') {
  pilot.matchedPairIndex = totals.find(row => row.pin === frozen.pin && row.arm === arm)?.attempts ?? 0;
  DreamPilotPinSchema.parse(pilot);
}
// Replay the actual bounded source set from the failed review, without repeating
// its generation or changing the study record. Keep original failures in the funnel.
const [readiness] = await sql<Array<{ review: any; outcome: any }>>`
  SELECT review, outcome FROM harness_shared.dream_runs
   WHERE workspace_id = ${workspaceId}
     AND run_id = 'dream-cycle:papercusp-workspace:papercusp:edd8d09c-5088-4ed8-b567-7bb6a3b917bf:dream:1'`;
if (!readiness?.review?.priorMatches?.length || !readiness?.outcome?.insight?.capability)
  throw new Error('D017 rerank readiness evidence is missing');
const candidate = readiness.outcome.insight.capability;
const ranked = await rerankCapabilityPriors(candidate.behavior + '\n' + candidate.priorArt.proposedDelta, readiness.review.priorMatches, { timeoutMs: DEFAULT_DREAM_REVIEW_CONFIG.timeoutMs });
await log({ phase: 'rerank-readiness', outcome: ranked.outcome, expected: readiness.review.priorMatches.length });
if (!ranked.outcome.attempted || ranked.outcome.scored !== readiness.review.priorMatches.length) {
  await sql.end();
  throw new Error('D017 reranker is not ready; no settings changed and no provider called');
}
const manifest = getPilotCapabilityManifest();
const packetScope = { workspaceId, potSlug: 'papercusp', repositoryId: 'papercusp' };
const packets = [];
for (const unit of manifest.units) {
  const built = await buildCapabilityPacket({ rootPath: root, scope: packetScope, unit, manifestRevision: manifest.revision });
  if (built.status !== 'ready') throw new Error('Study packet unavailable: ' + unit.id);
  packets.push(built.packet);
}
const snapshot = await buildCapabilitySamplingSnapshot({ rootPath: root, scope: packetScope, manifest, packets });
if (snapshot.fingerprint !== frozen.protocol.sourceSnapshot) throw new Error('Frozen study source snapshot changed');
const { sampler, annotationHash } = studySampling(snapshot, arm);
const sample = sampleCapabilityCombination(snapshot, { ...sampler, seed: frozen.protocol.seed + ':readiness', now: Date.now(), promptVersion: CAPABILITY_DREAM_PROMPT_VERSION });
if (sample.status !== 'selected' || (arm === 'structured-triple' && !sample.selection.c))
  throw new Error('Study sampler cannot supply its declared arm; no settings changed and no provider called');
await log({ phase: 'sampling-readiness', arm, annotationHash, sampler, sourceSnapshot: snapshot.fingerprint });
await log({ phase: 'prepared', arm, block: blockArg, protocolPin: frozen.pin, models: frozen.protocol.models, matchedPairIndex: pilot.matchedPairIndex, masterEnabled: false, priorStudyArms: totals, cumulative });
if (!process.argv.includes('--run')) {
  await log({ phase: 'dry-run', message: 'No settings changed and no provider called. Pass --run for one governed attempt.' });
  await sql.end();
  process.exit(0);
}
let routine: Awaited<ReturnType<typeof prepareStudyRoutine>> | undefined;
let masterAttempted = false;
const timingRuns: Array<{ runId: string; phases: string[] }> = [];
try {
  routine = await prepareStudyRoutine(studyRoutinePorts(sql, workspaceId, 'papercusp', ownerId), {
      mode: 'manual', pilot,
      cycle: { maxDreamsPerCycle: 1, maxCostUsd: frozen.protocol.limits.cycleUsd, rolling24hCostUsd: frozen.protocol.limits.rollingDayUsd },
      sampler,
      pass: { model: frozen.protocol.models.generator }, review: { model: frozen.protocol.models.reviewer },
  }, log);
  await log({ tool: 'routines:set', result: await routine.apply() });
  masterAttempted = true;
  await log({ tool: 'learning:set-pot-scope', result: await enableStudyMaster(sql, workspaceId, 'papercusp', ownerId) });
  const result = await productionDreamCycle({ workspaceId, installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null }, {
    mode: 'manual', pilot,
    cycle: { maxDreamsPerCycle: 1, maxCostUsd: frozen.protocol.limits.cycleUsd, rolling24hCostUsd: frozen.protocol.limits.rollingDayUsd },
    sampler,
    pass: { model: frozen.protocol.models.generator }, review: { model: frozen.protocol.models.reviewer },
  });
  await log({ phase: 'cycle-result', arm, protocolPin: frozen.pin, result });
  for (const run of result.runs) {
    const saved = await getDreamRun(sql, { workspaceId, runId: run.runId });
    timingRuns.push({ runId: run.runId, phases: saved ? (dreamCapabilityRun(saved)?.calls ?? []).map(call => call.phase) : [] });
  }
} finally {
  try { await restoreStudyControls({ masterAttempted, restoreRoutine: routine?.restore }, restoration, log); }
  finally { await sql.end(); }
}
// Restoration takes priority over diagnostics. Persist the bounded gateway ring
// immediately afterward so an unrelated later request cannot erase this trial's evidence.
await captureStudyTiming({ workspaceId, potSlug: 'papercusp' }, timingRuns, {
  report: (ownerId) => tool('gateway:owner_report', {
    agent: ownerId,
    projection: { pick: ['ok', 'stageTelemetry.ownerId', 'stageTelemetry.recent'] },
  }),
  log,
});
process.exit(0);
