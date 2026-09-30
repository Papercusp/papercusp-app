/**
 * console-launcher.ts — build the envelope the Tauri Rust side needs to
 * open an OS-native terminal in the right cwd, with the right env, and
 * with a `.mcp.json` already configured for superuser MCP access.
 *
 * The "+" button in ChromeShell calls `/api/agent-mcp/console/resolve`
 * which calls this. The Tauri command then writes the .mcp.json and
 * spawns the user's terminal.
 *
 * MCP integration: the .mcp.json points at the existing superuser
 * door at `/api/mcp?superuser=1` with the bearer from
 * `~/.papercusp/superuser-token`. That endpoint bypasses role + quota
 * gates per the existing superuser-mode design — see
 * /docs/endpoint-system/superuser-mode. We don't invent a new role.
 *
 * Server-only.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { resolveBackend } from '@papercusp/papercusp-shared/agent';

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

// WI-37920 / P-001: plain-ESM shared module (psu-launcher.mjs imports the same
// one from bare `node`) — see backend-bin-resolve.mjs's header for why.
import {
  SPAWN_PATH_DIRS_ENV,
  encodeSpawnPathDirs,
  resolveSpawnPathDirs,
} from './backend-bin-resolve.mjs';
import { papercuspPathForWorkspace } from './papercusp-root';
// EI-10938: resolve the workspace's home CHECKOUT for a no-slug launch.
import { detectPapercupRoot, hasPapercupMarkers } from './harness/register-papercusp';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';
import { resolveAgentMcpBaseUrl, resolveLongLivedSessionMcpBaseUrl } from './mcp-base-url';
import { advSessionsByTranscriptHandles } from './adv-sessions';
import { wakeAccountRouteFromArgv } from './inference-gateway/spawn-env';
import { sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import {
  resolveContextEnv,
  resolveProjectDir,
  resolveStateDir,
} from './spawn-config';
// (Removed: getSessionUserOrDefault / createPowerUserSession /
// mintAccessToken / mintRefreshToken — used by the old papercusp-omp
// bundle path. /adv routes OMP launches through the omp-su wrapper
// instead, which authenticates via the operator's loopback superuser
// MCP and needs no workspace-scoped tokens.)

/**
 * `shell` — the engineer path: a superuser console with a `.mcp.json`.
 * `omp`   — the engineer OMP path: launch `omp` directly with the
 *           Papercusp engineer playbook + coordination extension,
 *           scoped to the local superuser MCP surface.
 */
export interface ConsoleEnvelope {
  /** Working directory the terminal opens in. */
  cwd: string;
  /**
   * Non-secret env vars. The launcher inline-`export`s these into the
   * oneliner — so they must NOT contain secrets (the oneliner is the
   * spawned shell's argv and is visible in `ps`).
   */
  env: Record<string, string>;
  /** Pretty-printed .mcp.json contents the engineer's claude/codex agent
   *  auto-discovers when they cd into `cwd`. */
  mcpJsonContents: string;
  /** Greeting command the launcher runs before exec'ing the user's shell. */
  greetingCmd: string;
  /** True iff ~/.papercusp/superuser-token is missing. Tauri side
   *  should run install-standalone-mcp.sh before launching. */
  needsSuperuserBootstrap: boolean;
  /**
   * windows-desktop-feature-parity-2026-07-02 P-010: a fresh UUID minted per
   * console launch — the WINDOW's own identity, distinct from
   * `resumeSessionId` (an agent CLI session to resume) and adv_sessions'
   * `session_id` (the agent's native session id). Every spawner titles the OS
   * window `Papercup — <sessionId>` (native_console.rs / console-spawn.ts) so
   * a launched terminal can be found + focused by TITLE. This matters most on
   * Windows: the agent/session runs inside the `papercup-runtime` WSL2
   * distro while the terminal window is a native Win32 process, so there is
   * no Windows window-ancestor for a WSL pid and pid→window mapping (the
   * Linux wmctrl path) is structurally impossible — title is the only durable
   * link. See packages/operator-core/lib/windows-desktop-windows.ts.
   */
  sessionId: string;
  /** Stable coord identity resolved from the resumed adv_sessions row. Null for
   *  fresh/untracked launches. Headless spawners use this only as task-ledger
   *  metadata; it never changes the launched agent's identity. */
  coordOwnerId?: string | null;
}

export interface BuildEnvelopeOpts {
  /** Active workspace id (e.g. 'default'). */
  workspaceId: string;
  /** Active harness slug, if any. Null = workspace-only launch. */
  slug: string | null;
  /** The operator's own base URL (e.g. http://localhost:3070). */
  operatorBaseUrl: string;
  /** Explicit MCP endpoint for a deliberate short A/B session. */
  agentMcpBaseUrl?: string;
  /**
   * scoped-superuser-workspace-clamp D-004 — deliberate cross-workspace ("god
   * mode") console. Default false ⇒ the MCP url bakes the concrete `&workspace=`
   * (scoped-by-default; the flag-gated dispatch clamp then confines the session).
   * true ⇒ bake `&workspace=*` (UNSCOPED) — the explicit opt-in that spans
   * workspaces past the clamp. The caller (Tauri launch UI / psu CLI) sets this.
   */
  allWorkspaces?: boolean;
  /**
   * plan-agent-launch P-023: when set, the shell console resumes an existing
   * session (`<agent-cli> -r <sessionId>`) instead of opening fresh.
   */
  resumeSessionId?: string;
  /**
   * WI-3882 (adv-sessions-live-roster P-012): FORK the resumed session into a
   * fresh branch instead of resuming it in place. Only meaningful together with
   * `resumeSessionId`. For a still-LIVE source session a plain resume would open
   * a SECOND CLI against the same session transcript and collide with the
   * still-running original; forking branches into a new session id (claude
   * `--fork-session`), leaving the original's id + transcript untouched — the
   * exact flag psu-launcher's resumeArgsFor emits for a claude fork. Honored
   * only for claude sessions reachable via this direct-CLI `-r` path (codex is
   * not routed here; omp has no branch command → refused rather than silently
   * plain-resuming into a collision).
   */
  fork?: boolean;
  /**
   * psu-in-desktop-builds-2026-06-23 B: when set, the console runs `psu` (a
   * superuser agent session) on open instead of just dropping to a shell. Only
   * honored when FLAGS.PSU_END_USER is on (defense-in-depth — the discoverable
   * UI entry is also flag-gated). psu is on PATH via the ~/.papercusp/bin shim.
   */
  runPsu?: boolean;
  /**
   * capability:terminal — run this EXACT command in the opened terminal. It
   * becomes the greetingCmd, executed in a subshell before the terminal drops
   * to an interactive login shell — so the command runs and the window stays
   * open. Mutually exclusive with runPsu / resumeSessionId (runCommand wins).
   * Arbitrary by design: same trust model as capability:bash.
   */
  runCommand?: string;
  /**
   * Skip the superuser `.mcp.json` setup entirely. capability:terminal opens a
   * terminal to RUN a command, not to host an MCP-connected agent console, so
   * it must not displace the project's real .mcp.json. Sets mcpJsonContents to
   * '' (the spawner then skips writing it) and needsSuperuserBootstrap to false.
   */
  skipMcpJson?: boolean;
  /**
   * "Resume in GUI" (resume-in-gui-button-2026-08-09, owner ask 2026-08-09): this
   * resume is going to be spawned with NO terminal window (`spawnHeadless`), because
   * the human will talk to it through the HUD conversation popup instead.
   *
   * All this flag does HERE is append psu's `--headless` to the resume greeting —
   * and that is the load-bearing part, not a cosmetic one. `--headless` is what keeps
   * psu's managed pty ON despite non-TTY stdio (psu-launcher L4326-4357); without it a
   * windowless resume parks forever after one turn and nothing can inject into it, so
   * the GUI composer — a real `coord:send { wake:'required' }` — would have nobody to
   * wake. The window is what we are dropping; the injectable session is the whole point.
   *
   * Only meaningful with `resumeSessionId`, and only for CLAUDE sessions: the
   * codex/omp branch below execs the bare interactive CLI rather than routing through
   * psu, so it registers no presence and hosts no pty. A headless one of those would be
   * an invisible process nobody could ever reach — refused below, same posture as the
   * fork guard, rather than silently spawning something unreachable.
   */
  headless?: boolean;
  /**
   * Resume the session on a DIFFERENT model — psu `--model=<model>[:<effort>]`
   * (WI-6510, the chat MODEL control).
   *
   * A full COMPOSED spec, effort included, because psu has no standalone effort
   * flag: effort rides the spec (`composeLaunchModelSpec`). Passing a bare model
   * beside a separate effort is the documented silent-drop bug — a `sonnet-5:high`
   * fleet came up at xhigh on 2026-07-01 — so this is deliberately ONE field, not
   * two, and callers compose before they get here.
   *
   * ⚠ NAMED `resumeModel`, NOT `model`, on purpose: `NativeConsoleOptions.model`
   * already exists and is documented as an OMP fuzzy-match argument. Reusing that
   * name would put two unrelated meanings on one field, distinguished only by
   * which backend happened to be resolved.
   *
   * Only meaningful with `resumeSessionId`, and only for CLAUDE sessions — those
   * are the ones routed through psu below. The codex/omp branch execs the bare
   * interactive CLI, which takes no psu flag, so a spec there would be silently
   * dropped; it is refused instead (same posture as the fork/headless guards).
   *
   * Context is PRESERVED: `psu --resume` honors `--model`/`--effort` like a fresh
   * launch (psu-launcher `resumeArgsFor`, WI-3758), so this continues the SAME
   * conversation on a different model rather than starting a new one.
   */
  resumeModel?: string;
}

// (kickoff-kind allowlist moved to @/lib/agent-kickoff/kickoff-kind in P-032,
//  when the omp launch flavour was retired from this module.)
const TOKEN_PATH = join(homedir(), '.papercusp', 'superuser-token');

/**
 * Where the bundled `papercup` shim + `papercup-status.mjs` live so the
 * Tauri launcher can prepend it to PATH. We try a few candidates so
 * dev (`npm run dev` from apps/operator) and prod-standalone (sidecar
 * bundle layout) both resolve correctly. Returns null when neither
 * exists — the launcher just runs without the greeting on PATH.
 */
function resolveScriptsDir(): string | null {
  const cwd = process.cwd();
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
  const candidates = [
    // Release-gate cutover (2026-06-05): the operator may run from the
    // RELEASE checkout, but a spawned console is an integration-tree
    // context — prefer the integration tree's scripts when declared.
    ...(integrationRoot
      ? [resolvePath(integrationRoot, 'apps', 'operator', 'scripts')]
      : []),
    // dev: started from apps/operator/, scripts is a sibling of lib/
    resolvePath(cwd, 'scripts'),
    // dev from monorepo root: papercup/
    resolvePath(cwd, 'apps', 'operator', 'scripts'),
    // standalone build: server runs from sidecar/apps/operator/
    resolvePath(cwd, '..', '..', 'scripts'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'papercup-status.mjs'))) return c;
  }
  return null;
}

/**
 * Build the superuser MCP url the engineer console's agent connects to.
 * scoped-superuser-workspace-clamp D-004: scoped-by-default bakes the concrete
 * `&workspace=`; `allWorkspaces` opts into `&workspace=*` (UNSCOPED — the only
 * door past the flag-gated dispatch clamp). Exported for unit tests.
 */
export function buildSuperuserMcpUrl(
  operatorBaseUrl: string,
  workspaceId: string,
  allWorkspaces = false,
): string {
  // WI-573: route the console's superuser MCP through the resilient proxy when the env opts in
  // (PAPERCUSP_MCP_PROXY_BASE) so it survives a :3070 deploy restart; else the operator base.
  const url = new URL(`${resolveAgentMcpBaseUrl(operatorBaseUrl)}/api/mcp`);
  url.searchParams.set('superuser', '1');
  url.searchParams.set('workspace', allWorkspaces ? '*' : workspaceId);
  return url.toString();
}

/** Read the superuser bearer token. Returns null if not yet installed. */
function readSuperuserToken(): string | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const t = readFileSync(TOKEN_PATH, 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * EI-10938 — the cwd for a workspace-only (no-slug) launch.
 *
 * This used to be `papercuspPathForWorkspace(workspaceId)`, i.e. the workspace's
 * `.papercusp` STATE dir. The comment called it "the workspace root", but it is
 * not a root and it is not code — it holds screenshots, blueprints and agent
 * state, and it is **not a git repository at all**. Every su session is a
 * workspace-only launch, so every su session's shell started there:
 *
 *   - bare `git` failed outright (`fatal: not a git repository`);
 *   - relative paths resolved into the state dir — `ls apps/` returned EMPTY
 *     rather than erroring, a silent wrong answer;
 *   - and Claude Code resets the shell cwd to the launch dir after EVERY command,
 *     so the workaround had to be repaid on every single call. Measured on one
 *     real session: 240 cwd resets, and **281 of 363 bash commands (77%)** opened
 *     with a defensive `cd`.
 *
 * A slug launch already lands in the harness's real checkout — the repo-as-cwd
 * configuration is well-trodden (it is why `.mcp.json` is gitignored at the repo
 * root). This just gives the no-slug launch the same treatment: land in the
 * workspace's HOME checkout.
 *
 * Resolution, most-authoritative first, all pre-existing helpers:
 *   1. the operator's home harness (`operatorHomeHarnessSlug()`) → its registered
 *      path, validated with `hasPapercupMarkers()` so we never cd into a non-repo;
 *   2. `detectPapercupRoot()` — honours `PAPERCUSP_INTEGRATION_ROOT` (the tree
 *      "where edits actually land") and otherwise walks up for the repo markers;
 *   3. the state dir — EXACTLY the old behaviour, so a workspace with no checkout
 *      (or an unreadable registry) is unchanged. This fix can only ever move a
 *      session from "not a repo" to "the right repo".
 */
async function resolveWorkspaceHomeCwd(workspaceId: string): Promise<string> {
  try {
    const homePath = await resolveProjectDir(operatorHomeHarnessSlug(), workspaceId);
    if (homePath && hasPapercupMarkers(homePath)) return homePath;
  } catch {
    // registry unavailable — fall through to ambient detection
  }
  const detected = detectPapercupRoot();
  if (detected) return detected;
  return papercuspPathForWorkspace(workspaceId);
}

export async function buildConsoleEnvelope(
  opts: BuildEnvelopeOpts,
): Promise<ConsoleEnvelope> {
  // 1. Resolve cwd: harness's project dir if slug given, else the workspace's
  //    HOME CHECKOUT (EI-10938 — never the .papercusp state dir).
  let cwd: string;
  let stateDir: string | null = null;
  if (opts.slug) {
    const projectDir = await resolveProjectDir(opts.slug, opts.workspaceId);
    if (!projectDir) throw new Error(`unknown harness slug: ${opts.slug}`);
    cwd = projectDir;
    stateDir = await resolveStateDir(opts.slug, opts.workspaceId);
  } else {
    // Workspace-only launch: open in the SELECTED workspace's home checkout, not
    // the global active one (opts.workspaceId may differ from activeWorkspaceId()).
    cwd = await resolveWorkspaceHomeCwd(opts.workspaceId);
  }

  const agentMcpBaseUrl = opts.agentMcpBaseUrl ?? resolveLongLivedSessionMcpBaseUrl();

  // 2. Build env — same shape as the Pi pty (PI_CODING_AGENT_DIR if
  //    we have a state dir, PAPERCUSP_HARNESS_SLUG if we have a slug,
  //    PAPERCUSP_API_BASE for callbacks), plus workspace + home so a
  //    user typing `papercup status` doesn't need to guess.
  const env: Record<string, string> = {
    ...resolveContextEnv({
      slug: opts.slug ?? '',
      stateDir,
      requestUrl: opts.operatorBaseUrl,
    }),
    PAPERCUSP_WORKSPACE: opts.workspaceId,
    // Account routing is launch-envelope state, not ambient shell state. The
    // console launch command defaults to --account=default; carry the same
    // explicit marker so psu clears inherited gateway credentials before
    // restoring the system login (EI-21575557995965463).
    PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default',
    PAPERCUSP_OPERATOR_URL: resolveAgentMcpBaseUrl(agentMcpBaseUrl),
    // A selected A/B/current-build endpoint is a pin. Clear any inherited managed
    // marker; automatically resolved desktop/proxy endpoints retain rediscovery.
    PAPERCUSP_OPERATOR_URL_PROVENANCE: opts.agentMcpBaseUrl != null ? '' : 'psu-launcher',
    // Scope HOME to the SELECTED workspace — using the global papercuspPath()
    // here was the latent bug that let a spawned agent carry
    // PAPERCUSP_WORKSPACE=<picked> alongside PAPERCUSP_HOME=<active>.
    PAPERCUSP_HOME: papercuspPathForWorkspace(opts.workspaceId),
  };
  // EI-10938: an EXPLICIT pointer to the source tree. Agents previously had
  // PAPERCUSP_HOME (the state dir) and PAPERCUSP_WORKSPACE (an id) but NOTHING
  // naming where the code lives — so every agent hard-coded an absolute repo path
  // (287 command lines in one session did exactly that) which differs per box.
  // `PAPERCUSP_REPO_ROOT` was already referenced by the coord-hook's docs but was
  // never actually set by anything; this makes it real. Only set when cwd really
  // is a checkout, so its presence is a reliable signal rather than a guess.
  if (hasPapercupMarkers(cwd)) env.PAPERCUSP_REPO_ROOT = cwd;
  // If no slug, resolveContextEnv set PAPERCUSP_HARNESS_SLUG=''; drop
  // that — empty value is worse than absent for "is this harness-scoped?".
  if (!opts.slug) delete env.PAPERCUSP_HARNESS_SLUG;

  // 2b. Pass the operator's scripts dir so the launcher one-liner can
  //     run `papercup status` without the user having anything on PATH
  //     yet. The Tauri spawner prepends this to PATH when invoking the
  //     terminal one-liner. Skipped when not resolvable (the terminal
  //     just opens without the greeting CLI in PATH).
  const scriptsDir = resolveScriptsDir();
  if (scriptsDir) env.PAPERCUSP_SCRIPTS_DIR = scriptsDir;
  // The psu/ptool shims (installPapercuspFiles) live in ~/.papercusp/bin. Pass
  // it so the spawner can prepend it to PATH — that's what makes `psu` runnable
  // from the in-app terminal (psu-in-desktop-builds-2026-06-23 A2b).
  env.PAPERCUSP_BIN_DIR = join(homedir(), '.papercusp', 'bin');

  // WI-37920 / P-001 — make the spawned window's env SELF-SUFFICIENT.
  //
  // `psu` being on PATH is not enough: psu then has to find the backend CLI
  // (`claude`/`codex`/`omp`) and RUN it, and a desktop-spawned terminal has
  // neither the operator's PATH nor an interactive shell's rc-file additions. The
  // measured failure: `omp` lives in ~/.bun/bin, a dir added by ~/.bashrc BELOW
  // its "if not running interactively, return" early-exit — and gnome-terminal
  // hands the command to a D-Bus server running under the DESKTOP session's env
  // anyway. Result: `psu: the omp backend (`omp`) is not installed` in a window
  // where `omp` demonstrably works for the human.
  //
  // Resolve HERE, where the operator's full environment is available, and carry
  // the answer as data. That is what makes this correct for every emulator (the
  // client-server ones run the command under a foreign env, the process-per-window
  // ones inherit ours) and every OS, without modelling any of them — and it fixes
  // the shebang layer for free, because the resolver also resolves `#!/usr/bin/env
  // bun`'s interpreter. Best-effort: a resolver fault must never block a launch.
  try {
    const spawnDirs = resolveSpawnPathDirs();
    if (spawnDirs.dirs.length) env[SPAWN_PATH_DIRS_ENV] = encodeSpawnPathDirs(spawnDirs.dirs);
  } catch {
    /* resolution is a safety net; never fail a launch over it */
  }


  // 3. Build the .mcp.json that the user's claude/codex agent will
  //    auto-discover when they cd here. Points at the superuser door.
  //    If the token is missing the Tauri side will install it before
  //    using this. We still emit the file shape so callers can write
  //    it after bootstrap.
  // capability:terminal passes skipMcpJson — it opens a terminal to RUN a
  // command, not to host an MCP-connected agent console, so it must not
  // displace the project's real .mcp.json. Empty contents ⇒ the spawner skips
  // writing it.
  let mcpJsonContents = '';
  let needsSuperuserBootstrap = false;
  if (!opts.skipMcpJson) {
    const token = readSuperuserToken();
    needsSuperuserBootstrap = token === null;
    // Workspace-scoped by default — superuser ctx.workspaceId defaults to
    // '*' which most first-party tools reject. Baking &workspace=<slug>
    // gives the user's agent useful defaults; tool-by-tool override via
    // args still works.
    const mcpUrl = buildSuperuserMcpUrl(agentMcpBaseUrl, opts.workspaceId, opts.allWorkspaces);
    mcpJsonContents = JSON.stringify(
      {
        mcpServers: {
          papercusp: {
            url: mcpUrl,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          },
        },
      },
      null,
      2,
    );
  }

  // plan-agent-launch P-023: a resume launch reuses the same shell
  // shape (cwd, env, .mcp.json, superuser bootstrap), but lands the
  // user in the live agent CLI via `-r <sessionId>` instead of a
  // plain shell. Default greeting stays unchanged for normal launches.
  let greetingCmd = 'papercup status 2>/dev/null || true';
  let coordOwnerId: string | null = null;
  if (opts.runCommand) {
    // capability:terminal — run the caller's command verbatim, arbitrary by
    // design (same trust model as capability:bash). buildConsoleOneliner
    // single-quote-escapes + subshell-wraps it, so quotes/pipes/multiline
    // survive into `bash -lc '…'`. Wins over runPsu/resume when set.
    greetingCmd = opts.runCommand;
  } else if (opts.runPsu && !opts.resumeSessionId && (await getFlag(FLAGS.PSU_END_USER, 'system'))) {
    greetingCmd = 'psu';
  } else if (opts.resumeSessionId) {
    const id = shellSafeId(opts.resumeSessionId);
    // Resolve THIS session's backend from its OWN adv_sessions row — NOT the
    // operator's AGENT_CMD/AGENT_BACKEND env. Those env vars describe how the
    // operator spawns HEADLESS agents and are irrelevant to which CLI a given
    // recorded session belongs to. TWO owner-hit bugs (2026-07-11, resume+fork
    // "still failed") both traced to the old env-based resolution:
    //   1. resolveAgentBin() returned AGENT_CMD VERBATIM — here "claude -p
    //      [--model haiku]". The "-p" is PRINT / non-interactive mode, so the
    //      greeting `claude -p … -r <id>` printed once and EXITED — the resumed
    //      terminal died on the spot (and on the wrong model). An INTERACTIVE
    //      resume must exec the BARE binary with no -p / automation flags.
    //   2. a codex/omp session would have resumed under whatever CLI the env
    //      named rather than its own.
    const agentToBackend = (
      agent: string | null | undefined,
    ): ReturnType<typeof resolveBackend> | null => {
      switch ((agent ?? '').toLowerCase()) {
        case 'claude':
        case 'claude-code':
          return 'claude-code';
        case 'omp':
        case 'pi':
          return 'omp';
        case 'codex':
          return 'codex';
        default:
          return null;
      }
    };
    // Fetch the row up-front — it drives BOTH the backend choice and the
    // CLAUDE_CONFIG_DIR/cwd resolution below.
    let row: Awaited<ReturnType<typeof advSessionsByTranscriptHandles>>[number] | undefined;
    try {
      const rows = await advSessionsByTranscriptHandles({ sessionIds: [opts.resumeSessionId] });
      row = rows[0];
    } catch { /* best-effort — fall back to env-derived backend below */ }
    coordOwnerId = row?.coordOwnerId?.trim() || null;
    // The session's OWN agent wins; env is only a fallback when the row is gone.
    const backend = agentToBackend(row?.agent) ?? resolveBackend({ promptText: '' });
    // A console fork is a new psu process, so it must carry the source session's
    // explicit account route across the resume boundary. Without this, the
    // envelope's default marker and psu's default resume choice silently undo an
    // ACCOUNT-pill auto/pin selection (EI-21593716361630275).
    const accountRoute = backend === 'claude-code'
      ? wakeAccountRouteFromArgv(row?.launchArgv, coordOwnerId)
      : null;
    if (accountRoute) Object.assign(env, accountRoute.env);
    // BARE interactive binary for the backend — deliberately NOT resolveAgentBin
    // (that returns the operator's "-p"/automation-model AGENT_CMD).
    const bin = backend === 'omp' ? 'omp' : backend === 'codex' ? 'codex' : 'claude';
    // WI-3882: forking a LIVE session must NOT resume it in place — that opens a
    // second CLI on the SAME transcript and collides with the still-running
    // original. Only claude has `--fork-session`; omp/codex refuse a fork rather
    // than silently degrade to a colliding plain resume.
    if (opts.fork && backend !== 'claude-code') {
      throw new Error(
        `cannot fork a ${bin} session: only claude sessions support --fork-session on the console resume path`,
      );
    }
    // WI-6510: a model spec only reaches the CLI through psu, which is the claude
    // branch below. codex/omp exec the bare interactive binary and would silently
    // drop it — resuming on the OLD model while the UI reported the new one, which
    // is plan D-002's silent no-op exactly. Refuse loudly instead (same posture as
    // the fork/headless guards); the control gates itself on claude too.
    if (opts.resumeModel && backend !== 'claude-code') {
      throw new Error(
        `cannot set a model on a ${bin} resume: only claude sessions resume through psu, which is what carries --model`,
      );
    }
    // "Resume in GUI" (resume-in-gui-button-2026-08-09): a HEADLESS resume is only
    // coherent when the resume routes through psu, which is the claude branch below.
    // codex/omp exec the bare interactive CLI — no coord presence, no injectable pty —
    // so windowless they would be an unreachable process rather than an agent you can
    // chat to in the HUD. Refuse loudly (same posture as the fork guard above) instead
    // of spawning something the GUI can never talk to.
    if (opts.headless && backend !== 'claude-code') {
      throw new Error(
        `cannot resume a ${bin} session in the GUI: only claude sessions resume through psu, which is what supplies the presence + injectable pty the GUI conversation needs`,
      );
    }
    // WI-3988/WI-3989: `claude -r <id>` only finds the conversation with the SAME
    // CLAUDE_CONFIG_DIR + cwd the original agent used. papercusp runs each claude
    // agent in a per-session ISOLATION home (~/.papercusp/session-claude/<owner>,
    // keyed by coord owner id), and the move-inactive-to-PG lifecycle archives +
    // deletes an ended session's on-disk jsonl. So point claude at the session's
    // isolation home + original cwd, rematerializing an archived transcript from
    // PG first. Best-effort — on any miss we fall through to a bare -r.
    if (backend === 'claude-code' && row) {
      // Point claude at the session's isolation config dir so `-r` reads the
      // right conversation store (not the default ~/.claude).
      if (row.coordOwnerId) env.CLAUDE_CONFIG_DIR = sessionClaudeConfigDir(row.coordOwnerId);
      // Land in the session's ORIGINAL project dir — claude scopes resume by cwd.
      // Only override when it still exists (an ended session's cwd may be gone).
      if (row.cwd && existsSync(row.cwd)) cwd = row.cwd;
      // An ENDED session's jsonl was archived + deleted after death — rematerialize
      // it from PG (session_archives) first. Lazy import: session-archive fails
      // LOUD at import when zstd is unavailable, so keep that off this module's
      // load path. A LIVE session isn't archived → rematerialize is a no-op miss.
      try {
        const { pgSessionArchiveStore, rematerializeSession } = await import('./session-archive');
        await rematerializeSession(
          { sourceKind: 'claude', sessionId: opts.resumeSessionId },
          pgSessionArchiveStore(),
        );
      } catch { /* best-effort — nothing to restore / archive unavailable */ }
      // EI-12938 (owner-hit 2026-07-16, "psu --resume still prompted me to
      // login"): the dir we just pointed at may not be LAUNCH-READY. The archive
      // holds only the transcript, and a plan-run/bee dir was built minimal by
      // `writeSpawnClaudeConfig` (creds symlink only) — either way there is no
      // `.claude.json`, so the interactive claude below boots the FIRST-RUN
      // wizard (/login) despite a healthy system login, then mints a stub config
      // that makes the NEXT attempt "work" while silently running with no MCP
      // servers and no lock hooks. Re-ensure the interactive dir before handing
      // it to a human. Deliberately OUTSIDE the rematerialize try: a
      // never-archived bee dir needs this exactly as much as a restored one, and
      // it must not be skipped just because there was nothing to restore.
      // No-ops on an already-healthy dir; never throws.
      if (row.coordOwnerId) {
        const { ensureInteractiveClaudeConfig } = await import('./interactive-claude-config');
        ensureInteractiveClaudeConfig({ sid: row.coordOwnerId });
      }
    }
    const verb = opts.fork ? 'forking' : 'resuming';
    if (backend === 'claude-code') {
      // WI-4159 (owner-hit 2026-07-11, "resume/fork asked me to /login"): a bare
      // `claude -r` under the session's ISOLATED CLAUDE_CONFIG_DIR (set above)
      // prompts /login — the isolation dir carries the credential SYMLINK
      // (claude-credential-sync) but NOT the account state (~/.claude.json) claude
      // needs to consider itself signed in. psu-launcher's OWN resume path does the
      // per-session CLAUDE_CONFIG_DIR→credential RELOCATION (psu-launcher
      // L1910/3499/3652-3655) that makes the isolated dir authenticated — the exact
      // auth setup a fresh psu launch uses (and why a psu-launched session never
      // sees /login). So route the claude resume/fork THROUGH psu (reuse psu's
      // proven, auth-correct resume) rather than reimplementing its credential
      // dance here. psu resolves the session by id across the isolation dirs,
      // re-derives + points CLAUDE_CONFIG_DIR at it (overriding whatever we set
      // above), relocates creds, parks any role-scoped .mcp.json (identity-leak
      // fix), reactivates the adv row, and resumes with the frictionless posture.
      // ⚠ EI-12938 corrects one assumption in the paragraph above: psu's resume
      // heals `.credentials.json` ONLY. Credentials are not account state — the
      // /login artifact ALSO needs `.claude.json`, which only the interactive
      // mirror provides. That is why the ensure above is not redundant with
      // routing through psu (psu re-ensures too, via the operator, for a
      // hand-typed `psu --resume`; both legs are idempotent).
      // Fork is claude-only (psu `--fork`, guarded above). psu is on PATH via the
      // ~/.papercusp/bin shim. The rematerialization above still seeds an archived
      // transcript into the isolation dir so psu's `--resume=<id>` finder locates
      // an ended session.
      const forkFlag = opts.fork ? ' --fork' : '';
      // WI-6510: resume on a DIFFERENT model. psu honors --model on a resume exactly
      // as on a fresh launch (resumeArgsFor, WI-3758), so the conversation carries.
      // The spec is already composed (`<model>[:<effort>]`) — psu has no separate
      // effort flag, and emitting one would be a silent no-op.
      const modelFlag = opts.resumeModel ? ` --model=${shellSafeModelSpec(opts.resumeModel)}` : '';
      // resume-in-gui-button-2026-08-09: `--headless` keeps psu's managed pty ON with
      // non-TTY stdio (and implies --no-picker), which is what makes a windowless
      // resume still injectable — i.e. still something the HUD conversation composer
      // can wake. psu publishes the headless posture (PAPERCUSP_PSU_HEADLESS=1) BEFORE
      // it dispatches the resume, so the flag composes with --resume rather than
      // racing it (psu-launcher main(): headless at L7142, resume branch at L7161).
      // Appended LAST so a headed resume's greeting stays byte-identical to today's.
      const headlessFlag = opts.headless ? ' --headless' : '';
      const accountValue = accountRoute
        ? accountRoute.mode === 'pin' ? accountRoute.accountId : accountRoute.mode
        : null;
      const accountFlag = accountValue ? ` --account=${shellSafeAccount(accountValue)}` : '';
      greetingCmd = `echo "${verb} plan-run ${id}…"; exec psu --resume=${id}${forkFlag}${headlessFlag}${modelFlag}${accountFlag}`;
    } else {
      // codex/omp: keep the bare interactive binary. The /login artifact is
      // claude-CLAUDE_CONFIG_DIR-specific; these backends authenticate from their
      // own per-session home (CODEX_HOME / omp store) and don't hit it. Permission
      // posture is per-INVOCATION — a bare resume otherwise lands in ask-per-tool
      // mode (owner-hit 2026-07-07); fork is already guarded to claude-only above.
      const bypass = backend === 'omp' ? '--approval-mode yolo ' : '';
      greetingCmd = `echo "${verb} plan-run ${id}…"; exec ${bin} ${bypass}-r ${id}`;
    }
  }

  return {
    cwd,
    env,
    mcpJsonContents,
    greetingCmd,
    needsSuperuserBootstrap,
    sessionId: randomUUID(),
    coordOwnerId,
  };
}

/**
 * Validate a session id is safe to embed in a shell greeting. We
 * mint these as `crypto.randomUUID()` so the alphabet is
 * `[0-9a-f-]`. Reject anything else rather than try to escape — a
 * malformed id is a bug to fix, not data to sanitise. Exported for
 * unit testing.
 */
export function shellSafeId(id: string): string {
  if (!/^[0-9a-f-]+$/i.test(id)) {
    throw new Error(`refusing to embed unsafe session id: ${id.slice(0, 32)}`);
  }
  return id;
}

/** Validate a persisted account selector before embedding it in a shell greeting. */
export function shellSafeAccount(account: string): string {
  const s = account.trim();
  if (!s || !/^[A-Za-z0-9._:=@/,+-]+$/.test(s)) {
    throw new Error(`refusing to embed unsafe account: ${account.slice(0, 40)}`);
  }
  return s;
}

/**
 * Validate a `<model>[:<effort>]` spec before it is embedded in the resume
 * greeting. Same reject-rather-than-escape posture as {@link shellSafeId}, and
 * for the same reason: this string reaches a `bash -lc` command line.
 *
 * The alphabet is the one real specs use — `opus[1m]:high`, `sonnet[1m]`,
 * `gpt-5.6-luna:high`, `claude-opus-5@default`. Note `[` and `]` are IN it (the
 * 1m-window marker) and are shell GLOB characters, so the value is also
 * single-quoted on the way out; validation alone would leave the greeting
 * dependent on the surrounding quoting staying correct forever.
 *
 * Deliberately NOT `isValidModelSpec` — that one is documented as loose on the
 * model id, which is right for a config field and wrong for a shell argument.
 * Exported for unit testing.
 */
export function shellSafeModelSpec(spec: string): string {
  const s = spec.trim();
  if (!s || !/^[A-Za-z0-9._@:[\]-]+$/.test(s)) {
    throw new Error(`refusing to embed unsafe model spec: ${spec.slice(0, 40)}`);
  }
  return `'${s}'`;
}
