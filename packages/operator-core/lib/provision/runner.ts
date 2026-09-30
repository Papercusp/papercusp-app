/**
 * Provision-runner — orchestrates setup/teardown/verify for one
 * `(harness, plugin)` pair.
 *
 * Responsibilities:
 *   - hash check + idempotency decision (configHash, scriptHash, pluginVersion)
 *   - sandbox the script (bwrap on Linux, sandbox-exec on macOS)
 *   - bridge `papercusp_record_resource` shell calls into WAL appends
 *   - capture stdout/stderr to audit log
 *   - update state.json on completion
 *
 * Spec: /docs/snapshots/build-scripts.
 */

import { promises as fs } from 'node:fs';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { spawn } from 'node:child_process';
import { join, resolve as pathResolve } from 'node:path';
import { RUNTIME_LIB_SH } from './runtime/lib-source';
import { computeConfigHash, computeScriptHash, decideReprovision } from './hashes';
import { appendAudit, AuditStream } from './audit-log';
import {
  appendStateOutput,
  appendWalEntry,
  provisionDir,
  readState,
  writeState,
  type ProvisionState,
  type RecordedResource,
} from './state-store';
import { buildSandbox, type SandboxBuildResult } from './sandbox';
import { buildNetworkPolicy } from './network-policy';

/**
 * Writes the inlined RUNTIME_LIB_SH content to `<scratch>/papercusp-lib.sh`
 * and returns the path. Called per phase; idempotent (if the file already
 * exists with the same content, no-op).
 *
 * Why per-phase: bundling rewrites `__dirname` so a static path-resolve
 * doesn't survive Next.js + turbopack. Inlining the helper text + writing
 * to scratch dodges the bundler entirely.
 */
async function materializeRuntimeLib(scratchDir: string): Promise<string> {
  const path = join(scratchDir, 'papercusp-lib.sh');
  await fs.writeFile(path, RUNTIME_LIB_SH, { mode: 0o644 });
  return path;
}

export interface ProvisionRunInputs {
  harness: string;
  plugin: string;
  /** Plugin's publisher (for audit + trust). */
  publisher: string;
  /** Plugin's version (for idempotency). */
  pluginVersion: string;
  /** Absolute path to the plugin's directory. */
  pluginDir: string;
  /**
   * Absolute path to the harness's project directory. Mounted RW into
   * the sandbox; exposed as `$PAPERCUSP_PROJECT_DIR`. Required for
   * `papercusp_render_templates` and any setup script that templates
   * project files. Optional only for plugins that don't touch the
   * project dir.
   */
  projectDir?: string;
  /** Plugin's per-harness config (raw object). */
  config: Record<string, unknown>;
  /** Manifest provision section. */
  provision: {
    setup?: { path: string; timeoutSec?: number };
    teardown?: { path: string; timeoutSec?: number };
    verify?: { path: string; timeoutSec?: number };
    cloudProvider?: { id: string; region?: string; regions?: string[] };
    allowedHosts?: string[];
    skipReprovisionOnPatch?: boolean;
    auditLogCapMb?: number;
  };
  /**
   * Confirm consent for this run. The caller (consent UI) is responsible
   * for verifying scriptHash matches an approved entry in the trust store.
   */
  consentConfirmed: boolean;
}

export type ProvisionPhase = 'setup' | 'teardown' | 'verify';

export interface ProvisionRunResult {
  ok: boolean;
  phase: ProvisionPhase;
  decision: ReturnType<typeof decideReprovision>;
  runId?: string;
  exitCode?: number;
  durationMs: number;
  error?: string;
  /** State after the run completed (or null on consent-rejection). */
  state?: ProvisionState;
}

function scratchDir(harness: string, plugin: string): string {
  return join(provisionDir(harness, plugin), 'scratch');
}

async function ensureScratch(harness: string, plugin: string): Promise<string> {
  const d = scratchDir(harness, plugin);
  await fs.mkdir(d, { recursive: true });
  return d;
}

/**
 * Resolve the script path against the plugin dir + check it exists.
 */
async function resolveScript(
  pluginDir: string,
  rel: string,
): Promise<{ path: string; exists: boolean }> {
  const path = pathResolve(pluginDir, rel);
  // Guard: the resolved path must remain inside pluginDir (no `../../`).
  if (!path.startsWith(pluginDir)) {
    return { path, exists: false };
  }
  try {
    await fs.access(path);
    return { path, exists: true };
  } catch {
    return { path, exists: false };
  }
}

/**
 * Run one phase. Returns a structured result; never throws on script
 * failure (the result captures it).
 */
export async function runPhase(
  phase: ProvisionPhase,
  inputs: ProvisionRunInputs,
): Promise<ProvisionRunResult> {
  const t0 = Date.now();
  const scriptDecl =
    phase === 'setup' ? inputs.provision.setup
    : phase === 'teardown' ? inputs.provision.teardown
    : inputs.provision.verify;

  if (!scriptDecl) {
    return {
      ok: false,
      phase,
      decision: 'fresh',
      durationMs: 0,
      error: `no ${phase} script declared`,
    };
  }

  const { path: scriptPath, exists } = await resolveScript(inputs.pluginDir, scriptDecl.path);
  if (!exists) {
    return {
      ok: false,
      phase,
      decision: 'fresh',
      durationMs: 0,
      error: `script not found: ${scriptDecl.path}`,
    };
  }

  // Compute hashes for idempotency decisioning. Setup checks; teardown +
  // verify always run regardless.
  const scriptHash = await computeScriptHash(scriptPath);
  const configHash = computeConfigHash(inputs.config);
  const prior = await readState(inputs.harness, inputs.plugin);

  let decision: ReturnType<typeof decideReprovision> = 'fresh';
  if (phase === 'setup') {
    decision = decideReprovision(prior.hashes, {
      configHash,
      scriptHash,
      pluginVersion: inputs.pluginVersion,
    });
    if (decision === 'unchanged') {
      return { ok: true, phase, decision, durationMs: Date.now() - t0, state: prior };
    }
    if (decision === 'version-patch' && inputs.provision.skipReprovisionOnPatch) {
      // Spec: skipReprovisionOnPatch governs version-patch when scriptHash matches.
      // scriptHash already matched (otherwise we'd be in script-changed).
      return { ok: true, phase, decision, durationMs: Date.now() - t0, state: prior };
    }
  }

  if (!inputs.consentConfirmed) {
    await appendAudit(inputs.harness, inputs.plugin, {
      kind: 'consent-rejected',
      data: { phase, scriptHash },
    }, inputs.provision.auditLogCapMb);
    return {
      ok: false,
      phase,
      decision,
      durationMs: Date.now() - t0,
      error: 'consent not confirmed',
    };
  }

  // Concurrency control is the provision workflow's job now (dbos-flows P-001):
  // its `deduplicationID` is the cross-request mutex and DBOS recovery is the
  // liveness. This run just owns its phase; a `dbos-` runId tags the audit rows.
  // The legacy PG operator-claims advisory lock + 30s heartbeat were DELETED in
  // P-002 once DBOS provisioning was live crash-resume-verified — no shim, no
  // `=0` revert (pre-alpha cut-over, D-003).
  const runId = `dbos-${Date.now().toString(36)}`;

  await appendAudit(inputs.harness, inputs.plugin, {
    kind: phase === 'setup' ? 'setup-started' : phase === 'teardown' ? 'teardown-started' : 'verify-started',
    runId,
    data: { scriptHash, configHash, pluginVersion: inputs.pluginVersion, decision },
  }, inputs.provision.auditLogCapMb);

  // Surface sandbox bypass loudly — built before sandbox so the bypass
  // reason is recorded once per run, regardless of script outcome.
  // (We rebuild it just below to apply env vars; this is a cheap pre-check.)
  {
    const probe = buildSandbox({
      pluginDir: inputs.pluginDir,
      scratchDir: '/tmp', // shape-only probe; not the real scratch
      allowedHosts: [],
      env: {},
    });
    if (probe.smokeBypass) {
      await appendAudit(inputs.harness, inputs.plugin, {
        kind: 'sandbox-bypass',
        runId,
        data: { reason: probe.smokeBypass.reason, flag: 'PAPERCUSP_ALLOW_NO_SANDBOX' },
      }, inputs.provision.auditLogCapMb);
    }
  }

  const scratch = await ensureScratch(inputs.harness, inputs.plugin);
  const runtimeLibPath = await materializeRuntimeLib(scratch);
  const networkPolicy = buildNetworkPolicy({
    cloudProvider: inputs.provision.cloudProvider,
    allowedHosts: inputs.provision.allowedHosts,
  });
  // Snapshot the current state so teardown / verify scripts can read the
  // resources setup recorded. The state is JSON-encoded into an env var
  // (`PAPERCUSP_PLUGIN_STATE`) so scripts use either env or stdin form.
  let pluginStateJson: string | undefined;
  if (phase === 'teardown' || phase === 'verify') {
    try {
      const cur = await readState(inputs.harness, inputs.plugin);
      pluginStateJson = JSON.stringify(cur);
    } catch {
      pluginStateJson = '{"createdResources":[],"outputs":{}}';
    }
  }
  const sandbox = buildSandbox({
    pluginDir: inputs.pluginDir,
    scratchDir: scratch,
    projectDir: inputs.projectDir,
    allowedHosts: networkPolicy.allowedHosts,
    env: {
      PAPERCUSP_PLUGIN_DIR: inputs.pluginDir,
      PAPERCUSP_SCRATCH_DIR: scratch,
      PAPERCUSP_RUNTIME_LIB: runtimeLibPath,
      PAPERCUSP_PLUGIN_NAME: inputs.plugin,
      PAPERCUSP_HARNESS_SLUG: inputs.harness,
      PAPERCUSP_PHASE: phase,
      PAPERCUSP_RECORD_FIFO: join(scratch, '.papercusp-record-fifo'),
      // Pass through plugin config as JSON env var.
      PAPERCUSP_CONFIG: JSON.stringify(inputs.config),
      // Flattened USER_VAR_* shortcuts for top-level scalar config fields,
      // so plugin scripts can use envsubst directly without jq-parsing
      // PAPERCUSP_CONFIG. Mirrors the dev-container Features convention.
      ...flattenConfigToUserVars(inputs.config),
      // Project dir (only if provided) — exposed for render-templates and
      // any script that needs to write into the harness's project files.
      ...(inputs.projectDir ? { PAPERCUSP_PROJECT_DIR: inputs.projectDir } : {}),
      // Plugin state snapshot — only set for teardown + verify phases, so
      // those scripts can read the resources setup recorded.
      ...(pluginStateJson ? { PAPERCUSP_PLUGIN_STATE: pluginStateJson } : {}),
      PATH: process.env.PATH ?? '',
      HOME: scratch,
    },
  });

  // Open a FIFO bridge: the substrate watches for record_resource writes
  // and folds them into the WAL in real time. Implementation detail: we
  // create a regular file and tail it; full FIFO support adds complexity
  // not warranted in V1.
  const fifoPath = join(scratch, '.papercusp-record-fifo');
  await fs.writeFile(fifoPath, '');

  const audit = new AuditStream(inputs.harness, inputs.plugin, runId);
  await audit.open();

  const result = await runScript({
    sandbox,
    scriptPath,
    timeoutMs: (scriptDecl.timeoutSec ?? 600) * 1000,
    onStdout: async (line) => {
      // Surface ::papercusp:: markers as their own audit events.
      await audit.write(line);
    },
    onStderr: async (line) => {
      await audit.write('STDERR: ' + line);
    },
    fifoPath,
    outputAppender: async (key, value) => {
      await appendStateOutput(inputs.harness, inputs.plugin, key, value);
      await appendAudit(inputs.harness, inputs.plugin, {
        kind: 'state-set',
        runId,
        data: { key },
      }, inputs.provision.auditLogCapMb);
    },
    walAppender: async (entry) => {
      await appendWalEntry(inputs.harness, inputs.plugin, entry);
      await appendAudit(inputs.harness, inputs.plugin, {
        kind: 'resource-recorded',
        runId,
        data: { kind: entry.kind, externalId: entry.externalId },
      }, inputs.provision.auditLogCapMb);
    },
  });

  await audit.close();

  // Update state.json with new hashes + outcome.
  const folded = await readState(inputs.harness, inputs.plugin);
  const newState: ProvisionState = {
    ...folded,
    schemaVersion: 1,
    setupFailed: phase === 'setup' ? !result.ok : folded.setupFailed,
    setupError: phase === 'setup' && !result.ok ? result.error ?? `exit ${result.exitCode}` : undefined,
    lastSetupAt: phase === 'setup' && result.ok ? new Date().toISOString() : folded.lastSetupAt,
    lastVerifyAt: phase === 'verify' && result.ok ? new Date().toISOString() : folded.lastVerifyAt,
    hashes: phase === 'setup' && result.ok
      ? { configHash, scriptHash, pluginVersion: inputs.pluginVersion }
      : folded.hashes,
  };
  await writeState(inputs.harness, inputs.plugin, newState);

  await appendAudit(inputs.harness, inputs.plugin, {
    kind: result.ok
      ? (phase === 'setup' ? 'setup-succeeded' : phase === 'teardown' ? 'teardown-succeeded' : 'verify-succeeded')
      : (phase === 'setup' ? 'setup-failed' : phase === 'teardown' ? 'teardown-failed' : 'verify-failed'),
    runId,
    data: { exitCode: result.exitCode, durationMs: Date.now() - t0 },
  }, inputs.provision.auditLogCapMb);

  return {
    ok: result.ok,
    phase,
    decision,
    runId,
    exitCode: result.exitCode ?? undefined,
    durationMs: Date.now() - t0,
    error: result.error,
    state: newState,
  };
}

interface ScriptRunInputs {
  sandbox: SandboxBuildResult;
  scriptPath: string;
  timeoutMs: number;
  onStdout: (line: string) => Promise<void>;
  onStderr: (line: string) => Promise<void>;
  fifoPath: string;
  walAppender: (r: RecordedResource) => Promise<void>;
  /** Called for `papercusp_state_set` writes — folds into state.outputs. */
  outputAppender: (key: string, value: unknown) => Promise<void>;
}

interface ScriptRunResult {
  ok: boolean;
  exitCode: number | null | undefined;
  error?: string;
}

async function runScript(input: ScriptRunInputs): Promise<ScriptRunResult> {
  const argv = input.sandbox.active
    ? [...input.sandbox.argv, '/bin/bash', input.scriptPath]
    : ['/bin/bash', input.scriptPath];
  const [bin, ...rest] = argv;

  // Tail the FIFO file in 200ms ticks; fold each new line into WAL.
  let fifoPos = 0;
  // Carries an in-progress JSON object across drain ticks. Plugin authors
  // who emit pretty-printed JSON (e.g. `jq -n` without `-c`) split a
  // single object across multiple FIFO lines; we accumulate until JSON.parse
  // succeeds, then dispatch.
  let pendingChunk = '';
  const drainFifo = async () => {
    try {
      const stat = await fs.stat(input.fifoPath);
      if (stat.size > fifoPos) {
        const handle = await fs.open(input.fifoPath, 'r');
        const buf = Buffer.alloc(stat.size - fifoPos);
        await handle.read(buf, 0, buf.length, fifoPos);
        await handle.close();
        fifoPos = stat.size;
        for (const line of buf.toString().split('\n')) {
          if (!line.trim()) {
            // blank line is a soft separator — drop any half-formed chunk
            pendingChunk = '';
            continue;
          }
          pendingChunk = pendingChunk ? pendingChunk + '\n' + line : line;
          let j: unknown;
          try {
            j = JSON.parse(pendingChunk);
          } catch {
            // Not yet a complete object; wait for next line.
            // Cap accumulation to avoid unbounded buffer if input is junk.
            if (pendingChunk.length > 64 * 1024) pendingChunk = '';
            continue;
          }
          pendingChunk = '';
          if (j && typeof j === 'object') {
            const obj = j as Record<string, unknown>;
            if (obj.$op === 'state_set' && typeof obj.key === 'string') {
              await input.outputAppender(obj.key, obj.value);
            } else if (typeof obj.kind === 'string' && typeof obj.externalId === 'string') {
              await input.walAppender(obj as unknown as RecordedResource);
            }
          }
        }
      }
    } catch {
      // fifo missing — fine
    }
  };
  const fifoTimer = managedSetInterval('provision-fifo-drain', 200, drainFifo, { category: 'lifecycle', instanced: true });

  return await new Promise<ScriptRunResult>((resolve) => {
    const child = spawn(bin, rest, {
      env: input.sandbox.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.stdout || !child.stderr) {
      resolve({ ok: false, exitCode: null, error: 'failed to attach stdout/stderr' });
      return;
    }
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        input.onStdout(line).catch(() => { /* ignore */ });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        input.onStderr(line).catch(() => { /* ignore */ });
      }
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }, input.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      fifoTimer.stop();
      // Final FIFO drain in case the script wrote-then-errored.
      drainFifo().finally(() => {
        resolve({ ok: false, exitCode: null, error: err.message });
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      fifoTimer.stop();
      // flush remaining stdout/stderr buffers
      if (stdoutBuf) input.onStdout(stdoutBuf).catch(() => { /* ignore */ });
      if (stderrBuf) input.onStderr(stderrBuf).catch(() => { /* ignore */ });
      // Final FIFO drain — the script may have written record_resource +
      // state_set entries between the last poll tick and exit. Without
      // this, end-of-script writes are silently lost.
      drainFifo().finally(() => {
        if (timedOut) {
          resolve({ ok: false, exitCode: code, error: `timeout` });
        } else {
          resolve({ ok: code === 0, exitCode: code });
        }
      });
    });
  });
}

/**
 * Flatten top-level scalar config fields into `USER_VAR_<UPPER_KEY>` env
 * vars. Strings, numbers, booleans, and null pass through (null → empty).
 * Objects, arrays, and undefined are skipped — nested values stay
 * accessible via `$PAPERCUSP_CONFIG` parsed with jq.
 *
 * Key transform: lowerCamel → UPPER_SNAKE matching the dev-container
 * Features `OPTION_NAME` convention. Non-alphanumeric chars become `_`.
 */
export function flattenConfigToUserVars(
  config: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number' &&
        typeof value !== 'boolean' && value !== null) continue;
    const upper = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!upper) continue;
    out[`USER_VAR_${upper}`] = value === null ? '' : String(value);
  }
  return out;
}
