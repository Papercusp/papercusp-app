/**
 * GET /api/desktop/setup-status — auto-detected status for every Setup
 * Wizard step. Each probe is wrapped so a single failure degrades to
 * 'unknown' without taking the rest down.
 *
 * Ported from app/api/desktop/setup-status/route.ts. `auth: {}`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';

import { readOperatorState } from '../../../operator-state-pg';
import { readCredentials } from '../../../credentials';
import { listDevices } from '../../../device-store';
import { activeWorkspaceId, readRegistry } from '../../../workspace-registry';
import { workspaceBackupFor } from '../../../backup';
import { anyAgentSignedIn } from '../../../agent-auth-detect';
import { detectClaude, detectCodex, detectOmp } from '../../../preflight-binaries';
import { defineTool } from '@papercusp/agent-mcp';

type StepStatus = 'ok' | 'needs-attention' | 'unknown';
type StepId =
  | 'os-permissions'
  | 'embedded-pg'
  | 'workspace'
  | 'agents'
  | 'logins'
  | 'keys'
  | 'git'
  | 'mobile-pairing'
  | 'backups'
  | 'auto-update'
  | 'telemetry';

const exec = promisify(execFile);

async function probePostgres(): Promise<boolean> {
  const useEmbedded = process.env.PAPERCUSP_USE_EMBEDDED_PG === '1';
  let result: boolean;
  let reason: string;
  if (useEmbedded) {
    const port = Number(process.env.PAPERCUSP_PG_PORT);
    if (!Number.isFinite(port) || port <= 0) {
      console.warn('[setup-status] probePostgres: PAPERCUSP_USE_EMBEDDED_PG=1 but PAPERCUSP_PG_PORT invalid');
      return false;
    }
    result = await tcpReachable('127.0.0.1', port);
    reason = `embedded port=${port}`;
  } else {
    result = await tcpReachable('127.0.0.1', 5432);
    reason = 'native :5432';
  }
  if (!result) console.warn(`[setup-status] probePostgres: ${reason} → not reachable`);
  return result;
}

function tcpReachable(host: string, port: number, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const start = Date.now();
    const done = (ok: boolean, why: string) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      if (!ok) console.warn(`[setup-status] tcpReachable ${host}:${port} → ${why} (${Date.now() - start}ms)`);
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, 'connect'));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (e) => done(false, `error: ${e.message}`));
    socket.connect(port, host);
  });
}

async function gitIdentityConfigured(): Promise<boolean> {
  try {
    const [name, email] = await Promise.all([
      exec('git', ['config', '--global', '--get', 'user.name'], { timeout: 2000 })
        .then((r) => r.stdout.trim())
        .catch(() => ''),
      exec('git', ['config', '--global', '--get', 'user.email'], { timeout: 2000 })
        .then((r) => r.stdout.trim())
        .catch(() => ''),
    ]);
    return name.length > 0 && email.length > 0;
  } catch {
    return false;
  }
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

function boolToStatus(ok: boolean): StepStatus {
  return ok ? 'ok' : 'needs-attention';
}

export interface ModelEgressStatus {
  /** INFERENCE_GATEWAY is on for this install — irrelevant (throttled always false)
   *  when off, since a direct-egress session isn't gateway-account-gated at all. */
  enabled: boolean;
  /** The gateway is reachable but every routable account is paused/rate-limited right
   *  now (WI-3186) — a real model call would 429 even though `logins`/`agents` read
   *  'ok' (they only prove a CLI is signed in, not that egress currently has budget).
   *  A single-account packaged install (the common Mac case) has no failover, so this
   *  is the state a fresh install commonly lands in after burning its window. */
  throttled: boolean;
  /** Seconds until the throttled window is expected to reset, when known. */
  retryAfterSec: number | null;
}

/**
 * WI-3186: the `logins`/`agents` steps only prove a CLI is signed in — they say nothing
 * about whether a real model call can go through RIGHT NOW. On a packaged single-account
 * install (no pool failover) that account's window commonly exhausts, and the only signal
 * used to be a raw `{gateway:true, error:{type:'rate_limit_error'}}` 429 body surfacing
 * wherever the first LLM call happened to fire — never surfaced in setup/onboarding as an
 * actionable, expected state. Reuses the SAME wholesale-throttle predicate the spawn
 * classifier trusts (`isWholesaleThrottled` / `gatewayWholesaleThrottled`, P-006/H13)
 * instead of inventing a second detector. Fail-soft: any probe error reads as
 * `{ enabled: false, throttled: false, retryAfterSec: null }` (never blocks setup-status).
 */
async function probeModelEgress(): Promise<ModelEgressStatus> {
  const notThrottled: ModelEgressStatus = { enabled: false, throttled: false, retryAfterSec: null };
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    if (!(await getFlag(FLAGS.INFERENCE_GATEWAY, 'system'))) return notThrottled;
    const { fetchGatewayHeadroom, isWholesaleThrottled } = await import('../../../inference-gateway/observability');
    const h = await fetchGatewayHeadroom({ timeoutMs: 1500 });
    if (h.reachable !== true) return { ...notThrottled, enabled: true };
    return { enabled: true, throttled: isWholesaleThrottled(h), retryAfterSec: h.resetInSec ?? null };
  } catch {
    return notThrottled;
  }
}

/**
 * Gather every Setup-Wizard step status + the agent-runtime breakdown — the
 * ONE detection read, shared by the GET route below and the `setup:status`
 * agent tool (agent-first-onboarding-2026-07-03 P-004), so the tutor and the
 * wizard sidebar can never disagree.
 */
export async function collectSetupStatus() {
  const ws = activeWorkspaceId();

  const [
    pgOk,
    claudeOk,
    codexOk,
    ompOk,
    creds,
    wizardState,
    devices,
    backupSettings,
    gitOk,
    modelEgress,
  ] = await Promise.all([
    safe(probePostgres(), false),
    safe(detectClaude(), false),
    safe(detectCodex(), false),
    safe(detectOmp(), false),
    safe(readCredentials(), {} as Awaited<ReturnType<typeof readCredentials>>),
    safe(
      readOperatorState<{
        update_channel?: string;
        telemetry_enabled?: boolean | null;
        os_permissions_ok?: boolean;
      }>('setup_wizard_state'),
      null,
    ),
    safe(listDevices(ws), [] as Awaited<ReturnType<typeof listDevices>>),
    safe(workspaceBackupFor(ws).getSettings(), null as Awaited<ReturnType<ReturnType<typeof workspaceBackupFor>['getSettings']>> | null),
    safe(gitIdentityConfigured(), false),
    probeModelEgress(),
  ]);

  // os-permissions: Linux/Windows aren't install-gated → 'ok'. macOS
  // has system-level grants the Node server can't read, so we trust
  // the client-side StepOsPermissions probes that PATCH
  // os_permissions_ok back into operator state.
  const osPermissionsStatus: StepStatus =
    process.platform === 'darwin'
      ? wizardState?.os_permissions_ok === true
        ? 'ok'
        : 'needs-attention'
      : 'ok';

  // workspace: registry has at least one entry.
  const workspaceOk = readRegistry().workspaces.length > 0;

  // agents: a complete backend is any standalone CLI agent — Claude Code,
  // Codex, or oh-my-pi (the orchestrator drives the CLI directly). Any one
  // satisfies the step.
  const agentsOk = claudeOk || codexOk || ompOk;

  // keys/memory: the OpenAI embeddings key is REQUIRED (mem0 memory + semantic
  // search — owner 2026-07-06); other provider/voice keys are optional, so the
  // step's status tracks the required key specifically.
  const keysOk = Boolean(creds.openai_api_key);

  const statuses: Record<StepId, StepStatus> = {
    'os-permissions': osPermissionsStatus,
    'embedded-pg': boolToStatus(pgOk),
    workspace: boolToStatus(workspaceOk),
    agents: boolToStatus(agentsOk),
    logins: boolToStatus(anyAgentSignedIn()),
    keys: boolToStatus(keysOk),
    git: boolToStatus(gitOk),
    'mobile-pairing': boolToStatus(devices.length > 0),
    backups: boolToStatus(Boolean(backupSettings?.enabled)),
    'auto-update': boolToStatus(
      wizardState?.update_channel === 'alpha' ||
        wizardState?.update_channel === 'beta' ||
        wizardState?.update_channel === 'stable',
    ),
    telemetry: boolToStatus(
      wizardState?.telemetry_enabled === true ||
        wizardState?.telemetry_enabled === false,
    ),
  };

  // Per-component breakdown for the Agent Runtime step.
  const agentRuntime = { claude: claudeOk, codex: codexOk, omp: ompOk };

  return { statuses, agentRuntime, modelEgress };
}

export default defineTool({
  method: 'GET',
  path: '/desktop/setup-status',
  auth: {},
  async handler() {
    return Response.json(await collectSetupStatus());
  },
});
