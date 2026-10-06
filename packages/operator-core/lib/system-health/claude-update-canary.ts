/**
 * claude-update-canary (WI-10006236, owner Avi 2026-10-05, directive #1309 prevention).
 *
 * THE CLASS. Claude Code updates itself on this box (~/.local/share/claude/versions,
 * with ~/.local/bin/claude symlinked to the active build). An update can silently change
 * a default Papercusp depends on. 2.1.284 → 2.1.289 (2026-10-05 14:56Z) made the bare
 * /model menu save the 200k Opus pick, the gateway then served 200k, and the first trace
 * was a session resetting 8 times in an hour (WI-10006049). Nothing tested the new
 * build before forty agents ran on it.
 *
 * WHAT THIS DOES. Once per new ACTIVE build (and once per host boot, which also covers
 * a gateway or route change shipped by a deploy), run the build itself headlessly
 * through the inference gateway: one tiny `-p` request, exactly as an agent's CLI would
 * send it. Then read the gateway's SERVED route for that probe owner and check that
 * a model family Papercusp serves at 1M by default was actually served at 1M, the
 * window the compaction watchdog reads (`servedWindowForRoute`). Two variants:
 *   - `default`: no model setting, the build's own default pick;
 *   - `saved`: the model saved in ~/.claude/settings.json (what the /model menu writes),
 *     when one is set.
 * A mismatch opens an owner-facing escalation naming the build. A probe that could not
 * measure (binary missing, CLI error, no gateway route) escalates as NOT MEASURED. It
 * never reads as clean (same rule as installed-hook-drift-watchdog DESIGN DECISION 1).
 *
 * ISOLATION. The probe runs with `--setting-sources project` from an empty temp dir, so
 * the user's hooks never fire: the papercusp UserPromptSubmit hook would otherwise
 * record the probe prompt as an owner turn. `--no-session-persistence` leaves no
 * transcript. `--strict-mcp-config` loads no MCP servers. Cost: about 8k input tokens
 * and 5 s per variant (measured 2026-10-06 on 2.1.289).
 *
 * WHY NO PERSISTED "last verified version". Re-probing once per boot is intentional:
 * a deploy can change the gateway route with no CLI update, and the boot probe catches
 * that. The in-process `lastProbed` key prevents repeats within a process; escalation
 * coalescing (`subjectSignature` keyed on the build) prevents duplicate alarms across
 * boots.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import {
  defaultCompactionLimitForWindow,
  isDefault1mModelSpec,
  MODEL_WINDOW_1M,
} from '../agent-config-constants';
import { isHostSingleton } from '../background-workers';
import {
  gatewayServedRouteForOwner,
  servedWindowForRoute,
  type GatewayServedRoute,
} from '../compaction-usage';

/** A new build is picked up within one interval; the probe itself runs once per build. */
export const CLAUDE_UPDATE_CANARY_INTERVAL_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 150_000;
const PROBE_PROMPT = 'Reply with the single word OK.';
/** Same values psu-launcher's gatewayAutoEnv sends (GATEWAY_CLIENT_AUTH_TOKEN,
 *  ACCOUNT_ROUTING_MODE_ENV, GATEWAY_OWNER_HEADER). The launcher is a plain .mjs exec'd by
 *  node, so it is mirrored here rather than imported. */
const GATEWAY_AUTH_TOKEN = 'papercusp-gateway';
const GATEWAY_OWNER_HEADER = 'x-papercusp-owner';

const CANARY_IDENTITY: AgentIdentity = {
  ownerId: 'claude-update-canary',
  ownerLabel: 'system · claude update canary',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export type CanaryVariant = 'default' | 'saved';

export interface ActiveClaudeBuild {
  version: string;
  binary: string;
}

/** What one `-p --output-format json` run reported. */
export interface CliProbeResult {
  ok: boolean;
  /** Set when the CLI did not run or its output was unusable. */
  error?: string;
  /** Per-model usage the CLI reported: model id and the context window the CLI assumed. */
  models: Array<{ id: string; contextWindow: number | null }>;
}

export interface CanaryProbe {
  variant: CanaryVariant;
  /** The model setting passed to the build; null for the `default` variant. */
  modelSetting: string | null;
  startedAt: number;
  cli: CliProbeResult;
  route: GatewayServedRoute | null;
}

export interface CanaryVariantVerdict {
  variant: CanaryVariant;
  verdict: 'pass' | 'fail' | 'not-measured';
  /** Why it failed, or why it could not be measured. Empty on pass. */
  problems: string[];
  servedModel: string | null;
  servedWindow: number | null;
  seededLimit: number | null;
  cliWindows: string;
}

/** Parse `claude -p --output-format json` stdout. Never throws. */
export function parseCliProbeOutput(stdout: string): CliProbeResult {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { ok: false, error: 'CLI output was not JSON', models: [] };
  }
  const o = j as { is_error?: unknown; result?: unknown; modelUsage?: Record<string, { contextWindow?: unknown }> };
  const models = Object.entries(o.modelUsage ?? {}).map(([id, u]) => ({
    id,
    contextWindow: typeof u?.contextWindow === 'number' ? u.contextWindow : null,
  }));
  if (o.is_error === true) {
    return { ok: false, error: `CLI reported an error: ${String(o.result ?? '').slice(0, 200)}`, models };
  }
  return { ok: true, models };
}

/** Judge one probe. Pure, so every branch is unit-tested. */
export function evaluateCanaryProbe(probe: CanaryProbe): CanaryVariantVerdict {
  const cliWindows = probe.cli.models.map((m) => `${m.id}=${m.contextWindow ?? '?'}`).join(', ') || 'none';
  const base = { variant: probe.variant, cliWindows };
  if (!probe.cli.ok) {
    return { ...base, verdict: 'not-measured', problems: [probe.cli.error ?? 'CLI probe failed'], servedModel: null, servedWindow: null, seededLimit: null };
  }
  const route = probe.route;
  if (!route?.model) {
    return {
      ...base,
      verdict: 'not-measured',
      problems: ['the gateway has no served route for the probe owner, so the request did not go through it'],
      servedModel: null,
      servedWindow: null,
      seededLimit: null,
    };
  }
  if (route.at != null && route.at < probe.startedAt) {
    return {
      ...base,
      verdict: 'not-measured',
      problems: ['the gateway route predates this probe, so it describes an earlier request'],
      servedModel: route.model,
      servedWindow: null,
      seededLimit: null,
    };
  }
  const servedWindow = servedWindowForRoute(route);
  const seededLimit = servedWindow == null ? null : defaultCompactionLimitForWindow(servedWindow);
  const out = { ...base, servedModel: route.model, servedWindow, seededLimit };
  if (servedWindow == null) {
    return { ...out, verdict: 'not-measured', problems: ['the gateway did not report whether it sent the 1M context beta'] };
  }
  if (isDefault1mModelSpec(route.model) && servedWindow < MODEL_WINDOW_1M) {
    return {
      ...out,
      verdict: 'fail',
      problems: [
        `model ${route.model} is served at 1M by default, but the gateway served it at ${servedWindow} tokens ` +
          `(context1m=${String(route.context1m)}), so Papercusp would seed a ${seededLimit}-token compaction limit`,
      ],
    };
  }
  return { ...out, verdict: 'pass', problems: [] };
}

function semverParts(v: string): number[] {
  return v.split('.').map((p) => Number.parseInt(p, 10) || 0);
}

/** Newest-first compare for dotted numeric versions ("2.1.289" > "2.1.84"). */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The build agents actually run: the target of ~/.local/bin/claude when it points into the
 *  versions dir, else the newest installed version. Null when nothing is installed. */
export async function resolveActiveClaudeBuild(homeDir: string = os.homedir()): Promise<ActiveClaudeBuild | null> {
  const versionsDir = path.join(homeDir, '.local', 'share', 'claude', 'versions');
  try {
    const target = await fs.realpath(path.join(homeDir, '.local', 'bin', 'claude'));
    if (path.dirname(target) === versionsDir) return { version: path.basename(target), binary: target };
  } catch {
    /* no symlink: fall back to the newest installed build */
  }
  try {
    const entries = (await fs.readdir(versionsDir)).filter((e) => /^\d+(\.\d+)+$/.test(e)).sort(compareVersionsDesc);
    if (entries.length === 0) return null;
    return { version: entries[0]!, binary: path.join(versionsDir, entries[0]!) };
  } catch {
    return null;
  }
}

/** The `model` saved in ~/.claude/settings.json (what the /model menu writes), or null. */
export async function readSavedModelSetting(homeDir: string = os.homedir()): Promise<string | null> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8')) as { model?: unknown };
    return typeof j.model === 'string' && j.model.trim() ? j.model.trim() : null;
  } catch {
    return null;
  }
}

function gatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : 8788;
}

/** Run the build once through the gateway as `probeOwner`. Never throws. */
export async function runCliProbe(input: {
  binary: string;
  probeOwner: string;
  modelSetting: string | null;
}): Promise<CliProbeResult> {
  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-update-canary-'));
    const args = [
      '-p',
      PROBE_PROMPT,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--setting-sources',
      'project',
      '--strict-mcp-config',
    ];
    if (input.modelSetting) args.push('--settings', JSON.stringify({ model: input.modelSetting }));
    const env: NodeJS.ProcessEnv = {
      HOME: os.homedir(),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${gatewayPort()}`,
      ANTHROPIC_AUTH_TOKEN: GATEWAY_AUTH_TOKEN,
      PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto',
      ANTHROPIC_CUSTOM_HEADERS: `${GATEWAY_OWNER_HEADER}: ${input.probeOwner}`,
    };
    const cwd = dir;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(input.binary, args, { cwd, env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) reject(new Error(`${err.message.slice(0, 160)} ${String(errOut).slice(0, 200)}`.trim()));
        else resolve(String(out));
      });
    });
    return parseCliProbeOutput(stdout);
  } catch (e) {
    return { ok: false, error: `CLI probe did not complete: ${e instanceof Error ? e.message : String(e)}`, models: [] };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface ClaudeUpdateCanaryDeps {
  resolveBuild: () => Promise<ActiveClaudeBuild | null>;
  readSavedModel: () => Promise<string | null>;
  probe: (input: { binary: string; probeOwner: string; modelSetting: string | null }) => Promise<CliProbeResult>;
  readRoute: (probeOwner: string) => Promise<GatewayServedRoute | null>;
  escalate: (input: { build: ActiveClaudeBuild | null; verdicts: CanaryVariantVerdict[]; kind: 'fail' | 'not-measured' }) => Promise<void>;
  now: () => number;
}

function canaryDeps(overrides: Partial<ClaudeUpdateCanaryDeps>): ClaudeUpdateCanaryDeps {
  return {
    resolveBuild: () => resolveActiveClaudeBuild(),
    readSavedModel: () => readSavedModelSetting(),
    probe: runCliProbe,
    readRoute: (owner) => gatewayServedRouteForOwner(owner, { timeoutMs: 3_000 }),
    escalate: defaultEscalate,
    now: () => Date.now(),
    ...overrides,
  };
}

function describeVerdicts(verdicts: CanaryVariantVerdict[]): string {
  return verdicts
    .map(
      (v) =>
        `- ${v.variant}: ${v.verdict.toUpperCase()}; served model ${v.servedModel ?? '?'} at ` +
        `${v.servedWindow ?? '?'} tokens, seeded limit ${v.seededLimit ?? '?'}; CLI assumed ${v.cliWindows}` +
        (v.problems.length ? `\n  ${v.problems.join('\n  ')}` : ''),
    )
    .join('\n');
}

async function defaultEscalate(input: {
  build: ActiveClaudeBuild | null;
  verdicts: CanaryVariantVerdict[];
  kind: 'fail' | 'not-measured';
}): Promise<void> {
  const version = input.build?.version ?? 'unknown';
  const failed = input.kind === 'fail';
  await openEscalation(CANARY_IDENTITY, {
    severity: failed ? 'blocker' : 'advisory',
    summary: failed
      ? `Claude Code ${version} is not served at 1M through the gateway: agents on it will hit 200k limits`
      : `Claude Code update canary NOT MEASURED for ${version}`,
    body:
      (failed
        ? `The update canary ran Claude Code ${version} through the inference gateway and a model Papercusp ` +
          `serves at 1M by default came back at a smaller window. This is the WI-10006049 class: an update ` +
          `changed a default, and sessions on this build will be re-limited and reset far more often.\n\n`
        : `The canary could not measure ${version}, so this is a FAILED MEASUREMENT, not a clean build.\n\n`) +
      `${describeVerdicts(input.verdicts)}\n\n` +
      `Binary: ${input.build?.binary ?? 'not found'}\n` +
      `Next: compare with the previous build in ~/.local/share/claude/versions, check gateway ` +
      `/admin/route for the probe owner, and see WI-10006049 for the last fix. (WI-10006236)`,
    meta: {
      dedupKind: failed ? 'claude-update-canary-fail' : 'claude-update-canary-not-measured',
      subjectSignature: `claude-update-canary:${input.kind}:${version}`,
      version,
      verdicts: input.verdicts.map((v) => ({ variant: v.variant, verdict: v.verdict, servedModel: v.servedModel, servedWindow: v.servedWindow })),
    },
  });
}

export type ClaudeUpdateCanaryOutcome =
  | { verdict: 'skipped'; version: string }
  | { verdict: 'pass' | 'fail' | 'not-measured'; version: string | null; variants: CanaryVariantVerdict[] };

/** The build key probed last in THIS process (see header: why nothing is persisted). */
let lastProbedKey: string | null = null;

/** Test seam. */
export function resetClaudeUpdateCanaryForTests(): void {
  lastProbedKey = null;
}

export async function runClaudeUpdateCanaryOnce(
  overrides: Partial<ClaudeUpdateCanaryDeps> = {},
): Promise<ClaudeUpdateCanaryOutcome> {
  const deps = canaryDeps(overrides);
  const build = await deps.resolveBuild();
  if (!build) {
    const verdicts: CanaryVariantVerdict[] = [
      { variant: 'default', verdict: 'not-measured', problems: ['no Claude Code build found under ~/.local/share/claude/versions'], servedModel: null, servedWindow: null, seededLimit: null, cliWindows: 'none' },
    ];
    if (lastProbedKey !== 'no-build') {
      lastProbedKey = 'no-build';
      await deps.escalate({ build: null, verdicts, kind: 'not-measured' });
    }
    return { verdict: 'not-measured', version: null, variants: verdicts };
  }
  const savedModel = await deps.readSavedModel();
  const key = `${build.version}|${savedModel ?? ''}`;
  if (key === lastProbedKey) return { verdict: 'skipped', version: build.version };
  lastProbedKey = key;

  const variants: Array<{ variant: CanaryVariant; modelSetting: string | null }> = [{ variant: 'default', modelSetting: null }];
  if (savedModel) variants.push({ variant: 'saved', modelSetting: savedModel });

  const verdicts: CanaryVariantVerdict[] = [];
  for (const v of variants) {
    const probeOwner = `claude-update-canary:${build.version}:${v.variant}`;
    const startedAt = deps.now();
    const cli = await deps.probe({ binary: build.binary, probeOwner, modelSetting: v.modelSetting });
    const route = cli.ok ? await deps.readRoute(probeOwner) : null;
    verdicts.push(evaluateCanaryProbe({ variant: v.variant, modelSetting: v.modelSetting, startedAt, cli, route }));
  }

  const kind = verdicts.some((v) => v.verdict === 'fail')
    ? 'fail'
    : verdicts.some((v) => v.verdict === 'not-measured')
      ? 'not-measured'
      : null;
  if (kind) {
    try {
      await deps.escalate({ build, verdicts, kind });
    } catch (e) {
      lastProbedKey = null; // retry next tick rather than lose the alarm
      throw e;
    }
  } else {
    console.info(`[claude-update-canary] Claude Code ${build.version}: ${describeVerdicts(verdicts).replace(/\n/g, ' ')}`);
  }
  return { verdict: kind ?? 'pass', version: build.version, variants: verdicts };
}

let canaryTimer: ManagedHandle | null = null;

export function startClaudeUpdateCanary(opts: { intervalMs?: number } = {}): void {
  // Each probe is a real model request: run it on exactly one process per host.
  if (!isHostSingleton()) return;
  const intervalMs = opts.intervalMs ?? CLAUDE_UPDATE_CANARY_INTERVAL_MS;
  if (canaryTimer) canaryTimer.stop();
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runClaudeUpdateCanaryOnce()
      .catch((e) => {
        console.warn(`[claude-update-canary] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  // 'must-sample': the updater writes a file and emits no event Papercusp can subscribe to.
  canaryTimer = managedSetInterval('claude-update-canary', intervalMs, tick, { category: 'watchdog', classification: 'must-sample' });
}

export function stopClaudeUpdateCanary(): void {
  if (canaryTimer) canaryTimer.stop();
  canaryTimer = null;
}
