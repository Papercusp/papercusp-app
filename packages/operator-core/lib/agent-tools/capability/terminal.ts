/**
 * capability:terminal — open a NEW terminal window (or MANY) on the USER'S
 * DESKTOP and run a command in each. The visible-terminal sibling of
 * capability:bash.
 *
 * Two forms:
 *   - single: { command, cwd?, label? }            → one window
 *   - bulk:   { terminals: [{command,cwd?,label?}] } → N windows in ONE call
 * Agent launches have their own purpose-built doors: capability:launch-agent
 * for the general case, and fleet:launch-on-plan for N members on a plan.
 *
 * Reuses the maintained console machinery instead of forking a spawner:
 *   buildConsoleEnvelope({ skipMcpJson }) → the base envelope (cwd/env)
 *   spawnConsole({ envelope: {…, greetingCmd} }) → the OS new-window spawn
 * (lib/console-launcher.ts + lib/console-spawn.ts — the same path the global
 * "+" console button uses.)
 *
 * Trust model: identical tier/role gating to capability:bash (arbitrary command,
 * no confirmation). DELIBERATE difference — the whole point is a visible terminal
 * in the user's REAL desktop session, so this runs OUTSIDE the bwrap exec-sandbox
 * that contains capability:bash. Recorded on capability-terminal-tool-2026-06-29.
 *
 * Cross-platform: server-side spawn works on Linux + macOS at this tier — on
 * macOS the operator opens Terminal/iTerm directly (see console-spawn.ts). On
 * Windows the operator runs inside WSL and cannot spawn a Session-1 window
 * itself; `allowDesktopBridge` (WI-3289) relays the spawn to the desktop
 * shell's Tauri `console_launch` command over the sync-bus bridge
 * (console-launch-bridge.ts), so agent-opened terminals work there too —
 * provided the Papercusp desktop window is open (otherwise: a loud timeout).
 *
 * Output is NOT captured — the terminals are interactive and detached. Use
 * capability:bash when you need a command's output / exit code.
 */
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole } from '../../console-spawn';
import {
  classifyAgentLaunchCommand,
  injectAccountArg,
  injectFleetArg,
  injectLaunchedByArg,
} from '../../agent-launch-core';
import { activeWorkspaceId } from '../../workspace-registry';
import { fleetSlugFromName, getFleetScheme } from '../../agent-fleets-store';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveSpawnHostOperatorBaseUrl } from '../../mcp-base-url';
import type { ColorScheme } from '../../console-color-schemes';

/** Opening more than this many desktop windows in one call is almost certainly a
 *  mistake (and is heavy); cap it. A fleet larger than this should be spawned in
 *  batches. */
const MAX_TERMINALS = 12;

/**
 * The operator's own base URL, used for the terminal's PAPERCUSP_OPERATOR_URL /
 * API-callback env. `PAPERCUSP_OPERATOR_URL` is commonly set to the full
 * `…/api/mcp` endpoint, so strip that suffix back to the bare origin.
 */
// WI-6154: this-host identity (PAPERCUSP_HONO_PORT) must win over an inherited
// PAPERCUSP_OPERATOR_URL — see resolveSpawnHostOperatorBaseUrl's doc for why.
const resolveOperatorBaseUrl = resolveSpawnHostOperatorBaseUrl;

const terminalSpec = z.object({
  command: z
    .string()
    .min(1)
    .describe('The command to run in this terminal (bash). Runs verbatim, then the terminal drops to an interactive shell.'),
  cwd: z
    .string()
    .optional()
    .describe('Working dir for this terminal (absolute, or relative to the harness project dir).'),
  label: z
    .string()
    .optional()
    .describe('Display label for this terminal (shown in /adv/sessions and the window title).'),
});

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export default defineTool({
  name: 'capability:terminal',
  description:
    "Open a NEW terminal window on the user's desktop and run an arbitrary command in it — or open MANY command windows at once with `terminals: [...]`. Each command runs, then its terminal drops to an interactive shell (stays open). For agents, use capability:launch-agent; for N agents on a plan, use fleet:launch-on-plan. For headless execution with captured output, use capability:bash.",
  guidance: {
    when: 'ARBITRARY-COMMAND WINDOW ONLY: open one or more visible desktop terminals for a dev server, REPL, installer, `tail -f`, or another command the user should watch or interact with.',
    notWhen:
      'Do NOT use this to launch agents: use capability:launch-agent for the general visible/headless/fleet/unfleeted launch, or fleet:launch-on-plan for N agents on a plan. For headless command execution with captured output / exit code, use capability:bash. Full decision table: /internal/docs/agent-insights/launching-agents-which-tool-for-which-door.',
    chaining:
      'Returns immediately after spawning — it does NOT wait for the commands and has no output channel. Use EITHER `command` (single) or `terminals` (bulk, max 12), not both.',
    seeAlso: [
      'capability:launch-agent (launch, resume, or fork agents — the flexible superset)',
      'capability:bash (headless execution with captured output / exit code)',
      'fleet:launch-on-plan (spawn desktop fleet members that auto-join + kickoff)',
    ],
  },
  capability: 'capability:terminal',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    command: z
      .string()
      .min(1)
      .optional()
      .describe('Single-terminal form: the command to run. Use EITHER `command` or `terminals`.'),
    cwd: z.string().optional().describe('Single-terminal form: working dir (absolute, or relative to the harness project dir).'),
    label: z.string().optional().describe('Single-terminal form: display label for the terminal.'),
    terminals: z
      .array(terminalSpec)
      .min(1)
      .max(MAX_TERMINALS)
      .optional()
      .describe(`Bulk form: open N terminals (one per entry, max ${MAX_TERMINALS}) in a single call. Use EITHER \`command\` or \`terminals\`.`),
    fleet: z
      .string()
      .optional()
      .describe(
        "Optional fleet name or slug — every terminal in this call uses that fleet's permanently-bound color scheme, and any `psu` command in it auto-joins that fleet (--fleet=<slug> injected). When omitted, the tool automatically resolves your OWN presence-fleet (if you are a fleet member) for both color AND `psu` membership (WI-4234) — so a bare `psu ...` spawned by a fleet leader/member joins the caller's fleet by default. Pass an explicit `fleet` to OVERRIDE which fleet a spawned `psu` joins, or to color/join a fleet you are not currently a member of. Prefer `fleet:launch-on-plan` over hand-rolling a fleet spawn here when you can — it also seeds plan/launch-context.",
      ),
    display: z
      .string()
      .optional()
      .describe(
        "WI-4272 (demo/recording): open EVERY terminal in this call on this X display (e.g. ':110' — a computer:provision_desktop sandbox stage being recorded) instead of the owner's desktop seat. Linux only; requires a DISPLAY-honoring emulator (xterm/alacritty/kitty/wezterm) and the display's X socket to be alive (loud-fail otherwise). Omit for normal visible-desktop use.",
      ),
  }),
  async handler(args, ctx) {
    // Normalize the single | bulk forms to one items[] list.
    if (args.terminals && args.command) {
      return err('Provide EITHER `command` (single) or `terminals` (bulk), not both.');
    }
    const items = args.terminals ?? (args.command ? [{ command: args.command, cwd: args.cwd, label: args.label }] : []);
    if (items.length === 0) {
      return err('Provide a `command` (single terminal) or `terminals: [...]` (bulk).');
    }

    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    // Treat the unscoped wildcard like "no harness" (workspace-only launch) —
    // mirrors the workspaceId === '*' guard above. An unscoped su session has
    // harnessSlug '*', which buildConsoleEnvelope would otherwise reject as an
    // "unknown harness slug". (capability-terminal-unscoped-slug-fix-2026-06-30)
    const slug = ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null;

    // Build the base envelope ONCE (cwd/env), skipping the superuser .mcp.json —
    // this tool runs commands, it does not host an MCP-connected agent console.
    let base;
    try {
      base = await buildConsoleEnvelope({
        workspaceId,
        slug,
        operatorBaseUrl: resolveOperatorBaseUrl(),
        skipMcpJson: true,
      });
    } catch (e: any) {
      return err(`Failed to prepare terminal(s): ${e?.message ?? e}`);
    }

    // solo-launch-provenance: the CALLER is the launcher — resolve once (best-effort)
    // so every psu command spawned here carries `--launched-by=<caller ownerId>`.
    let callerOwnerId: string | null = null;
    try {
      callerOwnerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      callerOwnerId = null;
    }

    // Resolve the fleet's permanently-bound color scheme AND the fleet a spawned
    // `psu` command should JOIN. Precedence: explicit `fleet` arg → caller's
    // shared_presence fleet_slug → null. Color is cosmetic — a lookup failure
    // must never block the launch. `fleetSlug` drives BOTH the colour lookup
    // AND the `--fleet` membership injection below, so they can never diverge —
    // this now ALSO covers the inferred (no explicit `fleet` arg) case (WI-4234):
    // previously only an explicit `fleet` arg reached injectFleetArg, so a fleet
    // leader/member hand-rolling a bare `psu` spawn via this tool (instead of
    // fleet:launch-on-plan) got fleet-colored windows whose agents never actually
    // JOINED the fleet — no plan/launch-context, and no WI-2185 auto wake-mode
    // pin (which only fires once bootstrap-su sees a real fleetSlug), so the
    // spawned member inherited whatever the GLOBAL wake-mode default was and its
    // leader's steering wakes silently STAGED instead of landing.
    let fleetSlug: string | null = args.fleet ? fleetSlugFromName(args.fleet) : null;
    let scheme: ColorScheme | null = null;
    if (fleetSlug) {
      // Explicit fleet name wins.
      try {
        scheme = await getFleetScheme(workspaceId, fleetSlug);
      } catch {
        scheme = null;
      }
    } else if (callerOwnerId) {
      // Fallback: resolve from the caller's shared_presence fleet_slug so every
      // terminal a fleet member opens inherits their fleet's color (capability-
      // terminal fleet-color-schemes-2026-06-30 P-003) AND membership (WI-4234)
      // without an explicit `fleet` arg.
      try {
        const fleetMap = await fetchPresenceFleet([callerOwnerId]);
        const membership = fleetMap.get(callerOwnerId);
        if (membership?.fleetSlug) {
          fleetSlug = membership.fleetSlug;
          scheme = await getFleetScheme(workspaceId, membership.fleetSlug);
        }
      } catch {
        scheme = null;
      }
    }

    const opened: Array<{
      command: string;
      cwd: string;
      terminal: string;
      pid: number | null;
      display: string | null;
      desktopEnvResolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' | 'caller-override' | null;
    }> = [];
    const failed: Array<{ command: string; error: string; code: number }> = [];

    // ── P-004: WRONG-DOOR guard ──────────────────────────────────────────────
    //
    // Refuse BEFORE any window opens (not per-item inside the spawn fan-out), so a
    // mixed batch never leaves half its terminals up. This door hardcodes
    // preferProcessPerWindow:true → xterm, skips the backend preflight (P-002) and
    // the agent-started verification (P-003); an agent launched through it is
    // unsupervised and lands in the wrong emulator. That is how the owner's two
    // omp launches failed.
    const misrouted = items
      .map((item, i) => ({ i, item, cls: classifyAgentLaunchCommand(item.command) }))
      .filter((x) => x.cls.isAgentLaunch);
    if (misrouted.length > 0) {
      const first = misrouted[0];
      return err(
        `Wrong door: that is an agent launch, not a command.\n\n` +
          `  ${first.item.command}\n\n` +
          `capability:terminal is the arbitrary-COMMAND door. It forces a process-per-window ` +
          `emulator (xterm) rather than your normal one, and it does NOT preflight the backend ` +
          `CLI or verify the agent actually started — so a launch through here can report success ` +
          `with a dead window, which is exactly the failure WI-37920 documents.\n\n` +
          `Use capability:launch-agent instead:\n` +
          (first.cls.mode === 'resume'
            ? `  capability:launch-agent { resume: { agentId: '<agent>' }, brief: '<their next turn>' }\n`
            : `  capability:launch-agent { brief: '<the agent's first turn>', agent: '<claude|codex|omp>' }\n`) +
          `For N agents on a plan, fleet:launch-on-plan { name, plan, count }.\n\n` +
          (misrouted.length > 1 ? `(${misrouted.length} of ${items.length} commands are agent launches.)\n` : '') +
          `Genuinely need a non-launch \`psu\` invocation here (\`psu --help\`, \`psu --version\`)? ` +
          `Those are not refused — only an actual agent launch is.`,
      );
    }

    let fleetInjected = false;
    let launchedByInjected = false;
    // Spawn all windows CONCURRENTLY: spawnConsole is async since WI-1886 (it
    // watches each child for an early off-screen death) — serializing N spawns
    // would stack N probe windows.
    const results = await Promise.all(
      items.map(async (item) => {
        const cwd = item.cwd
          ? isAbsolute(item.cwd)
            ? item.cwd
            : resolvePath(base.cwd, item.cwd)
          : base.cwd;
        // With an explicit `fleet`, a psu launch JOINS it (membership), not just colour.
        const fleetInj = injectFleetArg(item.command, fleetSlug);
        // solo-launch-provenance: every psu launch carries WHO launched it.
        const provInj = injectLaunchedByArg(fleetInj.command, callerOwnerId);
        // A psu RESUME spawned from a tool must pin its account (P-012, owner-hit
        // 2026-07-12): `resumeAccountPlan` prompts an interactive account picker
        // whenever a resume carries neither `--account` nor `--no-picker`, so a
        // tool-spawned `psu --resume=<id>` sat on a picker (and then a login
        // screen) waiting for a human who had no idea it was asking. Fresh
        // launches are left alone — their account routing (pool/auto) is chosen
        // server-side and must not be overridden here.
        const acctInj = /(^|\s)--resume(=|\s)/.test(provInj.command)
          ? injectAccountArg(provInj.command, 'default')
          : { command: provInj.command, injected: false };
        const command = acctInj.command;
        // Override the greeting per terminal (runs the command, then drops to a shell).
        const result = await spawnConsole({
          envelope: { ...base, greetingCmd: command, cwd },
          label: item.label ?? null,
          writeMcpJson: false,
          scheme,
          // WI-3289: on a Windows desktop host, relay to the desktop shell's
          // Tauri console_launch instead of hard-501ing the agent.
          allowDesktopBridge: true,
          // EI-11543: capability:terminal's WHOLE CONTRACT is to RELIABLY RUN an
          // arbitrary command in a visible window. On a real desktop box the
          // server-side CLIENT-SERVER terminal (gnome-terminal → gnome-terminal-
          // server via the D-Bus factory) is UNRELIABLE at exactly that: a plain
          // `echo … > /tmp/x` opened a gnome-terminal window on the seat but never
          // ran (the factory dropped the command); the same fragility surfaced in
          // EI-11578 (a resumed psu managed-pty host dies under gnome-terminal-
          // server's pty/env handoff). PROCESS-PER-WINDOW emulators
          // (xterm/alacritty/kitty/wezterm) bind DISPLAY directly and exec the
          // command themselves — no factory, no bus, no pty handoff — so they
          // reliably run it (proven: the reporter's own xterm fallback worked, and
          // capability:launch-agent's resume/fork path already forces this exact
          // ordering, launch-agent.ts `preferProcessPerWindow: isResume`). Force
          // it here so an arbitrary command always lands in a terminal that runs
          // it, instead of a client-server window that may silently swallow it.
          // (The window is still visible on the owner's seat with fleet colors —
          // the OSC prelude works in xterm/alacritty exactly the same.)
          preferProcessPerWindow: true,
          // WI-4272: caller-pinned demo-stage display (skips seat resolution).
          displayOverride: args.display,
        });
        return { command, cwd, injected: fleetInj.injected, provenanceInjected: provInj.injected, result };
      }),
    );
    for (const r of results) {
      if (r.injected) fleetInjected = true;
      if (r.provenanceInjected) launchedByInjected = true;
      if (r.result.status === 'ok') {
        opened.push({
          command: r.command,
          cwd: r.cwd,
          terminal: r.result.terminal,
          pid: r.result.pid,
          display: r.result.display,
          desktopEnvResolvedVia: r.result.desktopEnvResolvedVia,
        });
      } else {
        failed.push({ command: r.command, error: r.result.error, code: r.result.code });
      }
    }

    const lines: string[] = [];
    if (opened.length) {
      const schemeNote = scheme
        ? args.fleet
          ? ` (fleet scheme: ${scheme.name})`
          : ` (fleet scheme: ${scheme.name} — from your presence fleet)`
        : '';
      lines.push(`Opened ${opened.length} terminal${opened.length > 1 ? 's' : ''}${schemeNote}:`);
      for (const o of opened) {
        const displayNote = o.display ? ` [DISPLAY=${o.display}]` : '';
        lines.push(`  • ${o.terminal} (pid ${o.pid ?? '?'}) in ${o.cwd}${displayNote} — ${o.command}`);
      }
      // EI-8289: a socket-scan placement means no real logged-in seat was found —
      // the window MAY have landed on a virtual/sandbox display instead of the
      // owner's real desktop. Disclose this loudly instead of reporting a bare
      // "opened" that silently strands the owner's supervision.
      if (opened.some((o) => o.desktopEnvResolvedVia === 'socket-scan')) {
        lines.push(
          '  ⚠ no active login seat was detected (who) — the DISPLAY above was picked by a raw X11 ' +
            'socket scan and MAY be a virtual/sandbox display rather than your real desktop (EI-8289). ' +
            'If you cannot see the window(s), tell me and I will re-check `who` / your active seat.',
        );
      }
      // WI-4272: an explicit `display` arg is an INTENTIONAL sandbox/demo-stage
      // placement — disclose it plainly (the window is NOT on the owner's seat).
      if (opened.some((o) => o.desktopEnvResolvedVia === 'caller-override')) {
        lines.push(
          `  ↳ opened on caller-specified display ${args.display} (demo-stage override, WI-4272) — ` +
            "NOT the owner's desktop seat; visible in the sandbox recording/screenshot, not on screen.",
        );
      }
      if (fleetInjected) {
        lines.push(
          `  ↳ auto-added \`--fleet=${fleetSlug}\` to psu launch(es) so the spawned agents JOIN the fleet (membership, not just colour). EI-5835.`,
        );
      }
      if (launchedByInjected) {
        lines.push(
          `  ↳ auto-added \`--launched-by=${callerOwnerId}\` to psu launch(es) — the spawned agents know YOU launched + supervise them (system prompt + standing fact).`,
        );
      }
    }
    if (failed.length) {
      lines.push(`${failed.length} failed:`);
      for (const f of failed) lines.push(`  • ${f.command} — ${f.error}`);
      if (failed.some((f) => f.code === 501 || f.error.includes('desktop-bridge'))) {
        lines.push(
          '(On Windows the spawn is relayed to the desktop shell via the sync-bus bridge (WI-3289) — the Papercusp desktop window must be OPEN for the relay to land. macOS + Linux spawn server-side directly.)',
        );
      }
    }
    lines.push(
      'Terminals stay open as interactive shells after their command; output is NOT captured — use capability:bash if you need results.',
    );

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      isError: opened.length === 0,
    };
  },
});
