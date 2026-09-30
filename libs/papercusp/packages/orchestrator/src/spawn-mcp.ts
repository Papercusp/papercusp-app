/**
 * Per-spawn MCP config: write a `.mcp.json` so OMP discovers the
 * Papercusp MCP host with the seven per-spawn URL params baked in.
 *
 * OMP's MCP discovery is path-based (no env-var override exists for an
 * explicit MCP config path), so this module does the dance:
 *
 *   1. Save any existing `<cwd>/.mcp.json` to a sibling backup.
 *   2. Write our spawn-specific `.mcp.json`.
 *   3. After the spawn exits, delete ours and restore the backup.
 *
 * Workers running in parallel must use distinct cwds (worktrees) — two
 * spawns sharing a cwd would race-clobber each other's `.mcp.json`. The
 * orchestrator's existing branch-isolation worktree pattern provides
 * that automatically.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (D4: tool discovery
 * for OMP — single mcpServers entry, seven URL query params).
 */

import { canonicalizeSpawnParams, hmacSpawnBytes, decodeOperatorSecretKey } from './spawn-signing-core';
// The gateway config builder + tomlEscape live in the SHARED module (WI-3645): operator-core's
// role-codex-home.ts (the interactive psu path) renders the SAME blocks via the package's
// `./codex-gateway-config` subpath export — one builder, one behavior, no drift. Model-specific
// TOML stays there; this file keeps only the spawn-specific composition (MCP url + CODEX_HOME).
import {
  codexGatewayConfigToml,
  codexManagedFeaturesToml,
  tomlEscape,
  type CodexGatewayConfigOpts,
} from './codex-gateway-config';
import { codexModelConfigToml } from '../../../../../packages/operator-core/lib/model-context-budget.mjs';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import postgres from 'postgres';

/** Construction inputs — all seven per-spawn URL params plus the host URL. */
export interface SpawnMcpConfigInput {
  /**
   * Explicit per-spawn override of the operator MCP base URL. When set it
   * wins over every env-derived default (see {@link resolveSpawnOperatorBase}).
   * Leave unset to target the SPAWNING host automatically — a spawned agent
   * should always handshake the operator that spawned it, never a fixed host.
   */
  operatorUrl?: string;
  /** Harness slug. Required. */
  harnessSlug: string;
  /** Workspace ID. Required. */
  workspaceId: string;
  /** Calling agent role. Required. */
  role: string;
  /** Orchestrator run ID. Required. */
  runId: string;
  /** Unique per-spawn ID. Required. */
  spawnId: string;
  /** Feature ID, if the spawn is feature-scoped (workers, validators, debuggers). */
  featureId?: string | null;
  /** Chunk ID, if the spawn is chunk-scoped (worker chunks). */
  chunkId?: string | null;
  /** Parent spawn ID, set when this spawn was created by another agent's `orchestrator.spawn` call. */
  parentSpawnId?: string | null;
  /**
   * Optional MCP catalog listing hint. When set, the operator MCP endpoint's
   * `tools/list` advertises only these colon-form tool names via `?tools=`.
   * Dispatch is unchanged; this only keeps clients from inlining an oversized
   * schema catalog for roles with a small known working set.
   */
  mcpToolNames?: readonly string[] | null;
  /**
   * Stable coordination owner id for the spawn (THE UMBILICAL voice-gap fix).
   * Baked as the signed URL's `client=` param so the operator's
   * resolveAgentIdentity() attributes the child's coord:* / plans:* / improvements:*
   * writes to a STABLE id (the operator's durable `s-…` spawnId) instead of throwing
   * "no attributable identity". Distinct from `spawnId` (which the legacy path
   * regenerated per boot); when set this is the operator-assigned spawned_agents
   * owner, so a bee's messages, file locks, and fleet:cancel target all line up.
   * Optional — pipeline roles (worker/scoper/…) that never coord can omit it.
   */
  clientId?: string | null;
  /** Private stable session key used only to isolate process-local detectors. */
  detectorSessionKey?: string | null;
}

/**
 * Existing Postgres handle the orchestrator may reuse while minting a signed
 * spawn URL. Kept structural so operator-core can pass its already-open
 * postgres-js client without introducing an orchestrator -> operator import.
 */
export interface SpawnMcpSigningPg {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  <T = any[]>(template: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

// Default port flips on NODE_ENV: dev operator runs on :3055, prod on :3070.
// Override with PAPERCUSP_OPERATOR_URL when neither default applies (CI,
// Tauri sidecar with custom port, etc).
const DEFAULT_OPERATOR_URL =
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:3055/api/mcp'
    : 'http://localhost:3070/api/mcp';

/**
 * PAPERCUSP_OPERATOR_URL is historically overloaded: some launchers export a
 * bare operator/proxy origin while others export the complete MCP endpoint.
 * A spawn config needs the endpoint form. Preserve explicit nonstandard paths,
 * normalize the retired `/api/sse` spelling, and append `/api/mcp` to origins.
 */
function inheritedOperatorMcpEndpoint(raw: string): string {
  const normalized = raw.trim().replace(/\/+$/, '');
  if (/\/api\/mcp$/i.test(normalized)) return normalized;
  if (/\/api\/sse$/i.test(normalized)) return normalized.replace(/\/api\/sse$/i, '/api/mcp');
  try {
    const parsed = new URL(normalized);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      parsed.pathname = '/api/mcp';
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    // Preserve the prior behavior for an invalid/custom value; the MCP client
    // will surface the malformed URL rather than this helper guessing at it.
  }
  return normalized;
}

/**
 * Resolve the operator MCP base URL a spawned agent connects to, in priority
 * order:
 *
 *   1. `operatorUrl` — an explicit per-spawn pin from the caller. Always wins.
 *   2. `PAPERCUSP_HONO_PORT` — the SPAWNING host's own serving port, set at
 *      boot. A spawned agent must handshake the operator that spawned it
 *      (its code version + role catalog), so the host's own port takes
 *      precedence over an inherited env default AND over a proxy for another
 *      host. When the configured proxy fronts this exact port, the proxy is
 *      still used for restart resilience. (EI-51 / WI-212675.)
 *   3. `PAPERCUSP_MCP_PROXY_BASE` — used when the spawning host is the proxy's
 *      target (default `:3070`) or when this process has no serving-port identity.
 *   4. `PAPERCUSP_OPERATOR_URL` — an env override used only when the host
 *      port is unknown. `apps/operator/.env.local` pins this to green :3070,
 *      which is why it must NOT win over the host's own port: a non-green host
 *      (staging :3170, a per-harness embedded host) inherits that value and
 *      would otherwise point every child it spawns back at green.
 *   5. The hardcoded dev/prod default.
 *
 * This mirrors the design the orchestrator-runner already applies at the
 * child-env layer (EI-286 leg b: "when this host knows its serving port it
 * OVERRIDES the inherited value so children always talk to their spawner");
 * making it authoritative here covers every caller, not just that one path.
 * `/api/mcp` is the streamable-HTTP MCP route (`type: 'http'`), matching
 * `.env.local` and the host's own serving path.
 */
export function resolveSpawnOperatorBase(operatorUrl?: string | null): string {
  if (operatorUrl) return operatorUrl;
  const proxyBase = process.env.PAPERCUSP_MCP_PROXY_BASE?.trim();
  const proxyEndpoint = proxyBase ? `${proxyBase.replace(/\/+$/, '')}/api/mcp` : null;
  const selfPort = process.env.PAPERCUSP_HONO_PORT?.trim();
  if (selfPort) {
    // WI-212675: the proxy on the dev box fronts GREEN :3070. Background :3271
    // and staging :3170 inherit its env setting too, but they serve CURRENT
    // staging code and launch roles whose very purpose may be repairing a gate
    // that prevents :3070 from updating. Sending those children through :9071
    // silently hands them the old role/capability catalog and creates a bootstrap
    // deadlock: the fixer needed to deploy the permission fix cannot use it.
    //
    // Use the proxy only when it fronts THIS host. The target is explicit when a
    // nonstandard proxy is configured; otherwise :3070 is the platform default.
    // This preserves deploy-restart resilience for green while keeping every
    // non-green host's child on the same code/control plane as its spawner.
    const proxyTargetPort = (process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT ?? '3070').trim();
    if (proxyEndpoint && selfPort === proxyTargetPort) return proxyEndpoint;
    return `http://127.0.0.1:${selfPort}/api/mcp`;
  }
  // A bare client/process has no self-host identity. In that case the configured
  // proxy remains the resilient default, exactly as before.
  if (proxyEndpoint) return proxyEndpoint;
  const inherited = process.env.PAPERCUSP_OPERATOR_URL?.trim();
  return inherited ? inheritedOperatorMcpEndpoint(inherited) : DEFAULT_OPERATOR_URL;
}

export interface SpawnMcpRouteRecovery {
  configuredBase: string;
  recoveredBase: string;
  configuredPort: string | null;
}

export type SpawnMcpRouteProbe = (operatorMcpBase: string, timeoutMs: number) => Promise<boolean>;
export type SpawnMcpRouteRecoveryHandler = (recovery: SpawnMcpRouteRecovery) => void;

export interface SpawnMcpRouteProbeOptions {
  /** Injectable for deterministic tests and alternate local transports. */
  probe?: SpawnMcpRouteProbe;
  /** Called when a stale local route recovers through another local endpoint. */
  onRecovery?: SpawnMcpRouteRecoveryHandler;
  /** Bound the default HTTP probe; injected probes may ignore it. */
  probeTimeoutMs?: number;
}

const DEFAULT_MCP_ROUTE_PROBE_TIMEOUT_MS = 1_500;

/**
 * Probe the MCP HTTP route without requiring authentication or a valid MCP
 * request. Any HTTP response (including 404/405) proves that a listener is
 * serving the endpoint; only connection/timeout failures count as unavailable.
 */
export async function probeSpawnOperatorMcp(
  operatorMcpBase: string,
  timeoutMs = DEFAULT_MCP_ROUTE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(operatorMcpBase, {
      method: 'GET',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function localMcpBase(port: string): string {
  return `http://127.0.0.1:${port}/api/mcp`;
}

function isLoopbackMcpBase(operatorMcpBase: string): boolean {
  try {
    const hostname = new URL(operatorMcpBase).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Async counterpart to {@link resolveSpawnOperatorBase}. The synchronous
 * builder stays pure/deterministic because callers use it in config-shape
 * tests and in paths that cannot await. Native spawn writers can await this
 * seam to recover when a copied PAPERCUSP_HONO_PORT outlives its operator.
 */
export async function resolveSpawnOperatorBaseAsync(
  operatorUrl?: string | null,
  options: SpawnMcpRouteProbeOptions = {},
): Promise<string> {
  // A caller-supplied pin is authoritative; never silently route it elsewhere.
  if (operatorUrl) return operatorUrl;

  const configuredPort = process.env.PAPERCUSP_HONO_PORT?.trim() || null;
  const hasRuntimeHint = Boolean(configuredPort);
  const configuredBase = resolveSpawnOperatorBase();
  // With no runtime hint, preserve the cheap deterministic default and avoid a
  // network request for every ordinary spawn.
  if (!hasRuntimeHint || !isLoopbackMcpBase(configuredBase)) return configuredBase;

  const probe = options.probe ?? probeSpawnOperatorMcp;
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_MCP_ROUTE_PROBE_TIMEOUT_MS;
  if (await probe(configuredBase, timeoutMs)) return configuredBase;

  const candidates = [
    ...(configuredPort ? [localMcpBase(configuredPort)] : []),
    localMcpBase('3070'),
  ].filter((candidate, index, all) => candidate !== configuredBase && all.indexOf(candidate) === index);

  for (const recoveredBase of candidates) {
    if (!(await probe(recoveredBase, timeoutMs))) continue;
    const recovery = { configuredBase, recoveredBase, configuredPort };
    if (options.onRecovery) {
      options.onRecovery(recovery);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[spawn-mcp] local MCP route ${configuredBase} was unavailable; ` +
          `recovered on ${recoveredBase}` +
          (configuredPort ? ` (PAPERCUSP_HONO_PORT=${configuredPort} is stale)` : ''),
      );
    }
    return recoveredBase;
  }

  // Preserve the original URL when no recovery route is reachable. The child
  // then receives the same actionable endpoint instead of a surprising third
  // destination, and the caller's normal MCP error remains authoritative.
  return configuredBase;
}

/** Build the JSON-serializable mcp.json contents for a spawn. */
export function buildSpawnMcpConfig(input: SpawnMcpConfigInput): {
  mcpServers: Record<string, { type: 'http'; url: string }>;
} {
  const base = resolveSpawnOperatorBase(input.operatorUrl);
  const params = new URLSearchParams();
  params.set('harness', input.harnessSlug);
  params.set('workspace', input.workspaceId);
  params.set('role', input.role);
  params.set('run', input.runId);
  params.set('spawn', input.spawnId);
  if (input.featureId) params.set('feature', input.featureId);
  if (input.chunkId) params.set('chunk', input.chunkId);
  if (input.parentSpawnId) params.set('parent_spawn', input.parentSpawnId);
  if (input.mcpToolNames?.length) params.set('tools', input.mcpToolNames.join(','));
  // Stable coord owner id (operator's `s-…` spawnId). See buildSpawnUrlParams.
  if (input.clientId) params.set('client', input.clientId);
  if (input.detectorSessionKey) params.set('detector', input.detectorSessionKey);
  return {
    mcpServers: {
      papercusp: {
        // `type: 'http'` is required by claude-code's --mcp-config schema.
        // omp accepts it too — the operator brain's converse path already
        // ships an explicit `type:'http'` server through omp — so emitting
        // it unconditionally keeps ONE config shape that both backends load.
        type: 'http',
        url: `${base}?${params.toString()}`,
      },
    },
  };
}

const FILENAME = '.mcp.json';
const BACKUP_SUFFIX = '.papercusp.bak';

/**
 * Write a per-spawn `.mcp.json` to `cwd`, saving any existing file's
 * content. Returns a token the caller passes to `restoreSpawnMcp`.
 *
 * Writes are best-effort: if anything fails (permission, disk full),
 * we throw rather than silently spawn without our config — the agent
 * would then have built-in tools but no plugin tools, which is a
 * confusing partial state.
 */
export interface SpawnMcpHandle {
  /** Path of the written file. */
  path: string;
  /** Content of the file we displaced (null if there wasn't one). */
  prior: string | null;
  /** Path of our backup of the prior file (null if no prior). */
  backupPath: string | null;
}

/**
 * WHERE a spawn's `.mcp.json` is baked — and, inseparably, whether the
 * close-time restore must run.
 *
 * These were once TWO variables (`mcpConfigDir`, and a skip condition keyed off
 * `trackedSessionSpawnId`) that had to agree, and they drifted: the tracked id
 * is backend-independent, while the redirect to a persistent dir fires only for
 * claude-code WITH a workspaceId. A tracked omp spawn — or a tracked claude
 * spawn with no workspaceId — therefore wrote the SHARED `<cwd>/.mcp.json` and
 * then skipped its restore, permanently stranding a signed role-bearing config
 * in the shared repo root AND leaving the `.mcp.json` it displaced parked at its
 * backup suffix, never renamed back (EI-23336628915114721).
 *
 * Returning both as ONE value makes `kind:'cwd'` with `persistsOutsideCwd:true`
 * unrepresentable rather than merely untrue, so the pair cannot drift again.
 * Pure by design — the caller performs the mkdir/mkdtemp.
 */
export type McpConfigPlacement =
  | { kind: 'session-dir'; spawnId: string; persistsOutsideCwd: true }
  | { kind: 'temp-dir'; persistsOutsideCwd: false }
  | { kind: 'cwd'; persistsOutsideCwd: false };

export function resolveMcpConfigPlacement(opts: {
  agentBackend: string;
  workspaceId?: string | null;
  /** Non-empty only for a tracked (resumable) launch. */
  trackedSessionSpawnId?: string | null;
}): McpConfigPlacement {
  // The redirect is claude-code-only: omp path-discovers `<cwd>/.mcp.json` with
  // no explicit-path override, and codex uses a per-spawn CODEX_HOME.
  if (opts.agentBackend !== 'claude-code' || !opts.workspaceId) {
    return { kind: 'cwd', persistsOutsideCwd: false };
  }
  const spawnId = (opts.trackedSessionSpawnId ?? '').trim();
  // A tracked launch resumes via `claude --resume --mcp-config <path>`, which a
  // deleted temp dir would break — so that one config persists and is NOT restored.
  if (spawnId) return { kind: 'session-dir', spawnId, persistsOutsideCwd: true };
  return { kind: 'temp-dir', persistsOutsideCwd: false };
}

export function writeSpawnMcp(cwd: string, input: SpawnMcpConfigInput): SpawnMcpHandle {
  const path = join(cwd, FILENAME);
  let prior: string | null = null;
  let backupPath: string | null = null;
  if (existsSync(path)) {
    prior = readFileSync(path, 'utf8');
    backupPath = `${path}${BACKUP_SUFFIX}`;
    renameSync(path, backupPath);
  }
  const config = buildSpawnMcpConfig(input);
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  // Mode 0600: stop a sibling worker on the same UID from `cat`-ing
  // this .mcp.json to steal the (signed, role-bearing) URL. Same-UID
  // root-equivalent code can still read it; this is friction, not
  // enforcement. See apps/operator/docs/spawn-signing-threat-model.md.
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return { path, prior, backupPath };
}

/**
 * Async variant — same as writeSpawnMcp but also signs the URL params
 * with the HMAC key stored at `harness_shared.operator_secrets`
 * (`spawn-signing-key`). Required by the operator's MCP route when
 * `PAPERCUSP_REQUIRE_SPAWN_SIG=1`; otherwise soft-warn but accept.
 *
 * Best-effort: if PG is unreachable or the key row is missing, falls
 * back to the unsigned URL and logs a warning. The operator side will
 * also warn — pair the two signals to spot transition issues.
 *
 * The operator subprocess that hosts the orchestrator inherits its
 * PG DSN via env (DATABASE_URL or PAPERCUSP_PG_DSN). If neither is
 * set we can't sign — that's the only case where we fall back.
 *
 * See: apps/operator/lib/spawn-signing.ts for the verification side.
 */
export async function writeSignedSpawnMcp(
  cwd: string,
  input: SpawnMcpConfigInput,
  opts: {
    ttlSec?: number;
    /** Reuse the caller's already-open PG handle instead of requiring a DSN env. */
    pg?: SpawnMcpSigningPg;
    /**
     * If true, emit an unsigned URL with a console warning instead of
     * throwing when signing fails. Only safe when the operator is
     * running with PAPERCUSP_REQUIRE_SPAWN_SIG != '1' (soft-warn).
    * Default: false (strict — signing failure = spawn failure).
     */
    allowUnsigned?: boolean;
  } & SpawnMcpRouteProbeOptions = {},
): Promise<SpawnMcpHandle> {
  const path = join(cwd, FILENAME);
  let prior: string | null = null;
  let backupPath: string | null = null;
  if (existsSync(path)) {
    prior = readFileSync(path, 'utf8');
    backupPath = `${path}${BACKUP_SUFFIX}`;
    renameSync(path, backupPath);
  }
  const base = await resolveSpawnOperatorBaseAsync(input.operatorUrl, opts);

  // ── Superuser-spawn mode ──────────────────────────────────────────────
  // An operator-initiated, loopback spawn (the /harness/:slug/invoke route)
  // sets PAPERCUSP_SPAWN_SU_BEARER. Connect via the `?superuser=1` door
  // (branch 1 in _mcp-handler.ts) instead of a signed spawn, so the spawned
  // coord-role agent carries the `isSuperuser` identity that
  // resolveAgentIdentity-gated tools (plans:promote, coord:*) require — a
  // plain signed spawn's ctx has none. Auth here is loopback + the bearer
  // (no URL `sig` needed; the superuser branch is checked before the sig one).
  const suBearer = process.env.PAPERCUSP_SPAWN_SU_BEARER;
  if (suBearer && suBearer.length > 0) {
    const su = new URLSearchParams();
    su.set('superuser', '1');
    su.set('harness', input.harnessSlug);
    su.set('workspace', input.workspaceId);
    su.set('client', input.spawnId); // per-spawn coord/lock owner label
    if (input.mcpToolNames?.length) su.set('tools', input.mcpToolNames.join(','));
    // token-usage-reduction P-011: narrow tools/list to the spawned role's
    // catalog (the SU door otherwise advertises the full operator-tier
    // surface to every fleet spawn). Dispatch capability is unchanged —
    // isSuperuser still bypasses role gates; only the advertised list narrows.
    if (input.role) su.set('role', input.role);
    const config = {
      mcpServers: {
        papercusp: {
          type: 'http' as const,
          url: `${base}?${su.toString()}`,
          headers: { Authorization: `Bearer ${suBearer}` },
        },
      },
    };
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    return { path, prior, backupPath };
  }

  const params = buildSpawnUrlParams(input);
  try {
    await signSpawnParams(params, opts.ttlSec ?? 0, opts.pg);
  } catch (err) {
    // Restore the prior .mcp.json (if any) so a half-written file
    // doesn't trip the next spawn's read-then-sign cycle.
    if (backupPath && existsSync(backupPath)) {
      try { renameSync(backupPath, path); } catch { /* best-effort */ }
    }
    // Strict mode is the default since 2026-05-11; an unsigned URL
    // would hard-reject at the operator with
    // `spawn_sig_missing_sig_required_mode` — agent boots, hits
    // its MCP endpoint, every tool call 4xxs, and from the user's
    // POV the agent silently does nothing. Failing loudly here
    // gives the caller a clear error to surface. To re-enable the
    // soft-warn fallback (PAPERCUSP_REQUIRE_SPAWN_SIG != '1' on
    // the operator), pass `allowUnsigned: true` from the caller —
    // see comment on opts. Without that, signing failures are
    // promoted to spawn failures.
    if (!opts.allowUnsigned) {
      throw new Error(
        `[spawn-mcp] signing failed and strict mode is the default; ` +
          `refusing to emit an unsigned URL. Underlying error: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[spawn-mcp] signing failed (${err instanceof Error ? err.message : String(err)}); ` +
        'emitting unsigned URL (caller passed allowUnsigned=true).',
    );
  }
  const config = {
    // `type: 'http'` so claude-code's --mcp-config accepts it; omp loads
    // it too. See buildSpawnMcpConfig for the rationale.
    mcpServers: { papercusp: { type: 'http' as const, url: `${base}?${params.toString()}` } },
  };
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return { path, prior, backupPath };
}

/** Handle for a per-spawn codex CODEX_HOME (cleaned up after the spawn). */
export interface SpawnCodexHomeHandle {
  /** Absolute path to set as the child's CODEX_HOME. */
  codexHome: string;
  /** The signed MCP URL written into config.toml (for logging). */
  mcpUrl: string;
  /** Remove the temp CODEX_HOME. Best-effort, idempotent. */
  cleanup(): void;
}

/** Model-window values already resolved by the canonical upper-layer launch
 * policy. The orchestrator only renders them; it deliberately does not carry a
 * second model-family/registry policy that could drift. */
export interface SpawnCodexContextConfig {
  modelContextWindow: number;
  modelAutoCompactTokenLimit: number;
}

export interface SpawnCodexConfigOpts extends CodexGatewayConfigOpts {
  /** Effective model written at the CODEX_HOME root so model-less resumes
   * cannot fall through to the installed models cache. The launch boundary
   * supplies its explicit/inherited selection; this renderer does not select
   * a default on the caller's behalf. */
  model?: string | null;
  contextConfig?: SpawnCodexContextConfig | null;
}

export function buildSpawnCodexConfigToml(
  mcpUrl: string,
  accountId?: string | null,
  opts: SpawnCodexConfigOpts = {},
): string {
  const gatewayConfig = codexGatewayConfigToml(accountId, opts);
  const contextConfig = opts.contextConfig;
  return [
    ...(contextConfig
      ? [
          `model_context_window = ${contextConfig.modelContextWindow}`,
          `model_auto_compact_token_limit = ${contextConfig.modelAutoCompactTokenLimit}`,
        ]
      : []),
    ...codexModelConfigToml(opts.model),
    ...gatewayConfig.root,
    ...codexManagedFeaturesToml({ disableMemories: false }),
    '# Per-spawn codex MCP config (managed by spawn-mcp.ts writeSignedSpawnCodexHome).',
    ...gatewayConfig.tables,
    '[mcp_servers.papercusp]',
    `url = "${tomlEscape(mcpUrl)}"`,
    '',
  ].join('\n');
}

/**
 * codex equivalent of {@link writeSignedSpawnMcp}. codex has no
 * `.mcp.json` discovery and no `--mcp-config` flag — its MCP servers are
 * declared in `$CODEX_HOME/config.toml`. So we mint a per-spawn CODEX_HOME
 * tmpdir holding:
 *   - `config.toml` with `[mcp_servers.papercusp] url = "<signed URL>"` —
 *     the SAME signed, role-scoped URL the .mcp.json path uses; auth is the
 *     `sig` query param (verifySpawnParams), so NO bearer token is needed.
 *   - `auth.json` symlinked to `~/.codex/auth.json` so the ChatGPT OAuth
 *     login carries over (no API key).
 * Set `CODEX_HOME=<this>` on the spawn env; call `cleanup()` after exit.
 */
export async function writeSignedSpawnCodexHome(
  input: SpawnMcpConfigInput,
  opts: {
    ttlSec?: number;
    codexHome?: string;
    cleanup?: boolean;
    model?: string | null;
    contextConfig?: SpawnCodexContextConfig | null;
    /** Reuse the caller's already-open PG handle instead of requiring a DSN env. */
    pg?: SpawnMcpSigningPg;
  } & SpawnMcpRouteProbeOptions = {},
): Promise<SpawnCodexHomeHandle> {
  const base = await resolveSpawnOperatorBaseAsync(input.operatorUrl, opts);
  const params = buildSpawnUrlParams(input);
  await signSpawnParams(params, opts.ttlSec ?? 0, opts.pg);
  const mcpUrl = `${base}?${params.toString()}`;

  const codexHome = opts.codexHome?.trim() || mkdtempSync(join(tmpdir(), 'codex-spawn-'));
  const shouldCleanup = opts.cleanup ?? !opts.codexHome;
  mkdirSync(codexHome, { recursive: true });
  // Share the ChatGPT OAuth login (codex resolves auth from $CODEX_HOME/auth.json).
  try {
    const realAuth = join(homedir(), '.codex', 'auth.json');
    const authLink = join(codexHome, 'auth.json');
    if (existsSync(realAuth) && !existsSync(authLink)) symlinkSync(realAuth, authLink);
  } catch { /* best-effort — codex surfaces an auth error if missing */ }
  // codex does NOT env-expand inside config.toml; the URL is fully baked
  // (incl. the sig), so no bearer_token_env_var is needed (unlike the
  // superuser codex-su home, which uses ?superuser=1 + a bearer).
  const toml = buildSpawnCodexConfigToml(mcpUrl, process.env.PAPERCUSP_ACCOUNT_ID, {
    model: opts.model,
    ownerId: input.clientId || input.spawnId,
    priority: input.role,
    // WI-3645: PAPERCUSP_ACCOUNT_ID alone used to be the only "route through the gateway" signal —
    // an explicit-auto (or an unpinned-after-validation-failure) spawn had no account id and so got
    // NO gateway config at all, silently falling back to direct ChatGPT egress on the local CLI
    // credential. PAPERCUSP_CODEX_GATEWAY carries "gateway on" independent of whether a pin resolved.
    gatewayOn: !!process.env.PAPERCUSP_CODEX_GATEWAY,
    contextConfig: opts.contextConfig,
  });
  writeFileSync(join(codexHome, 'config.toml'), toml, 'utf8');
  try { chmodSync(join(codexHome, 'config.toml'), 0o600); } catch { /* best-effort */ }

  return {
    codexHome,
    mcpUrl,
    cleanup() {
      if (shouldCleanup) {
        try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

/** Handle for a per-spawn OMP HOME (cleaned up after the spawn). */
export interface SpawnOmpHomeHandle {
  /** Absolute path to set as the omp child's `HOME` (pi resolves `<HOME>/.omp/agent`). */
  home: string;
  /** Absolute path of the gateway `models.yml` written under the seeded home (logging/tests). */
  modelsPath: string;
  /** Remove the temp HOME. Best-effort, idempotent. */
  cleanup(): void;
}

/** The omp agent-dir essentials seeded (by symlink) into a per-spawn HOME. The
 *  session's models.yml is AUTHORED (not symlinked) so it shadows the source. */
export const OMP_SEEDED_AGENT_ESSENTIALS = [
  'auth.json',
  'agent.db',
  'config.yml',
  'extensions',
] as const;

/**
 * OMP equivalent of {@link writeSignedSpawnCodexHome}. pi reads its model config
 * + auth from `<HOME>/.omp/agent` (USER-LEVEL only — no `--models` flag and no
 * agent-dir env var, so HOME is the ONLY lever; omp-account-pinning-gateway
 * D-002), so a per-session gateway routing override is delivered by minting a
 * fresh HOME, SEEDING it from the source omp agent dir (symlinking auth/config/
 * session DBs — NO credential copy; deliberately NOT mcp.json, because invoke()
 * authors the role-scoped signed MCP config in the cwd), AUTHORING
 * the gateway `models.yml` into it, and pointing the omp child at it via `HOME`.
 * The spawn then force-selects `papercusp-gateway/<model>` via `--model` so omp
 * POSTs `/v1/messages` (or `/v1/responses`) to the gateway with the account-pin
 * header — the wire shape VERIFIED end-to-end on real omp 15.5.13 (D-006).
 *
 * Per-spawn HOME isolation (vs writing the workspace-shared `<wsHome>/.omp/agent`)
 * is the correct design: collision-free under concurrent pins + no persistent
 * mutation; git identity comes from the injected gitConfigNoPushEnv, not HOME's
 * `.gitconfig`, so a fresh HOME is fine for autonomous spawns (D-005/D-008).
 *
 * @param modelsYml the gateway `models.yml` bytes (resolveSpawnGatewayEnv's
 *   `PAPERCUSP_OMP_MODELS_YML`).
 * @param sourceAgentDir the omp agent dir to seed essentials FROM
 *   (`<spawnHome ?? ~>/.omp/agent`).
 */
export function writeSpawnOmpHome(
  modelsYml: string,
  sourceAgentDir: string,
): SpawnOmpHomeHandle {
  const home = mkdtempSync(join(tmpdir(), 'omp-spawn-'));
  const agentDir = join(home, '.omp', 'agent');
  mkdirSync(agentDir, { recursive: true });
  for (const entry of OMP_SEEDED_AGENT_ESSENTIALS) {
    try {
      const src = join(sourceAgentDir, entry);
      const dst = join(agentDir, entry);
      // A missing source essential degrades gracefully (omp surfaces its own
      // auth/config error) — never block the spawn on a seed miss.
      if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst);
    } catch { /* best-effort */ }
  }
  // The routing override — the ONE file we author (not symlink), so it shadows
  // the source's models.yml for THIS session only.
  const modelsPath = join(agentDir, 'models.yml');
  writeFileSync(modelsPath, modelsYml, 'utf8');
  try { chmodSync(modelsPath, 0o600); } catch { /* best-effort */ }
  return {
    home,
    modelsPath,
    cleanup() {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/**
 * LOCAL-model detection for an omp spawn's resolved `--model` id. Mirror of
 * operator-core's model-tier LOCAL_PROVIDER_PREFIXES — operator-core depends on
 * THIS package, so the rule can't be imported here (same reason psu-launcher.mjs
 * keeps its own copy). Unknown/empty ⇒ NOT local (never seed a hosted model).
 */
const OMP_LOCAL_MODEL_PREFIXES = ['ollama/', 'ollama-cc/', 'local/', 'llamacpp/', 'llama.cpp/', 'lmstudio/', 'localai/'] as const;
export function isLocalOmpModel(modelId?: string | null): boolean {
  if (!modelId) return false;
  const id = String(modelId).trim().toLowerCase();
  return OMP_LOCAL_MODEL_PREFIXES.some((p) => id.startsWith(p));
}

/** Handle for a per-spawn omp `--config` overlay file (cleaned up after the spawn). */
export interface SpawnOmpConfigOverlayHandle {
  /** Absolute path to pass as `--config <path>` on the omp child's argv. */
  path: string;
  /** Remove the temp overlay. Best-effort, idempotent. */
  cleanup(): void;
}

/**
 * LOCKSTEP with operator-core's inference-gateway/gateway.ts `MAINTENANCE_SUMMARIZE_PATH`
 * — operator-core depends on THIS package, so the constant cannot be imported here (same
 * reason OMP_LOCAL_MODEL_PREFIXES above is a mirror, not an import).
 */
export const OMP_MAINTENANCE_SUMMARIZE_PATH = '/maintenance/summarize';

/**
 * The gateway remote-compaction endpoint for an omp spawn (deterministic-context-carry
 * P-002): where omp's summarizer POSTs `{systemPrompt, prompt}` → `{summary}` instead of
 * running the summary on the spawn's own backend. Prefer the `baseUrl` already baked into
 * the spawn's gateway models.yml (stripping the openai wire's trailing `/v1`) so the
 * endpoint always targets the SAME gateway the spawn's model traffic rides; fall back to
 * the resolved local gateway port for a spawn with no models.yml (local-model spawns).
 */
export function ompRemoteCompactionEndpoint(
  modelsYml?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let root = '';
  const m = modelsYml?.match(/^[ \t]*baseUrl:[ \t]*"?([^"\s#]+)"?/m);
  if (m) root = m[1].replace(/\/v1\/?$/, '');
  if (!root) {
    const p = Number(env.PAPERCUSP_GATEWAY_PORT);
    const port = Number.isFinite(p) && p > 0 ? p : 8788;
    root = `http://127.0.0.1:${port}`;
  }
  return root.replace(/\/+$/, '') + OMP_MAINTENANCE_SUMMARIZE_PATH;
}

/** Options for {@link writeOmpCompactionOverlay}. */
export interface OmpCompactionOverlayOpts {
  /**
   * `'shake'` (the default) seeds the mechanical strategy @70%. Since P-022
   * (2026-07-18) EVERY omp spawn uses it — omp's native strategies (snapcompact
   * et al.) are retired fleet-wide, superseding the P-001 "gateway-pinned hosted
   * model keeps its native strategy" posture. `null` (endpoint-only overlay) is
   * kept for tests/tools but no production spawn path passes it anymore.
   */
  strategy?: 'shake' | null;
  /** omp `compaction.remoteEndpoint` — the gateway maintenance-lane summarize URL. */
  remoteEndpoint?: string;
}

/**
 * Compaction settings for an omp fleet spawn (deterministic-context-carry P-001/P-002,
 * ornith overflow 2026-07-13). A local-model spawn is NOT gateway-pinned, so it
 * gets no per-spawn HOME from {@link writeSpawnOmpHome} — it runs on the shared
 * `<HOME>/.omp/agent/config.yml`, whose compaction defaults (`snapcompact`, threshold −1)
 * archive history as images a text-only local model can't read, then fall back to LLM
 * summarization on the spawn's own saturated single-slot backend (429 self-starvation →
 * un-gated over-window send → HTTP 400). Delivery is omp's repeatable `--config <file>`
 * overlay flag (a config.yml-style mapping merged over the base), so the shared config is
 * never mutated and no per-spawn HOME is needed: `shake` is mechanical (no LLM, no images)
 * and 70% fires it before the wall. `remoteEndpoint` (P-002) additionally routes any LLM
 * summarization the session still runs off the spawn's own backend onto the gateway's
 * reserved maintenance lane. NOTE: omp THROWS on a remoteEndpoint failure (no local
 * fallback), so callers only deliver it where the gateway is already a hard dependency
 * (gateway-pinned) or where the alternative is worse (a local model's own saturated slot).
 */
export function writeOmpCompactionOverlay(
  opts: OmpCompactionOverlayOpts = {},
): SpawnOmpConfigOverlayHandle {
  const { strategy = 'shake', remoteEndpoint } = opts;
  const lines = ['compaction:'];
  if (strategy === 'shake') lines.push('  strategy: shake', '  thresholdPercent: 70');
  if (remoteEndpoint) lines.push(`  remoteEndpoint: "${remoteEndpoint.replace(/"/g, '\\"')}"`);
  // A bare `compaction:` parses as YAML null and would NULL-OUT the base compaction
  // block on merge — reject the strategy:null + no-endpoint combination outright.
  if (lines.length === 1) throw new Error('empty omp compaction overlay (strategy:null with no remoteEndpoint)');
  const dir = mkdtempSync(join(tmpdir(), 'omp-cfg-overlay-'));
  const path = join(dir, 'compaction-local-model.yml');
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return {
    path,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/** Handle for a per-spawn claude-code CLAUDE_CONFIG_DIR (cleaned up after the spawn). */
export interface SpawnClaudeConfigHandle {
  /**
   * Absolute path to set as the child's `CLAUDE_CONFIG_DIR`. An isolated
   * `.claude` carrying ONLY the credentials symlink — no `settings.json`
   * (⇒ no `enabledPlugins`) and no `plugins/` dir (⇒ no known marketplaces).
   */
  configDir: string;
  /** Remove the temp config dir. Best-effort, idempotent. */
  cleanup(): void;
}

/**
 * Mint a per-spawn, plugin-free `CLAUDE_CONFIG_DIR` for a claude-code spawn.
 *
 * Root cause (P-012, reproduced live on claude-code 2.1.161): claude-code
 * resolves an enabled plugin whose marketplace source is an external git repo
 * by `git clone --depth 1 --no-checkout <url> <tmp>` followed by
 * `git checkout <sha>` — and that checkout's work-tree is the git process's
 * **cwd**. When claude fails to pin that cwd to the temp clone, the cwd is the
 * spawned worker's cwd (itself a git repo), so the plugin's file tree
 * (`package.json` / `.mcp.json` / `README.md` / `.claude-plugin/…` / etc.) is
 * materialized into the worker's working directory via `O_WRONLY|O_CREAT|O_EXCL`
 * — the "full spawn writes empty config stubs" bug. It is a claude-code defect,
 * not ours (filed upstream); `DISABLE_AUTOUPDATER` does NOT gate it (that var
 * controls the binary self-updater; the marketplace refresh is gated by a
 * per-marketplace `autoUpdate` flag, default-true for official marketplaces).
 *
 * The fix on our side is to deny the worker any plugins/marketplaces to
 * resolve in the first place: point `CLAUDE_CONFIG_DIR` at a fresh dir that
 * carries only the auth symlink. With no `settings.json`/`plugins/`, claude-code
 * performs ZERO plugin/marketplace git activity during the spawn (verified: an
 * isolated config does 0 git execs / 0 temp clones / 0 cwd writes), so it cannot
 * check a plugin tree out into the worker cwd. This mirrors what the desktop
 * shell already does per-workspace (`workspaces.rs::link_workspace_credentials`
 * symlinks creds + gitconfig but NOT settings/plugins); here we extend the same
 * isolation to the dev / non-shared-operator path, where the worker would
 * otherwise inherit the engineer's full `~/.claude` (all enabled plugins).
 *
 * `realHome` is the spawn's effective HOME (post {@link resolveSpawnHome}); the
 * auth file is read from `<realHome>/.claude/.credentials.json`. **Symlinked,
 * not copied**, so an OAuth token refresh writes through to the real file — no
 * credential divergence (cf. the codex auth-copy hazard). A spawn whose home has
 * no credentials file simply runs unauthenticated, exactly as before.
 *
 * Set `CLAUDE_CONFIG_DIR=<this>` on the spawn env (and add it to the OS sandbox's
 * writable set, since claude writes session state under its config dir); call
 * `cleanup()` after exit.
 */
export function writeSpawnClaudeConfig(
  realHome: string,
  opts: {
    /**
     * Persistent config dir for TRACKED (resumable) launches — D-010's third
     * leg. claude writes the session transcript under
     * `$CLAUDE_CONFIG_DIR/projects/**`; a temp dir takes it to the grave, so
     * `claude --resume <sessionId>` at wake time finds nothing (the Stage-A
     * smoke failure, 2026-06-06). A tracked launch passes the conventional
     * `~/.papercusp/session-claude/<spawnId>` dir instead; cleanup() then
     * leaves it in place for wake-executor, which sets CLAUDE_CONFIG_DIR to
     * the same path on resume.
     */
    persistentDir?: string;
  } = {},
): SpawnClaudeConfigHandle {
  if (opts.persistentDir) {
    const configDir = opts.persistentDir;
    mkdirSync(configDir, { recursive: true });
    try {
      const realCreds = join(realHome, '.claude', '.credentials.json');
      const dest = join(configDir, '.credentials.json');
      if (existsSync(realCreds) && !existsSync(dest)) symlinkSync(realCreds, dest);
    } catch { /* best-effort — claude surfaces an auth error if missing */ }
    return {
      configDir,
      cleanup() {
        /* persistent on purpose — the resume leg reads it after this spawn dies */
      },
    };
  }
  const configDir = mkdtempSync(join(tmpdir(), 'claude-cfg-spawn-'));
  // Share the user's Claude OAuth session (claude resolves auth from
  // $CLAUDE_CONFIG_DIR/.credentials.json) WITHOUT carrying its plugins.
  try {
    const realCreds = join(realHome, '.claude', '.credentials.json');
    if (existsSync(realCreds)) symlinkSync(realCreds, join(configDir, '.credentials.json'));
  } catch { /* best-effort — claude surfaces an auth error if missing */ }
  return {
    configDir,
    cleanup() {
      // Flight recorder: claude writes this spawn's session transcripts under
      // <configDir>/projects/** — the ONLY client-side record of MCP mount
      // failures / tool errors. Deleting them with the dir made the all-mute
      // 2026-06-06 re-fan batch undiagnosable post-mortem (zero coord writes,
      // zero transcripts, output_tail only). Preserve them durably first,
      // keyed by the durable spawn id, so a mute bee leaves evidence.
      try {
        const projectsDir = join(configDir, 'projects');
        if (existsSync(projectsDir)) {
          const spawnId = (process.env.PAPERCUSP_SPAWN_ID ?? '').trim();
          const root =
            process.env.PAPERCUSP_FLIGHT_RECORDER_DIR ||
            join(homedir(), '.papercusp', 'flight-recorder');
          const dest = join(root, spawnId || `unlabeled-${basename(configDir)}`);
          mkdirSync(dest, { recursive: true });
          cpSync(projectsDir, dest, { recursive: true });
        }
      } catch { /* best-effort — never block cleanup */ }
      try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/* ─── Signing (HMAC-SHA256 over canonical params) ─────────────────────
 * The allowlist + canonicalization + HMAC are NO LONGER duplicated: they live
 * in the shared `./spawn-signing-core` (imported above), the SAME module
 * operator-core's spawn-signing.ts imports — so the rule can't drift between the
 * two processes (unify-launch-mechanics follow-on, signing dedup). Only the
 * per-process KEY LOADING stays here (its own PG client + cache).
 * ──────────────────────────────────────────────────────────────────── */

interface KeyCache { buf: Buffer; rotatedAt: number; loadedAt: number; }
let __keyCache: KeyCache | null = null;

// Within the 5-minute TTL we serve the cached key WITHOUT opening a PG pool —
// the cache check runs FIRST (F-B3: don't pay a pool-open + SELECT on the hot
// path). Only on a cache miss/expiry do we open the pool and re-read; PG's
// authoritative rotated_at still wins there, so a rotate on the operator
// invalidates this process's cache on its next read after the TTL lapses.
interface SigningKeyRow { value_b64: string; rotated_at: Date | string; }

async function querySigningKey(pg: SpawnMcpSigningPg): Promise<SigningKeyRow[]> {
  return pg<SigningKeyRow[]>`
    SELECT value_b64, rotated_at FROM harness_shared.operator_secrets
    WHERE name = 'spawn-signing-key' LIMIT 1
  `;
}

async function loadSigningKey(existingPg?: SpawnMcpSigningPg): Promise<Buffer> {
  if (__keyCache && Date.now() - __keyCache.loadedAt < 5 * 60 * 1000) {
    return __keyCache.buf;
  }
  let rows: SigningKeyRow[];
  if (existingPg) {
    rows = await querySigningKey(existingPg);
  } else {
    const dsn = process.env.DATABASE_URL ?? process.env.PAPERCUSP_PG_DSN;
    if (!dsn) throw new Error('no PG DSN in env (DATABASE_URL/PAPERCUSP_PG_DSN)');
    const sql = postgres(dsn);
    try {
      rows = await querySigningKey(sql as unknown as SpawnMcpSigningPg);
    } finally {
      try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
    }
  }
  if (rows.length === 0) {
    throw new Error('spawn-signing-key row missing — operator boots mint it on first verify call');
  }
  const rotatedAt = new Date(rows[0].rotated_at).getTime();
  // PG's rotated_at is authoritative on a re-read: if the key hasn't rotated,
  // refresh the cache's loadedAt window and reuse the buffer; otherwise adopt
  // the rotated key.
  if (__keyCache && __keyCache.rotatedAt === rotatedAt) {
    __keyCache = { ...__keyCache, loadedAt: Date.now() };
    return __keyCache.buf;
  }
  const buf = decodeOperatorSecretKey(rows[0].value_b64, 'spawn-signing-key');
  __keyCache = { buf, rotatedAt, loadedAt: Date.now() };
  return buf;
}

async function signSpawnParams(
  params: URLSearchParams,
  ttlSec: number,
  pg?: SpawnMcpSigningPg,
): Promise<void> {
  // ttlSec <= 0 ⇒ PERMANENT (exp=0 sentinel); the operator's verifySpawnParams skips the time
  // check for exp=0. No time-based re-minting (owner directive 2026-07-01) — kept byte-identical
  // to the operator-side signer in packages/operator-core/lib/spawn-signing.ts.
  const exp = ttlSec > 0 ? Math.floor(Date.now() / 1000) + ttlSec : 0;
  params.set('exp', String(exp));
  params.delete('sig');
  const key = await loadSigningKey(pg);
  const c = canonicalizeSpawnParams(params);
  if (!c.ok) throw new Error(c.reason);
  const sig = hmacSpawnBytes(key, c.canonical).toString('base64url');
  params.set('sig', sig);
}

function buildSpawnUrlParams(input: SpawnMcpConfigInput): URLSearchParams {
  const params = new URLSearchParams();
  params.set('harness', input.harnessSlug);
  params.set('workspace', input.workspaceId);
  params.set('role', input.role);
  params.set('run', input.runId);
  params.set('spawn', input.spawnId);
  if (input.featureId) params.set('feature', input.featureId);
  if (input.chunkId) params.set('chunk', input.chunkId);
  if (input.parentSpawnId) params.set('parent_spawn', input.parentSpawnId);
  if (input.mcpToolNames?.length) params.set('tools', input.mcpToolNames.join(','));
  // THE UMBILICAL: the stable coord owner id (operator's `s-…` spawnId). It's in the
  // signed-param allowlist (`client`), so it's part of the HMAC — the operator
  // verifies it before trusting it as the child's coord identity. parseRequestContext
  // reads it into ctx.uiClientId, which resolveAgentIdentity attributes coord writes to.
  if (input.clientId) params.set('client', input.clientId);
  if (input.detectorSessionKey) params.set('detector', input.detectorSessionKey);
  return params;
}

/**
 * Restore the prior `.mcp.json` after a spawn completes (or errors).
 * Always called from a finally block so the user's existing config
 * survives spawn failures.
 *
 * Idempotent: safe to call multiple times. Best-effort cleanup —
 * surfacing a failure here would mask the real spawn error.
 */
export function restoreSpawnMcp(handle: SpawnMcpHandle): void {
  try {
    if (existsSync(handle.path)) {
      unlinkSync(handle.path);
    }
  } catch { /* ignore */ }
  if (handle.backupPath) {
    try {
      if (existsSync(handle.backupPath)) {
        renameSync(handle.backupPath, handle.path);
      }
    } catch { /* ignore */ }
  }
}

/**
 * Extract the `CHUNK_ID=<id>` value from the extras array (mirroring
 * `extractFeatureId` in run-id.ts). Returns null if absent.
 *
 * extras looks like `['FEATURE_ID=F-AUTH-003', 'CHUNK_ID=ck_01HXV9Z']`
 * — the orchestrator main loop and chunk-loop-driver both pass them.
 */
export function extractChunkId(extras: readonly string[]): string | null {
  for (const e of extras) {
    if (e.startsWith('CHUNK_ID=')) return e.slice('CHUNK_ID='.length).trim() || null;
  }
  return null;
}
