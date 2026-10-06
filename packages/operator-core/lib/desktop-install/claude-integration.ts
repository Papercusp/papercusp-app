/**
 * claude-integration — register the `papercusp-su` MCP server into the user's
 * USER-LEVEL Claude Code config (`~/.claude.json`) on a desktop install.
 *
 * The claude sibling of `omp-integration.ts`, and the Node port of step 3a of
 * `apps/operator/scripts/install-standalone-mcp.sh`. psu launches raw `claude`
 * for a superuser session and supplies NO `--mcp-config` — claude's
 * `papercusp-su` server is expected to live in `~/.claude.json` (see
 * `suLaunchArgs` + `interactive-claude-config.ts`). Nothing in the DESKTOP boot
 * path registered it (the omp/claude MCP merge sat only in the Linux-only
 * `ensureOmpSuInstalled`), so a desktop user who runs `psu → claude` got a
 * session with ZERO MCP tools ("MCP tools aren't up"). This module closes that.
 *
 * TWO deliberate differences from the omp sibling, both because the desktop
 * operator binds a DIFFERENT, DYNAMIC localhost port every boot (unlike the dev
 * box's stable 3070/9071):
 *
 *  1. The MCP url is ENV-INTERPOLATED, not baked. claude expands `${VAR}` /
 *     `${VAR:-default}` in an mcp url at launch, so we write
 *       ${PAPERCUSP_OPERATOR_URL:-<fallback>}/api/mcp?superuser=1
 *         &client=${PAPERCUSP_SID:-<agentId>}
 *         &native_session=${CLAUDE_CODE_SESSION_ID:-}
 *         &workspace=${PAPERCUSP_WORKSPACE:-}
 *         &profile=${PAPERCUSP_PROFILE:-<profileDefault>}
 *         &tools=${PAPERCUSP_TOOLS:-}      (su-context-size-variants: CORE spine when trimmed)
 *     and psu EXPORTS `PAPERCUSP_OPERATOR_URL` (the live operator url it already
 *     resolves) on the claude child. Registration is then ONE-TIME and the url
 *     self-heals across the dynamic port — no per-boot rewrite, idempotent. The
 *     `<fallback>` only applies to a bare `claude` launched outside psu.
 *
 *  2. We NEVER create `~/.claude.json`. A missing file means Claude Code has
 *     never been launched on this machine; creating one would seed unrelated
 *     defaults the user didn't ask for AND skip the onboarding/trust flow. We
 *     merge only into an existing file (every other key preserved), so the
 *     registration lands on the first boot AFTER claude has been run once.
 *
 * Idempotent · best-effort · preserves every other key + mcpServer · mode 0600.
 * Mac + Linux (Windows deferred, like omp) — HOWEVER (windows-desktop-feature-
 * parity-2026-07-02 P-025 audit): this module runs inside the operator
 * sidecar, which on a Windows desktop install is always launched via
 * `wsl.exe --exec node ...`, so `process.platform` reports 'linux' there
 * too. The `windows_not_supported_in_v1` guard below is therefore DEAD CODE
 * on Windows — the Linux path runs instead, writing into the WSL-side
 * `~/.claude.json` (the config a `claude` launched INSIDE that same distro
 * reads, per the Phase 2 title-based-terminal architecture). Static analysis
 * only — not yet VM-verified live; see WI-1646 for the sibling endpoint-ipc
 * finding from the same audit. Reads token + agent_id from `~/.papercusp/`
 * (installPapercuspFiles must have run first).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveInstallPaths } from './papercusp-files';
import { resolveAgentMcpBaseUrl } from '../mcp-base-url';

/** The default operator url baked as the `${PAPERCUSP_OPERATOR_URL:-…}` fallback.
 *  Only used for a bare `claude` (no psu); psu exports a resolved url. Kept
 *  STATIC (never the dynamic boot port) so the written entry is byte-stable →
 *  the merge stays idempotent across boots.
 *
 *  P-007 (mcp-reliability-hardening-2026-07-11): this is now the RESILIENT MCP
 *  PROXY (:9071), not a bare direct :3070, on EVERY host — desktop AND dev box.
 *  The proxy fronts :3070 and survives its deploy-restarts (WI-1457), so a bare
 *  `claude` rides the restart-invisible path by default. A dev-box reconcile with
 *  neither PAPERCUSP_MCP_PROXY_BASE nor PAPERCUSP_DESKTOP set used to re-bake the
 *  deploy-fragile direct :3070 here (silently reverting the P-006 cutover minutes
 *  after every manual re-point); defaulting to the proxy port closes that class.
 *  An explicit PAPERCUSP_MCP_PROXY_BASE still overrides (resolveAgentMcpBaseUrl). */
const DEFAULT_OPERATOR_URL_FALLBACK = 'http://127.0.0.1:9071';

export interface ClaudeIntegrationOptions {
  /** Override ~/. Tests pass this. Defaults to os.homedir(). */
  home?: string;
  /** Fallback operator url for a NON-psu `claude` (psu exports the live one).
   *  Default http://localhost:3070. */
  operatorUrl?: string;
  /** Which su profile a bare claude defaults to: 'power' → `profile=power`,
   *  anything else (engineer) → empty. Default engineer. */
  profile?: string;
  /**
   * DESKTOP clean-install seed (windows-parity, WI-3091). When true and
   * `~/.claude.json` is ABSENT, CREATE a minimal valid file carrying just the
   * `papercusp-su` server + `hasCompletedOnboarding` instead of the historic
   * no-op bail. This closes the clean-install chicken-and-egg: the operator
   * boot reconcile runs while `~/.claude.json` is still absent (no-op), then
   * `claude` creates it (empty mcpServers) on its FIRST run inside the psu
   * session — so the first psu→claude has ZERO tools and never self-heals.
   * Only the DESKTOP host boot (PAPERCUSP_DESKTOP=1) passes this; a dev box
   * keeps the never-create behavior (a bare `claude` there must not be
   * pre-seeded). Off by default — byte-identical to before for every caller
   * that omits it. */
  seedIfAbsent?: boolean;
}

export interface ClaudeIntegrationResult {
  /** ~/.claude.json — the user-level Claude Code config. */
  claudeConfigPath: string;
  /** True when ~/.claude.json exists (claude has been launched at least once). */
  claudeConfigExists: boolean;
  /** True when papercusp-su is configured in ~/.claude.json after this call. */
  mcpServerInstalled: boolean;
  supported: boolean;
  /** Reason when supported=false, or nothing changed for a notable cause. */
  reason?: string;
  /** True when this call wrote the file. */
  changed: boolean;
  /** Itemized actions — for a settings UI / boot log. */
  actions: string[];
}

interface ClaudeMcpEntry {
  type: string;
  url: string;
  headers: Record<string, string>;
}

/** ~/.claude.json is a large user file (onboarding/trust/projects/MCP approvals);
 *  every key must round-trip. */
type ClaudeConfig = { mcpServers?: Record<string, ClaudeMcpEntry>; [k: string]: unknown };

export function resolveClaudeConfigPath(home: string): string {
  return path.join(home, '.claude.json');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function tryReadTrim(p: string): Promise<string | null> {
  try {
    const t = (await fs.readFile(p, 'utf8')).trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Profile query-param value baked as the `${PAPERCUSP_PROFILE:-…}` default. */
function profileDefault(profile: string | undefined): string {
  return profile === 'power' ? 'power' : '';
}

/** The env-interpolated entry (see header). `operatorUrlFallback` / `agentId` /
 *  `prof` only feed the `:-default` arms — psu supplies the real values at launch. */
export function buildClaudeMcpEntry(
  operatorUrlFallback: string,
  token: string,
  agentId: string,
  prof: string,
): ClaudeMcpEntry {
  return {
    type: 'http',
    url:
      `\${PAPERCUSP_OPERATOR_URL:-${operatorUrlFallback}}/api/mcp?superuser=1` +
      `&client=\${PAPERCUSP_SID:-${agentId}}` +
      `&native_session=\${CLAUDE_CODE_SESSION_ID:-}` +
      `&workspace=\${PAPERCUSP_WORKSPACE:-}` +
      // orient-recall-quality follow-up (2026-07-12, recall drill 2): the initialize-time
      // memory prelude derives its recall query from ?harness= — without this param EVERY
      // psu claude session was a "bare session" to buildMcpPrelude (empty query → NO
      // session-start memory recall at all; live-proven via the drill's ledger: zero
      // port='initialize' stamps under any su-* id in 24h). console-launcher already
      // exports PAPERCUSP_HARNESS_SLUG for harness-scoped spawns; empty stays bare-session
      // behavior (unchanged for a bare claude).
      `&harness=\${PAPERCUSP_HARNESS_SLUG:-}` +
      `&profile=\${PAPERCUSP_PROFILE:-${prof}}` +
      // su-context-size-variants (claude trim): the ?tools= LISTING allowlist. psu exports
      // PAPERCUSP_TOOLS = the ~19-tool CORE SPINE for a `--context-size=trimmed` claude, so the
      // superuser MCP advertises ONLY the spine (~9k vs the full ~165k catalog) — the fix for
      // claude-sonnet dying "Prompt is too long" on its 200k window (claude's native ToolSearch
      // defers only SCHEMAS, leaving all ~581 names+descriptions inline). Unset/empty ⇒ full
      // catalog (parseToolsAllowlist treats empty as no-filter — zero regression for a bare
      // claude or any session that sets no allowlist). The long tail stays reachable via
      // `tools:find` (in the spine).
      `&tools=\${PAPERCUSP_TOOLS:-}` +
      // deterministic-tool-definition-delivery-2026-09-21: the SECOND axis of the
      // same decision. `?tools=` says WHICH tools are advertised; this says HOW
      // MUCH of each one ships. A name here is still advertised and still
      // callable — only prose is stripped from its advertised definition
      // (compactInputSchema keeps property names, types, the required set, enum
      // members, bounds, discriminators, nested shape and $defs/$ref). That makes
      // admission three-way (full / compact / deferred) instead of all-or-nothing,
      // which is what let seven high-demand heavies back into the seed. psu
      // exports PAPERCUSP_TOOLS_COMPACT from the GENERATED delivery artifact, so
      // neither list is hand-maintained. Unset/empty ⇒ nothing is compacted
      // (byte-identical for a bare claude or any non-psu session).
      `&tools_compact=\${PAPERCUSP_TOOLS_COMPACT:-}` +
      // context-trimming-tiers D-004: the session PAYLOAD tier — a DIFFERENT axis from the
      // retired --context-size mode. psu exports PAPERCUSP_CONTEXT_TIER='trimmed'
      // unconditionally (no launch flag selects 'full'; ptool's PAPERCUSP_CONTEXT_TIER=full
      // env override remains the one escape hatch for unshaped payloads) and the server
      // threads it to ctx.contextTier so defineTool `shape` projections apply.
      // Unset/empty/invalid ⇒ 'full' (unshaped — byte-identical for a bare claude).
      `&ctx_tier=\${PAPERCUSP_CONTEXT_TIER:-}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

function entryEquals(a: ClaudeMcpEntry | undefined, b: ClaudeMcpEntry): boolean {
  return (
    !!a &&
    a.type === b.type &&
    a.url === b.url &&
    a.headers?.Authorization === b.headers.Authorization
  );
}

export async function readClaudeIntegrationState(
  opts: ClaudeIntegrationOptions = {},
): Promise<{ claudeConfigPath: string; claudeConfigExists: boolean; mcpServerInstalled: boolean }> {
  const home = opts.home ?? os.homedir();
  const claudeConfigPath = resolveClaudeConfigPath(home);
  const claudeConfigExists = await pathExists(claudeConfigPath);
  let mcpServerInstalled = false;
  if (claudeConfigExists) {
    try {
      const cfg = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8')) as ClaudeConfig;
      mcpServerInstalled = !!cfg.mcpServers?.['papercusp-su'];
    } catch {
      /* invalid json → treat as not installed */
    }
  }
  return { claudeConfigPath, claudeConfigExists, mcpServerInstalled };
}

export async function installClaudeIntegration(
  opts: ClaudeIntegrationOptions = {},
): Promise<ClaudeIntegrationResult> {
  const home = opts.home ?? os.homedir();
  const claudeConfigPath = resolveClaudeConfigPath(home);

  if (process.platform === 'win32') {
    const st = await readClaudeIntegrationState(opts);
    return { ...st, supported: false, reason: 'windows_not_supported_in_v1', changed: false, actions: [] };
  }

  // installPapercuspFiles must have run first — token + agent_id needed.
  const phase1 = resolveInstallPaths(home);
  const token = await tryReadTrim(phase1.tokenPath);
  const agentId = await tryReadTrim(phase1.agentIdPath);
  if (!token || !agentId) {
    const st = await readClaudeIntegrationState(opts);
    return { ...st, supported: true, reason: 'phase1_not_run', changed: false, actions: [] };
  }

  // WI-1457 / P-007: the baked fallback is the resilient MCP proxy on EVERY host
  // now (DEFAULT_OPERATOR_URL_FALLBACK = :9071), so this operator-side RECONCILER
  // (ensureOmpSuInstalled fires it per console launch) can no longer silently
  // re-mint a direct-:3070 default and revert the P-006 cutover — regardless of
  // PAPERCUSP_DESKTOP. An explicit PAPERCUSP_MCP_PROXY_BASE (WI-573) still overrides
  // via resolveAgentMcpBaseUrl. Still byte-stable: a static loopback URL, so the
  // merge stays idempotent across boots.
  const operatorUrl = opts.operatorUrl ?? resolveAgentMcpBaseUrl(DEFAULT_OPERATOR_URL_FALLBACK);
  const entry = buildClaudeMcpEntry(operatorUrl, token, agentId, profileDefault(opts.profile));

  // ~/.claude.json ABSENT = claude never launched on this box. Historically we
  // bailed (never create it — that would skip onboarding/trust + seed unrelated
  // defaults, wrong for a dev box's bare `claude`). But the DESKTOP psu path
  // HARD-DEPENDS on the user-level papercusp-su server living here, and there is
  // a clean-install chicken-and-egg (WI-3091): the operator boot reconcile runs
  // while the file is still absent (no-op), then `claude` CREATES it with an
  // EMPTY mcpServers on its first run INSIDE the psu session — so the very first
  // psu→claude session has ZERO papercusp tools and never self-heals. On desktop
  // (seedIfAbsent) we therefore SEED a minimal valid file: `papercusp-su` +
  // `hasCompletedOnboarding` (the user already did the Papercusp onboarding, not
  // claude's own theme/trust flow — which would otherwise BLOCK the interactive
  // launch). The env-interpolated url self-heals across the dynamic operator
  // port thereafter. Dev boxes omit seedIfAbsent → unchanged never-create bail.
  if (!(await pathExists(claudeConfigPath))) {
    if (!opts.seedIfAbsent) {
      return {
        claudeConfigPath,
        claudeConfigExists: false,
        mcpServerInstalled: false,
        supported: true,
        reason: 'claude_not_initialized',
        changed: false,
        actions: [],
      };
    }
    const seed: ClaudeConfig = { hasCompletedOnboarding: true, mcpServers: { 'papercusp-su': entry } };
    await fs.writeFile(claudeConfigPath, JSON.stringify(seed, null, 2), { mode: 0o600 });
    await fs.chmod(claudeConfigPath, 0o600);
    return {
      claudeConfigPath,
      claudeConfigExists: true,
      mcpServerInstalled: true,
      supported: true,
      changed: true,
      actions: ['seeded ~/.claude.json with mcpServers.papercusp-su (desktop clean-install)'],
    };
  }

  let cfg: ClaudeConfig;
  try {
    cfg = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8')) as ClaudeConfig;
  } catch {
    // Invalid JSON — do NOT back-up-and-recreate (would nuke onboarding/trust/
    // project history). Skip; the user repairs their own file.
    return {
      claudeConfigPath,
      claudeConfigExists: true,
      mcpServerInstalled: false,
      supported: true,
      reason: 'claude_json_invalid',
      changed: false,
      actions: [],
    };
  }

  cfg.mcpServers = cfg.mcpServers ?? {};
  if (entryEquals(cfg.mcpServers['papercusp-su'], entry)) {
    return {
      claudeConfigPath,
      claudeConfigExists: true,
      mcpServerInstalled: true,
      supported: true,
      changed: false,
      actions: [],
    };
  }
  cfg.mcpServers['papercusp-su'] = entry;
  await fs.writeFile(claudeConfigPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fs.chmod(claudeConfigPath, 0o600);

  return {
    claudeConfigPath,
    claudeConfigExists: true,
    mcpServerInstalled: true,
    supported: true,
    changed: true,
    actions: ['registered mcpServers.papercusp-su in ~/.claude.json'],
  };
}

export async function uninstallClaudeIntegration(
  opts: ClaudeIntegrationOptions = {},
): Promise<ClaudeIntegrationResult> {
  const home = opts.home ?? os.homedir();
  const claudeConfigPath = resolveClaudeConfigPath(home);
  const base = { claudeConfigPath, claudeConfigExists: false, mcpServerInstalled: false };

  if (process.platform === 'win32') {
    return { ...base, supported: false, reason: 'windows_not_supported_in_v1', changed: false, actions: [] };
  }
  if (!(await pathExists(claudeConfigPath))) {
    return { ...base, supported: true, changed: false, actions: [] };
  }
  let cfg: ClaudeConfig;
  try {
    cfg = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8')) as ClaudeConfig;
  } catch {
    return { ...base, claudeConfigExists: true, supported: true, reason: 'claude_json_invalid', changed: false, actions: [] };
  }
  if (cfg.mcpServers?.['papercusp-su']) {
    delete cfg.mcpServers['papercusp-su'];
    await fs.writeFile(claudeConfigPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    return {
      ...base,
      claudeConfigExists: true,
      supported: true,
      changed: true,
      actions: ['removed mcpServers.papercusp-su from ~/.claude.json'],
    };
  }
  return { ...base, claudeConfigExists: true, supported: true, changed: false, actions: [] };
}
