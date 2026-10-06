import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { installFlagOverrideStore } from '../../flag-override-store.ts';
import { productionScoutRunner } from '../../scout/register-scout-action.ts';
import { runScoutCycleTick, productionDepsBuilder } from '../../scout/run.ts';
import { recordScoutTick } from '../../scout/tick-ledger.ts';
import { recordScoutTickToGovernor } from '../../learning-governor/registrants.ts';
import { checkHiveSingleRunner } from '../../hive-single-runner.ts';
import { scoutWorkspaceCeilingGate } from '../../learning-governor/scout-ceiling.ts';
import { readWorkItemAdmissionProducerPressure } from '../../work-items-admission-promoter.ts';
import { scoutPotGate, scoutConfigDelta } from '../../learning/pot-gate/gates.ts';
import { isWorkspaceCoordinationOn, workspaceBrainScopeKey } from '../../workspace-brain-scope.ts';
import { resolveScoutConfig } from '../../scout/config.ts';
import { getPilotCapabilityManifest } from '../../dream/capability-catalog.ts';
import { buildCapabilityPacket } from '../../dream/capability-packets.ts';
import { buildCapabilitySamplingSnapshot } from '../../dream/capability-sampler.ts';
import { STUDY_BLOCKS, validateStudyBlocks, readStudyTotals, requireStudyRoom } from './accounting.mts';
import { createBlenderAdmission } from './blender-guard.mts';
import { enableStudyMaster, restoreStudyControls, studyRestorationPorts } from './controls.mts';
import { moduleRepoRoot } from '../../module-repo-root.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = moduleRepoRoot(import.meta.url);
const workspaceId = 'papercusp-workspace';
process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
const sidecar = process.env.PAPERCUSP_EMBED_SIDECAR_URL;
if (!sidecar || !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/?$/.test(sidecar)) throw new Error('Blender study requires the configured local sidecar');
installFlagOverrideStore();
const { sql } = getOrgPg();
const ownerId = process.env.PAPERCUSP_SID;
if (!ownerId) throw new Error('Study cleanup requires the attributed PAPERCUSP_SID');
const restoration = studyRestorationPorts(sql, workspaceId, 'papercusp', ownerId);
const log = async (entry: unknown) => {
  const line = JSON.stringify({ at: new Date().toISOString(), entry });
  await appendFile(resolve(here, 'cycle-events.jsonl'), line + '\n');
  console.log(line);
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

let masterAttempted = false;
try {
  const blocks = await Promise.all(Object.values(STUDY_BLOCKS).map(async b => JSON.parse(await readFile(resolve(here, b.file), 'utf8'))));
  const limits = validateStudyBlocks(blocks);
  const frozen = blocks.find(b => b.pin === STUDY_BLOCKS.luna.pin)!;
  const [master] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM harness_shared.learning_pot_scope WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'`;
  if (master?.enabled !== false) throw new Error('Expected disabled learning master before temporary study enablement');
  const coordinated = await isWorkspaceCoordinationOn();
  const installSlug = workspaceBrainScopeKey(workspaceId, 'papercusp', coordinated);
  const model = frozen.protocol.models;
  const scoutConfig = resolveScoutConfig({ models: { ideator: model.generator, recombine: model.generator, critic: model.reviewer, revision: model.reviewer, experiment: model.reviewer } });
  // Lower fan-out through Scout's existing budget knob; retain its real lens selection and prompts.
  const payload = { scout: scoutConfig, budget: { maxCostUsd: limits.cycleUsd, maxIdeators: 1, maxCriticsPerIdea: 2 } };
  const delta = await scoutConfigDelta({ workspaceId, installSlug });
  const effectiveScoutConfig = resolveScoutConfig({ ...scoutConfig, ...delta?.scout, models: scoutConfig.models });
  const config = { protocolPin: frozen.pin, installSlug, payload, potDelta: delta, modelPolicy: 'D019 invocation-local model pin supersedes stored models; all other pot deltas and production gates retained', effectiveScoutConfig, attemptUnit: 'one ordinary governed Scout cycle; report candidate counts separately', dispatchPolicy: 'deferred-for-solo-evaluation' };
  const configHash = hash(config);
  const configPath = resolve(here, 'blender-config-luna-deferred.json');
  if (process.argv.includes('--freeze')) {
    // Exclusive create: a later invocation cannot overwrite the registered block.
    await writeFile(configPath, JSON.stringify({ config, configHash }, null, 2) + '\n', { flag: 'wx' });
  }
  const pinned = JSON.parse(await readFile(configPath, 'utf8'));
  if (pinned.configHash !== hash(pinned.config) || pinned.configHash !== configHash) throw new Error('Frozen Blender configuration changed');
  const manifest = getPilotCapabilityManifest();
  const scope = { workspaceId, potSlug: 'papercusp', repositoryId: 'papercusp' };
  const packets = [];
  for (const unit of manifest.units) {
    const packet = await buildCapabilityPacket({ rootPath: root, scope, unit, manifestRevision: manifest.revision });
    if (packet.status !== 'ready') throw new Error('Frozen source packet unavailable: ' + unit.id);
    packets.push(packet.packet);
  }
  const snapshot = await buildCapabilitySamplingSnapshot({ rootPath: root, scope, manifest, packets });
  if (snapshot.fingerprint !== frozen.protocol.sourceSnapshot) throw new Error('Frozen source snapshot changed');
  const totals = await readStudyTotals(sql, workspaceId);
  const room = requireStudyRoom(totals, 'blender', limits);
  await log({ phase: 'blender-prepared', configHash, config, room, sourceSnapshot: snapshot.fingerprint });
  if (!process.argv.includes('--run')) {
    await log({ phase: 'blender-dry-run', message: 'No provider call or settings mutation. Production cadence is evaluated only by the real tick.' });
  } else {
    let study: Record<string, unknown> | undefined;
    let guard: ReturnType<typeof createBlenderAdmission> | undefined;
    let finalRecorded = false;
    let configFault: Error | undefined;
    masterAttempted = true;
    await log({ phase: 'blender-master', enabled: true, result: await enableStudyMaster(sql, workspaceId, 'papercusp', ownerId) });
    const result = await runScoutCycleTick({ workspaceId, installSlug, admissionQueueScope: coordinated ? { kind: 'workspace' } : { kind: 'harness', harnessSlug: 'papercusp' }, payloadTemplate: payload }, {
      recordGovernor: recordScoutTickToGovernor,
      hiveRunnerGate: ({ workspaceId: ws, installSlug: slug }) => checkHiveSingleRunner(ws, slug),
      workspaceCeilingGate: scoutWorkspaceCeilingGate,
      admissionPressureGate: readWorkItemAdmissionProducerPressure,
      potGate: scoutPotGate,
      resolveConfigDelta: async input => {
        const current = await scoutConfigDelta(input);
        if (hash(current) !== hash(delta)) configFault = new Error('Pot configuration changed after study preflight');
        return { ...current, scout: { ...current?.scout, models: scoutConfig.models } };
      },
      buildDeps: (input, runCycle) => {
        const deps = productionDepsBuilder(input, runCycle);
        return { ...deps, recordTick: async record => {
          const finalStudy = study ? { ...study, settled: record.status === 'ran' && guard!.calls.every(c => c.status === 'settled'), costUsd: guard!.accounted(), calls: guard!.calls } : undefined;
          await deps.recordTick!({ ...record, detail: { ...record.detail, ...(finalStudy ? { study: finalStudy } : {}) } });
          finalRecorded = true;
        } };
      },
      runCycle: async ctx => {
        if (configFault) throw configFault;
        requireStudyRoom(await readStudyTotals(sql, workspaceId), 'blender', limits);
        if (ctx.revisionRequests?.length) throw new Error('Revision tick is outside the frozen fresh-ideation baseline');
        if (hash(ctx.scoutConfig) !== hash(effectiveScoutConfig) || ctx.budget.maxCostUsd !== limits.cycleUsd || ctx.budget.maxIdeators !== 1)
          throw new Error('Effective Blender model/config/budget differs from freeze');
        study = { protocolPin: frozen.pin, arm: 'blender', cycleId: ctx.cycleId, configHash, reservedUsd: limits.cycleUsd, settled: false };
        // Reuse the production ledger. This gated reservation does not reset last-ran cadence.
        await recordScoutTick({ workspaceId, installSlug, potSlug: 'papercusp', status: 'gated', gate: 'study-reserved', detail: { study } });
        guard = createBlenderAdmission(limits.cycleUsd, [model.generator, model.reviewer], calls => log({ phase: 'blender-calls', cycleId: ctx.cycleId, calls }));
        const cycle = await productionScoutRunner({ ...ctx, admitLlmCall: guard.admit, deferDispatch: true });
        guard.assertSettled();
        if (Math.abs((cycle.costUsd ?? NaN) - guard.accounted()) > 1e-9 || !Number.isFinite(cycle.costUsd)) throw new Error('Blender cycle/call accounting differs');
        await log({ phase: 'blender-cycle-artifacts', cycleId: ctx.cycleId, configHash, dispatchPolicy: 'deferred-for-solo-evaluation', cycle });
        return cycle;
      },
    });
    await log({ phase: 'blender-result', configHash, study, result, finalRecorded });
    if (!finalRecorded) throw new Error('Blender tick record was not confirmed; retain reservation and inspect');
    if (study) {
      const [receipt] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM harness_shared.scout_ticks WHERE workspace_id = ${workspaceId} AND detail->'study'->>'cycleId' = ${study.cycleId as string}`;
      if (receipt?.count !== 2) throw new Error('Blender reservation/final tick pair missing; inspect before another attempt');
    }
  }
} finally {
  try { await restoreStudyControls({ masterAttempted }, restoration, log); }
  finally { await sql.end(); }
}
process.exit(0);
