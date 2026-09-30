/** Restore PUI's structured engines through the existing SU configuration and
 * keyed resume lease. No new session, credential store or launch registry. */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  applyCodexGatewayRoute, applyOmpResumeAccountRoute, buildResumeEnv,
  codexThreadWriterHolder, ensureCodexHomeViaOperator, ensureInteractiveConfigViaOperator,
  ensureResumeTranscriptPresent, isClaudeConfigDirLaunchReady, isCodexHomeLaunchReady,
  normalizeArgvProbeResumeLocalLivenessEvidence, normalizeCodexResumeLocalLivenessEvidence,
  normalizeModelSpecForAgent,
  ompTrackedResumeEnv, rehealResumeCodexAuth, rehealResumeCredentials, sessionProcessHolder, tryRematerializeFromArchive,
  resolveOmpSessionModel,
} from '../../../apps/operator/scripts/psu-launcher.mjs';
import {
  acquireAdvSessionResume, finalizeAdvSessionResume, getAdvSession, markAdvSessionEnded,
  readSuLaunchSpecByOwner, releaseAdvSessionResume, setAdvSessionPid,
} from './adv-sessions';
import { buildConsoleEnvelope } from './console-launcher';
import { findLiveHost } from './events/await/psu-pty-discovery';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import { resolveSpawnHostOperatorBaseUrl } from './mcp-base-url';
import type { NativeSessionHandle } from './native-session-handles';
import { findOmpSessionPath } from './session-transcript-resolvers';
import { launchContextPathFor } from './su-launch-context';
import { parseSuLaunchSpecRecord } from './su-persona-render';
import { checkInteractiveSafetyFloor } from './interactive-safety-floor';
import type { DurableSuSessionRecord } from './su-session-persistence';

export async function prepareStructuredSuResume(record: DurableSuSessionRecord) {
  const saved = record.descriptor;
  if (!saved?.identity.nativeSessionId || !record.ownerId || !record.backend) {
    throw new Error('Reconnect requires a saved native session and SU identity');
  }
  // Legacy descriptors can say default although a copied model used the
  // gateway. Do not turn that into a different, unauthenticated provider.
  if (record.backend === 'omp' && saved.model) resolveOmpSessionModel(saved.model, saved.accountRoute);
  const row = await getAdvSession(record.advSessionId);
  if (!row || row.coordOwnerId !== record.ownerId || row.workspaceId !== record.workspaceId
    || row.agent !== record.backend || saved.identity.advSessionId !== row.id
    || saved.identity.backend !== row.agent || saved.backendExtension.backend !== row.agent
    || (row.sessionId && row.sessionId !== saved.identity.nativeSessionId)
    || saved.identity.workspaceId !== row.workspaceId || saved.identity.ownerId !== row.coordOwnerId
    || saved.identity.agentChatId !== record.agentChatId || saved.identity.harnessSlug !== record.harnessSlug) {
    throw new Error('Saved session identity does not match the resume target');
  }
  const spec = parseSuLaunchSpecRecord(await readSuLaunchSpecByOwner(record.ownerId));
  if (!spec || spec.agent !== record.backend || spec.workspaceId !== record.workspaceId
    || spec.harnessSlug !== record.harnessSlug || !row.cwd) {
    throw new Error('The saved SU launch configuration is unavailable or has a different scope');
  }
  const nativeId = saved.identity.nativeSessionId;
  const extension = saved.backendExtension;
  const native: NativeSessionHandle = extension.backend === 'claude'
    ? { backend: 'claude', source: 'adv_sessions', ownerId: record.ownerId, sessionId: nativeId,
      configDir: extension.configDir, configDirSource: null, configDirUnresolvedReason: null,
      exactResumeSupported: true, missingReason: null }
    : extension.backend === 'codex'
      ? { backend: 'codex', source: 'adv_sessions', ownerId: record.ownerId, rolloutId: nativeId,
        codexHome: extension.codexHome ?? '', exactResumeSupported: true, missingReason: null }
      : { backend: 'omp', source: 'adv_sessions', ownerId: record.ownerId, ompThreadId: nativeId,
        agentHome: extension.agentHome, exactResumeSupported: true, missingReason: null };
  const session = { ...row, sessionId: nativeId, ompThreadId: nativeId,
    configDir: native.backend === 'claude' ? native.configDir : undefined,
    codexHome: native.backend === 'codex' ? native.codexHome : undefined };
  let liveHost = findLiveHost(record.ownerId);
  if (liveHost) throw new Error('This session still has a live host; reconnect to that process');
  if (row.pid) {
    try { process.kill(row.pid, 0); throw new Error('The saved native process is still alive'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  let processHolder = native.backend === 'codex' ? null : sessionProcessHolder(nativeId);
  // A native child can briefly outlive a hard-killed operator while its closed
  // stdio is draining. Its argv match is real, so never mint an absence witness
  // while it remains; wait for a fresh complete scan instead of refusing an
  // otherwise recoverable saved conversation on the first snapshot.
  if (processHolder?.held === true && processHolder.reason === 'argv-match') {
    const deadline = Date.now() + 60_000;
    while (processHolder.held === true && Date.now() < deadline) {
      await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
      processHolder = sessionProcessHolder(nativeId);
    }
    liveHost = findLiveHost(record.ownerId);
    if (liveHost) throw new Error('This session gained a live host while waiting for its native process to exit');
  }
  const writerHolder = native.backend === 'codex' ? codexThreadWriterHolder(native.codexHome, nativeId) : null;
  const evidence = native.backend === 'codex'
    ? normalizeCodexResumeLocalLivenessEvidence({ agent: 'codex', liveHost,
      writerHolder })
    : normalizeArgvProbeResumeLocalLivenessEvidence({ agent: native.backend, liveHost,
      processHolder });
  if (!evidence) {
    // Keep the refusal fail-closed, but record which local oracle blocked it.
    // Never expose a process command line or the native session id here.
    const holder = native.backend === 'codex' ? writerHolder : processHolder;
    const safeReasons = new Set(['argv-match', 'clean-scan', 'scan-empty', 'no-proc', 'no-session-id',
      'free', 'no-lock-file']);
    const reason = safeReasons.has(holder?.reason ?? '') ? holder!.reason : 'unknown';
    const rawPid = holder?.pid;
    const pid = typeof rawPid === 'number' && Number.isInteger(rawPid) && rawPid > 0 ? rawPid : 'none';
    throw new Error(`Could not establish exclusive ownership of the saved native session `
      + `(backend=${native.backend}, probe=${reason}, held=${holder?.held === true}, pid=${pid}, `
      + `force=${process.env.PSU_FORCE_RESUME === '1'})`);
  }
  const floor = await checkInteractiveSafetyFloor();
  if (!floor.ok) throw new Error(floor.reason);
  const key = `pui-resume:${randomUUID()}`;
  const lease = await acquireAdvSessionResume(row.id, key, 300, undefined, evidence);
  if (!lease.acquired) throw new Error(`The saved session cannot be resumed (${lease.status})`);
  let finalized = false;
  const release = async () => { if (!finalized) await releaseAdvSessionResume(row.id, key); };
  try {
    const operatorUrl = resolveSpawnHostOperatorBaseUrl();
    const restored = await ensureResumeTranscriptPresent(session, {
      rematerialize: (id, backend) => tryRematerializeFromArchive(id, backend, { operatorUrl }),
    });
    // A Claude engine that died before writing a single native line (startup
    // failure, or death before the prompt reached it) left no conversation to
    // restore. Start the SAME native id fresh rather than refusing every
    // reconnect forever: nothing native is lost, and the dead turn is never
    // re-executed. A pending restore, and Codex/OMP, keep the refusal.
    const exact = restored === true;
    if (!exact && (restored !== false || record.backend !== 'claude')) {
      throw new Error('The native transcript is unavailable or still being restored');
    }
    const { resolveAccountPin } = await import('./endpoint-route/routes/agent-mcp/bootstrap-su');
    const account = saved.accountRoute ?? 'default';
    let model = spec.model ?? saved.model;
    // The native init frame reports only the resolved model id, never the
    // Claude Code `[1m]` window marker. A PUI conversation launched on the
    // implicit/default model can therefore have only `saved.model` available
    // after an operator restart. Reapply the launcher's canonical Claude-only
    // normalization before both route resolution and SDK startup; otherwise a
    // restored 1M transcript is locally rejected against Claude's 200K window
    // before its next request can reach the gateway.
    if (record.backend === 'claude') model = normalizeModelSpecForAgent('claude', model);
    const accountPin = await resolveAccountPin(record.workspaceId, account, record.backend, record.ownerId, true, model);
    if (accountPin.error) throw new Error(accountPin.error);
    const accountRoute = { mode: accountPin.gatewayAuto || account === 'auto' || account === 'gateway' ? 'auto'
      : accountPin.accountId ? 'pin' : 'default', id: accountPin.accountId,
      provider: accountPin.provider, env: accountPin.env };
    const envelope = await buildConsoleEnvelope({ workspaceId: record.workspaceId,
      slug: record.harnessSlug, operatorBaseUrl: operatorUrl });
    const env = Object.fromEntries(Object.entries({ ...envelope.env, ...buildResumeEnv(session, { accountEnv: accountRoute }),
      PAPERCUSP_PROFILE: spec.profile, PAPERCUSP_OPERATOR_URL: operatorUrl,
      ...(spec.specificationRevision ? { PAPERCUSP_SPECIFICATION_REVISION: spec.specificationRevision } : {}),
      ...(spec.stateRevision ? { PAPERCUSP_STATE_REVISION: spec.stateRevision } : {}),
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    if (spec.fleet?.slug) env.PAPERCUSP_FLEET_SLUG = spec.fleet.slug;
    if (spec.fleet?.role) env.PAPERCUSP_FLEET_ROLE = spec.fleet.role;
    let promptFile = launchContextPathFor(row.id);
    if (native.backend === 'claude') {
      if (!native.configDir) throw new Error('The saved Claude configuration directory is unavailable');
      await ensureInteractiveConfigViaOperator(record.ownerId, native.configDir, { operatorUrl });
      if (!isClaudeConfigDirLaunchReady(native.configDir)) throw new Error('The saved Claude SU configuration is not ready');
      if (accountRoute.mode === 'default') rehealResumeCredentials(native.configDir);
      env.CLAUDE_CONFIG_DIR = native.configDir;
    } else if (native.backend === 'codex') {
      if (!native.codexHome) throw new Error('The saved Codex home is unavailable');
      await ensureCodexHomeViaOperator(record.ownerId, native.codexHome, row.id,
        { operatorUrl, requireGatewayProvider: accountRoute.mode !== 'default' });
      if (!isCodexHomeLaunchReady(native.codexHome, record.ownerId)) throw new Error('The saved Codex SU configuration is not ready');
      if (accountRoute.mode === 'default') rehealResumeCodexAuth(native.codexHome);
      applyCodexGatewayRoute(native.codexHome, { ...accountRoute, ownerId: record.ownerId,
        priority: 'su', keepProviderTableWhenUnrouted: true });
      env.CODEX_HOME = native.codexHome;
      promptFile = join(native.codexHome, 'AGENTS.md');
    } else {
      Object.assign(env, ompTrackedResumeEnv(session));
      if (!native.agentHome || env.PI_CODING_AGENT_DIR !== native.agentHome) {
        throw new Error('The saved OMP home does not match the restored SU configuration');
      }
      const pathOptions = { rootOverride: join(native.agentHome, 'sessions') };
      if (!await findOmpSessionPath(nativeId, pathOptions)) {
        await tryRematerializeFromArchive(nativeId, 'omp', { operatorUrl });
      }
      if (!await findOmpSessionPath(nativeId, pathOptions)) {
        throw new Error('The saved OMP session is unavailable in its original SU home');
      }
      model = applyOmpResumeAccountRoute({ session, env, accountRoute, model });
      env.PAPERCUSP_OMP_MODEL_SELECTOR = model ?? '';
    }
    if (!existsSync(promptFile)) throw new Error('The saved full SU instruction artifact is unavailable');
    const coordExt = join(homedir(), '.papercusp', 'papercusp-coord.ts');
    const boot: BootstrapSuResult = { status: 'ok', sessionId: row.id, nativeSessionId: nativeId,
      agent: record.backend, workspaceId: record.workspaceId, harnessSlug: record.harnessSlug,
      planSlug: spec.planSlug, cwd: row.cwd, promptFile, envelopeEnv: env,
      codexHome: native.backend === 'codex' ? native.codexHome : null,
      coordExtPath: existsSync(coordExt) ? coordExt : null,
      specificationRevision: spec.specificationRevision ?? '', stateRevision: spec.stateRevision ?? '',
      compositionSource: 'compatibility' };
    const binding: PuiSuSessionBinding = { operation: 'attached', backend: record.backend,
      advSessionId: row.id, ownerId: record.ownerId, workspaceId: record.workspaceId,
      harnessSlug: record.harnessSlug, planSlug: spec.planSlug, nativeSession: native };
    return { boot, binding, nativeSession: native, release, exact,
      options: { agentChatId: saved.identity.agentChatId, model, accountRoute: account,
        carry: saved.carry, modes: saved.modes, runtimeGeneration: saved.runtimeGeneration + 1 },
      async beforeReady(pid: number | null) {
        if (!pid || pid <= 0) throw new Error('Resume produced no native process');
        await setAdvSessionPid(row.id, pid, `pui-structured-${record.backend}`);
        if (!await finalizeAdvSessionResume(row.id, key)) throw new Error('The resume reservation was lost before readiness');
        finalized = true;
      },
      async onExit() {
        if (finalized) await markAdvSessionEnded(row.id, null, 'cleanup', { throwOnError: true });
        else await release();
      },
    };
  } catch (error) { await release(); throw error; }
}
