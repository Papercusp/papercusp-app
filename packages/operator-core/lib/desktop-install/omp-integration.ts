/**
 * Phase 2 (opt-in) of desktop-app-install-integration-2026-05-23:
 * wire the operator into the user's local OMP install.
 *
 * Idempotent. Mirrors steps 3 + 3b + 4a + 4c-rm + 4d of
 * install-standalone-mcp.sh:
 *   - merge papercusp-su MCP server into ~/.omp/agent/mcp.json
 *     (preserves any other configured MCP servers)
 *   - enable OMP-native Hindsight memory config when an `omp` binary is
 *     available
 *   - strip the legacy always-on playbook block from
 *     ~/.omp/agent/CLAUDE.md (left there by older versions of the
 *     shell script — keeps plain `omp` from auto-loading the playbook)
 *   - install the `omp-su` wrapper next to the `omp` binary, or
 *     `~/.local/bin/omp-su` with a pathWarning when that's not on PATH
 *   - delete the legacy auto-discovered extension at
 *     ~/.omp/agent/extensions/papercusp-coord.ts so plain `omp` no
 *     longer loads coordination
 *
 * Per D-002a, supports Mac + Linux only in v1. On Windows, returns
 * `{ supported: false }` without touching the filesystem — the
 * platform-aware wrapper-install logic (P-008) is the natural
 * extension point when Windows comes later.
 *
 * NOTE (windows-desktop-feature-parity-2026-07-02 P-025 audit): this module
 * runs inside the operator sidecar, which on a Windows desktop install is
 * always launched via `wsl.exe --exec node ...` — so `process.platform`
 * reports 'linux' there too, and the `supported: false` guard below is DEAD
 * CODE on Windows (it only actually fires for a genuinely non-WSL host).
 * The Linux path runs instead. Static analysis only — not yet VM-verified
 * live; see WI-1646 for the sibling endpoint-ipc finding from the same audit.
 *
 * Reads token + agent_id from ~/.papercusp/ (Phase 1 must have run
 * first). Returns an `installed: false, reason: 'phase1_not_run'` if
 * either is missing — caller surfaces that in the UI.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveInstallPaths } from './papercusp-files';
import { resolveAgentMcpBaseUrl } from '../mcp-base-url';
import { parseDocument } from 'yaml';

const exec = promisify(execFile);

const LEGACY_BLOCK_BEGIN = '<!-- BEGIN papercusp-su playbook (managed by install-standalone-mcp.sh) -->';
const LEGACY_BLOCK_END = '<!-- END papercusp-su playbook -->';

export interface OmpPaths {
  /** ~/.omp/agent/ — the OMP agent config directory. */
  ompAgentDir: string;
  /** ~/.omp/agent/mcp.json — MCP server config. */
  mcpJsonPath: string;
  /** ~/.omp/agent/models.yml — model/provider config (where the papercusp-gateway provider lives). */
  modelsYmlPath: string;
  /** ~/.omp/agent/CLAUDE.md — vanilla context file (where the legacy block lived). */
  legacyContextPath: string;
  /** ~/.omp/agent/extensions/papercusp-coord.ts — legacy auto-discovered extension. */
  legacyExtensionPath: string;
}

export interface OmpDetection {
  ompAgentDirExists: boolean;
  /** Absolute path to the omp binary, or null when not on PATH. */
  ompBinaryPath: string | null;
}

export interface OmpIntegrationState extends OmpPaths, OmpDetection {
  /** True when papercusp-su is configured in mcp.json. */
  mcpServerInstalled: boolean;
  /** True when the omp-su wrapper exists at its installed path. */
  wrapperInstalled: boolean;
  /** Absolute path to the installed omp-su wrapper (computed even when not installed). */
  wrapperPath: string;
  /** True when the legacy CLAUDE.md block is present (needs stripping). */
  legacyBlockPresent: boolean;
  /** Warning when wrapperPath's dir isn't on PATH; null when fine. */
  pathWarning: string | null;
}

export interface InstallOptions {
  /** Override ~/. Tests pass this. Defaults to os.homedir(). */
  home?: string;
  /** Operator URL the MCP entry points at. Defaults to http://localhost:3070. */
  operatorUrl?: string;
  /** Override PATH lookup for omp. Tests pass this to skip exec. */
  ompBinaryPath?: string | null;
  /** Force-skip the wrapper install (Windows path uses this). */
  skipWrapper?: boolean;
}

export interface IntegrationInstallResult extends OmpIntegrationState {
  supported: boolean;
  /** Reason when supported=false or installed=false. */
  reason?: string;
  /** True when the install actually wrote files (vs no-op verification). */
  changed: boolean;
  /** Itemized actions taken — for the settings UI to surface to the user. */
  actions: string[];
}

export function resolveOmpPaths(home: string): OmpPaths {
  const ompAgentDir = path.join(home, '.omp', 'agent');
  return {
    ompAgentDir,
    mcpJsonPath: path.join(ompAgentDir, 'mcp.json'),
    modelsYmlPath: path.join(ompAgentDir, 'models.yml'),
    legacyContextPath: path.join(ompAgentDir, 'CLAUDE.md'),
    legacyExtensionPath: path.join(ompAgentDir, 'extensions', 'papercusp-coord.ts'),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** The dedicated OMP model-provider id that routes real Claude through the local
 *  Papercusp inference gateway. (omp-psu-interactive-parity-hardening-2026-06-29 P-001 +
 *  agent-insights/omp-gateway-routing-via-models-yml.) */
export const OMP_GATEWAY_PROVIDER_ID = 'papercusp-gateway';

function ompGatewayProviderValue(port: number) {
  const model = (id: string, name: string) => ({
    id, name, api: 'anthropic-messages', input: ['text'], contextWindow: 200000, maxTokens: 8192,
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'papercusp-gateway', // inert placeholder; the gateway strips + reinjects the account OAuth
    api: 'anthropic-messages',
    auth: 'apiKey',
    headers: { 'x-papercusp-priority': 'interactive' }, // no account pin → gateway load-balances
    models: [
      model('claude-sonnet-4-6', 'Papercusp Gateway Sonnet 4.6'),
      model('claude-opus-4-8', 'Papercusp Gateway Opus 4.8'),
      model('claude-haiku-4-5', 'Papercusp Gateway Haiku 4.5'),
    ],
  };
}

/**
 * Ensure a `papercusp-gateway` provider exists in ~/.omp/agent/models.yml so a psu→omp
 * interactive session can SELECT real Claude (`papercusp-gateway/claude-sonnet-4-6`) routed
 * through the local inference gateway — the persistent counterpart to the session-scoped
 * connect/fleet routing. ADDITIVE + idempotent: the comment-preserving Document API sets only
 * `providers.papercusp-gateway`, leaving every other provider + the user's default model + all
 * comments untouched. No account pin (priority-only → the gateway load-balances). Returns
 * { wrote, created }. (omp-psu-interactive-parity-hardening-2026-06-29 P-001.)
 */
export async function ensureOmpGatewayProvider(
  modelsYmlPath: string,
  opts: { port?: number } = {},
): Promise<{ wrote: boolean; created: boolean }> {
  const port = opts.port ?? (Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788);
  const desired = ompGatewayProviderValue(port);
  let text = '';
  let created = false;
  try {
    text = await fs.readFile(modelsYmlPath, 'utf8');
  } catch {
    created = true;
  }
  const doc = parseDocument(text);
  const existing = doc.getIn(['providers', OMP_GATEWAY_PROVIDER_ID]);
  const existingJs =
    existing && typeof (existing as { toJSON?: () => unknown }).toJSON === 'function'
      ? (existing as { toJSON: () => unknown }).toJSON()
      : (existing ?? null);
  // Idempotent: skip the write when the provider already matches.
  if (existingJs && JSON.stringify(existingJs) === JSON.stringify(desired)) {
    return { wrote: false, created: false };
  }
  if (doc.getIn(['providers']) == null) doc.setIn(['providers'], {});
  doc.setIn(['providers', OMP_GATEWAY_PROVIDER_ID], desired);
  await fs.mkdir(path.dirname(modelsYmlPath), { recursive: true });
  await fs.writeFile(modelsYmlPath, doc.toString(), { mode: 0o600 });
  return { wrote: true, created };
}

/** Remove the `papercusp-gateway` provider from models.yml (uninstall symmetry). Leaves every
 *  other provider + the user's default untouched. Returns true when a provider was removed. */
export async function removeOmpGatewayProvider(modelsYmlPath: string): Promise<boolean> {
  let text = '';
  try {
    text = await fs.readFile(modelsYmlPath, 'utf8');
  } catch {
    return false;
  }
  const doc = parseDocument(text);
  if (doc.getIn(['providers', OMP_GATEWAY_PROVIDER_ID]) == null) return false;
  doc.deleteIn(['providers', OMP_GATEWAY_PROVIDER_ID]);
  await fs.writeFile(modelsYmlPath, doc.toString(), { mode: 0o600 });
  return true;
}

/**
 * A hosted operator PATH can expose `omp` as a wrapper around the Papercusp
 * launcher (`psu.mjs --agent=omp`). Running `config get/set` through that
 * wrapper starts a psu session instead of invoking the OMP CLI. Reject direct
 * launcher targets and small executable wrappers that forward to that argv.
 */
async function isPsuOmpLauncherShim(binaryPath: string): Promise<boolean> {
  let resolvedPath = binaryPath;
  try {
    resolvedPath = await fs.realpath(binaryPath);
  } catch {
    /* retain the PATH result and inspect it below */
  }

  if (/(?:^|[\\/])scripts[\\/](?:psu|psu-launcher)\.mjs$/i.test(resolvedPath)) return true;

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(resolvedPath, 'r');
    const prefix = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const source = prefix.subarray(0, bytesRead).toString('utf8');
    return source.startsWith('#!') && /psu(?:-launcher)?\.mjs[^\r\n]*--agent(?:=|\s+)omp/i.test(source);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function detectOmpBinary(): Promise<string | null> {
  // `command -v` is POSIX; works on bash/zsh/dash. Skipped on Windows
  // anyway via the supported check before this is called.
  try {
    const { stdout } = await exec('sh', ['-c', 'command -v omp'], { timeout: 3000 });
    const found = stdout.trim();
    if (!found || await isPsuOmpLauncherShim(found)) return null;
    return found;
  } catch {
    return null;
  }
}

const OMP_HINDSIGHT_DESIRED_CONFIG = [
  ['memory.backend', 'hindsight'],
  ['hindsight.apiUrl', process.env.PAPERCUSP_HINDSIGHT_API_URL ?? process.env.HINDSIGHT_API_URL ?? 'http://localhost:8888'],
  ['hindsight.scoping', 'per-project-tagged'],
  ['hindsight.autoRecall', 'true'],
  ['hindsight.autoRetain', 'true'],
] as const;

function ompExecEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home };
}

async function readOmpConfigValue(
  ompBinaryPath: string,
  home: string,
  key: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec(ompBinaryPath, ['config', 'get', key], {
      timeout: 3000,
      env: ompExecEnv(home),
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function ensureOmpHindsightConfig(
  ompBinaryPath: string | null,
  home: string,
): Promise<string[]> {
  if (!ompBinaryPath) return [];
  const updated: string[] = [];
  for (const [key, value] of OMP_HINDSIGHT_DESIRED_CONFIG) {
    const current = await readOmpConfigValue(ompBinaryPath, home, key);
    if (current === value) continue;
    try {
      await exec(ompBinaryPath, ['config', 'set', key, value], {
        timeout: 3000,
        env: ompExecEnv(home),
      });
      updated.push(key);
    } catch {
      return updated;
    }
  }
  return updated;
}

export async function detectOmp(home: string): Promise<OmpDetection> {
  const ompAgentDir = path.join(home, '.omp', 'agent');
  const ompAgentDirExists = await pathExists(ompAgentDir);
  const ompBinaryPath = await detectOmpBinary();
  return { ompAgentDirExists, ompBinaryPath };
}

interface McpServerEntry {
  type: string;
  url: string;
  headers: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

async function readJsonOrEmpty(p: string): Promise<McpConfig> {
  try {
    const buf = await fs.readFile(p, 'utf8');
    return JSON.parse(buf) as McpConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (e instanceof SyntaxError) {
      // Back up the invalid file (per install-standalone-mcp.sh §3) so
      // the user isn't silently overwritten.
      const ts = Math.floor(Date.now() / 1000);
      await fs.rename(p, `${p}.bak.${ts}`);
      return {};
    }
    throw e;
  }
}

function buildMcpEntry(operatorUrl: string, token: string, agentId: string): McpServerEntry {
  return {
    type: 'http',
    url: `${operatorUrl}/api/mcp?superuser=1&client=${agentId}`,
    headers: {
      Authorization: `Bearer ${token}`,
      // Per-session identity/scope carriers (three-client-lock-enforcement +
      // orient-recall-quality follow-up, WI-4393). OMP can't env-interpolate its
      // mcp.json URL (unlike claude/codex), so `&client=` above stays the static
      // per-machine agentId — but OMP DOES resolve header values at connect time
      // via a leading "!" (config/resolve-config-value.ts), running the rest in a
      // subshell that inherits the OMP process env. `psu` exports a per-launch
      // PAPERCUSP_SID/-WORKSPACE/-PROFILE/-HARNESS_SLUG, so these resolve to the
      // CURRENT session's values — empty stdout (no psu launch, or no harness) =>
      // header dropped => the operator's existing fallbacks apply ('*'/unscoped).
      // The operator reads each header FIRST, before its URL-param counterpart
      // (tryBuildSpawnContext in _mcp-handler.ts) — this is OMP's analogue of
      // Claude's `${PAPERCUSP_SID}` URL interpolation (buildClaudeMcpEntry).
      // harness specifically feeds the MCP `initialize`-time memory prelude
      // (buildMcpPrelude derives its recall query from the resolved harness) —
      // without it, every OMP session was a "bare session" to the prelude
      // builder (zero session-start memory recall).
      'x-papercusp-client': '!printf %s "${PAPERCUSP_SID:-}"',
      'x-papercusp-workspace': '!printf %s "${PAPERCUSP_WORKSPACE:-}"',
      'x-papercusp-profile': '!printf %s "${PAPERCUSP_PROFILE:-}"',
      'x-papercusp-harness': '!printf %s "${PAPERCUSP_HARNESS_SLUG:-}"',
    },
  };
}

function mcpEntryEquals(a: McpServerEntry | undefined, b: McpServerEntry): boolean {
  if (!a) return false;
  if (a.type !== b.type || a.url !== b.url) return false;
  // Full headers comparison (WI-4393) — comparing Authorization alone made this
  // reconciler idempotent-BROKEN for any other header: a machine bootstrapped
  // before a header was added/changed here would compare "equal" forever and
  // never receive the update, since re-installs are gated on this check. Order-
  // independent key/value comparison so JSON key ordering never spuriously
  // reports a diff.
  const aHeaders = a.headers ?? {};
  const bHeaders = b.headers ?? {};
  const aKeys = Object.keys(aHeaders);
  const bKeys = Object.keys(bHeaders);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => aHeaders[k] === bHeaders[k]);
}

async function mergeMcpServer(
  mcpJsonPath: string,
  operatorUrl: string,
  token: string,
  agentId: string,
): Promise<{ wrote: boolean; created: boolean }> {
  const existed = await pathExists(mcpJsonPath);
  await fs.mkdir(path.dirname(mcpJsonPath), { recursive: true });

  const cfg = existed ? await readJsonOrEmpty(mcpJsonPath) : {};
  cfg.mcpServers = cfg.mcpServers ?? {};

  const newEntry = buildMcpEntry(operatorUrl, token, agentId);
  if (mcpEntryEquals(cfg.mcpServers['papercusp-su'], newEntry)) {
    return { wrote: false, created: false };
  }
  cfg.mcpServers['papercusp-su'] = newEntry;
  await fs.writeFile(mcpJsonPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fs.chmod(mcpJsonPath, 0o600);
  return { wrote: true, created: !existed };
}

async function stripLegacyBlock(filePath: string): Promise<boolean> {
  if (!(await pathExists(filePath))) return false;
  const text = await fs.readFile(filePath, 'utf8');
  const startIdx = text.indexOf(LEGACY_BLOCK_BEGIN);
  const endIdx = text.indexOf(LEGACY_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return false;
  // Include the trailing newline after the END marker if present.
  const endAfter = endIdx + LEGACY_BLOCK_END.length;
  const sliceEnd = text[endAfter] === '\n' ? endAfter + 1 : endAfter;
  const stripped = (text.slice(0, startIdx) + text.slice(sliceEnd)).replace(/^\n+/, '');
  await fs.writeFile(filePath, stripped);
  return true;
}

function resolveWrapperPath(home: string, ompBinaryPath: string | null): string {
  // Co-locate with omp if we found it; otherwise ~/.local/bin/.
  if (ompBinaryPath) return path.join(path.dirname(ompBinaryPath), 'omp-su');
  return path.join(home, '.local', 'bin', 'omp-su');
}

// (wrapperContent/installWrapper removed — omp-su wrapper retired, P-050.)

function checkPathContains(dir: string, envPath: string | undefined): boolean {
  if (!envPath) return false;
  const parts = envPath.split(path.delimiter);
  return parts.some((p) => path.resolve(p) === path.resolve(dir));
}

export async function readOmpIntegrationState(opts: InstallOptions = {}): Promise<OmpIntegrationState> {
  const home = opts.home ?? os.homedir();
  const ompPaths = resolveOmpPaths(home);
  const detection: OmpDetection =
    opts.ompBinaryPath !== undefined
      ? { ompAgentDirExists: await pathExists(ompPaths.ompAgentDir), ompBinaryPath: opts.ompBinaryPath }
      : await detectOmp(home);

  const wrapperPath = resolveWrapperPath(home, detection.ompBinaryPath);

  let mcpServerInstalled = false;
  if (await pathExists(ompPaths.mcpJsonPath)) {
    const cfg = await readJsonOrEmpty(ompPaths.mcpJsonPath);
    mcpServerInstalled = !!cfg.mcpServers?.['papercusp-su'];
  }

  const wrapperInstalled = await pathExists(wrapperPath);

  let legacyBlockPresent = false;
  if (await pathExists(ompPaths.legacyContextPath)) {
    const text = await fs.readFile(ompPaths.legacyContextPath, 'utf8');
    legacyBlockPresent =
      text.includes(LEGACY_BLOCK_BEGIN) && text.includes(LEGACY_BLOCK_END);
  }

  const wrapperDir = path.dirname(wrapperPath);
  const pathWarning = checkPathContains(wrapperDir, process.env.PATH)
    ? null
    : `${wrapperDir} is not on PATH — add it or invoke ${wrapperPath} by full path`;

  return {
    ...ompPaths,
    ...detection,
    mcpServerInstalled,
    wrapperInstalled,
    wrapperPath,
    legacyBlockPresent,
    pathWarning,
  };
}

export async function installOmpIntegration(opts: InstallOptions = {}): Promise<IntegrationInstallResult> {
  // D-002a — Windows is deferred. Surface clearly; settings UI can
  // display a "Not supported on this platform" line.
  if (process.platform === 'win32') {
    const home = opts.home ?? os.homedir();
    const state = await readOmpIntegrationState(opts);
    return {
      ...state,
      supported: false,
      reason: 'windows_not_supported_in_v1',
      changed: false,
      actions: [],
    };
  }

  const home = opts.home ?? os.homedir();
  const ompPaths = resolveOmpPaths(home);
  const detection: OmpDetection =
    opts.ompBinaryPath !== undefined
      ? { ompAgentDirExists: await pathExists(ompPaths.ompAgentDir), ompBinaryPath: opts.ompBinaryPath }
      : await detectOmp(home);

  // Phase 1 must have run first — token + agent_id needed for the
  // mcp.json merge.
  const phase1 = resolveInstallPaths(home);
  const tokenStr = await tryReadTrim(phase1.tokenPath);
  const agentIdStr = await tryReadTrim(phase1.agentIdPath);
  if (!tokenStr || !agentIdStr) {
    return {
      ...(await readOmpIntegrationState(opts)),
      supported: true,
      reason: 'phase1_not_run',
      changed: false,
      actions: [],
    };
  }

  // WI-1457 / P-007: the resilient MCP proxy (:9071) is the DEFAULT — never a
  // bare direct :3070. OMP reads this url LITERALLY (no env interpolation), so
  // this reconciler — fired per console launch via ensureOmpSuInstalled — is the
  // ONLY thing that decides whether OMP sessions ride the proxy; its old
  // direct-:3070 default re-minted away every manual re-point within minutes
  // (the same class P-007 fixed in the Claude generator). An explicit
  // PAPERCUSP_MCP_PROXY_BASE (WI-573) still overrides via resolveAgentMcpBaseUrl.
  const operatorUrl = opts.operatorUrl ?? resolveAgentMcpBaseUrl('http://127.0.0.1:9071');
  const actions: string[] = [];

  // 1. mcp.json merge — idempotent (compares to existing entry).
  const merge = await mergeMcpServer(ompPaths.mcpJsonPath, operatorUrl, tokenStr, agentIdStr);
  if (merge.wrote) {
    actions.push(merge.created ? `created ${ompPaths.mcpJsonPath}` : `updated mcpServers.papercusp-su`);
  }

  // 1b. Ensure the papercusp-gateway model provider so a psu→omp interactive session can
  //     SELECT real Claude (papercusp-gateway/claude-sonnet-4-6) routed through the local
  //     inference gateway. Additive + idempotent; preserves the user's other providers,
  //     default model, and comments. (omp-psu-interactive-parity-hardening-2026-06-29 P-001.)
  try {
    const gw = await ensureOmpGatewayProvider(ompPaths.modelsYmlPath);
    if (gw.wrote) {
      actions.push(gw.created ? `created ${ompPaths.modelsYmlPath} (papercusp-gateway provider)` : 'added providers.papercusp-gateway to models.yml');
    }
  } catch (e) {
    // Never fail the whole integration on a models.yml hiccup — the MCP merge is the critical leg.
    actions.push(`WARN: could not ensure papercusp-gateway provider: ${(e as Error)?.message ?? String(e)}`);
  }

  // 2. strip the legacy CLAUDE.md block (no-op when already stripped or file missing).
  if (await stripLegacyBlock(ompPaths.legacyContextPath)) {
    actions.push(`stripped legacy playbook block from ${ompPaths.legacyContextPath}`);
  }

  // 3. remove the legacy auto-discovered extension copy.
  if (await pathExists(ompPaths.legacyExtensionPath)) {
    await fs.rm(ompPaths.legacyExtensionPath, { force: true });
    actions.push(`removed legacy extension at ${ompPaths.legacyExtensionPath}`);
  }

  const hindsightUpdated = await ensureOmpHindsightConfig(detection.ompBinaryPath, home);
  if (hindsightUpdated.length > 0) {
    actions.push(`configured OMP Hindsight (${hindsightUpdated.join(', ')})`);
  }

  // 4. The omp-su wrapper is RETIRED (psu-only-launch P-050) — psu launches
  //    raw omp per-launch (playbook + `-e` coord via suLaunchArgs /
  //    resumeArgsFor), so this install no longer writes a wrapper.
  //    uninstallOmpIntegration still removes a stale one. The MCP merge
  //    (step 1) is what psu's raw omp depends on and stays.

  // Re-read final state.
  const finalState = await readOmpIntegrationState(opts);

  return {
    ...finalState,
    supported: true,
    changed: actions.length > 0,
    actions,
  };
}

export async function uninstallOmpIntegration(opts: InstallOptions = {}): Promise<IntegrationInstallResult> {
  // Always reports `supported: true` on POSIX even when nothing was to
  // uninstall; settings UI uses `actions` to know what happened.
  if (process.platform === 'win32') {
    return {
      ...(await readOmpIntegrationState(opts)),
      supported: false,
      reason: 'windows_not_supported_in_v1',
      changed: false,
      actions: [],
    };
  }
  const home = opts.home ?? os.homedir();
  const ompPaths = resolveOmpPaths(home);
  const detection: OmpDetection =
    opts.ompBinaryPath !== undefined
      ? { ompAgentDirExists: await pathExists(ompPaths.ompAgentDir), ompBinaryPath: opts.ompBinaryPath }
      : await detectOmp(home);

  const actions: string[] = [];

  // 1. remove the papercusp-su MCP entry, preserve other servers.
  if (await pathExists(ompPaths.mcpJsonPath)) {
    const cfg = await readJsonOrEmpty(ompPaths.mcpJsonPath);
    if (cfg.mcpServers?.['papercusp-su']) {
      delete cfg.mcpServers['papercusp-su'];
      await fs.writeFile(ompPaths.mcpJsonPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      actions.push(`removed mcpServers.papercusp-su from ${ompPaths.mcpJsonPath}`);
    }
  }

  // 1b. remove the papercusp-gateway model provider (install step 1b symmetry).
  if (await removeOmpGatewayProvider(ompPaths.modelsYmlPath)) {
    actions.push(`removed providers.papercusp-gateway from ${ompPaths.modelsYmlPath}`);
  }

  // 2. remove wrapper.
  const wrapperPath = resolveWrapperPath(home, detection.ompBinaryPath);
  if (await pathExists(wrapperPath)) {
    await fs.rm(wrapperPath, { force: true });
    actions.push(`removed wrapper at ${wrapperPath}`);
  }

  const finalState = await readOmpIntegrationState(opts);

  return {
    ...finalState,
    supported: true,
    changed: actions.length > 0,
    actions,
  };
}

async function tryReadTrim(p: string): Promise<string | null> {
  try {
    const s = await fs.readFile(p, 'utf8');
    const t = s.trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}
