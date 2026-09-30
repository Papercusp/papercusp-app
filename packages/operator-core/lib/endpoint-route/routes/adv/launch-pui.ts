/**
 * POST /api/adv/sessions/launch-pui — open the `pui` ratatui workbench
 * (apps/tui) in an OS-native terminal. The desktop equivalent of typing
 * `pui workbench`: the operator host (which on the desktop runs inside the
 * user's GUI session) server-spawns a terminal running `pui workbench`, which
 * materializes the zellij workbench layout and connects to THIS operator.
 * The launch explicitly hands the operator base to the child; relying on the
 * shared ~/.papercusp/endpoint-ipc.json singleton is unsafe when multiple
 * operators share a home directory (it is last-writer-wins).
 *
 * Mirrors launch-su.ts: Linux-only server-side spawn via the shared
 * `terminal-spawn` helper (D-001). Same-origin (the header that calls this is
 * served by the operator) — no CORS preamble needed.
 *
 * NO interactive safety floor here, deliberately (unify-agent-spawn-chokepoint
 * P-012): the floor guards AGENT concurrency (`maxSimultaneousAgents`), and the
 * pui workbench is a TUI dashboard — it consumes no agent slot and makes no
 * provider calls. launch-su.ts (which spawns a real agent session) passes
 * `checkInteractiveSafetyFloor`; this route is intentionally outside it.
 *
 * Plan: desktop-pui-launch-button-2026-06-05 (Brief 26).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { defineTool } from '@papercusp/agent-mcp';
import { resolveSpawnHostOperatorBaseUrl } from '../../../mcp-base-url';
import { isOnPath, shellEscape, spawnInTerminal } from '../../../terminal-spawn';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Resolve the `pui` binary. It installs to `~/.cargo/bin/pui`, which the
 * shared isOnPath() does NOT probe — so check the cargo + local bins
 * explicitly, then fall back to a bare `pui` on PATH (D-003).
 */
interface BundledPuiPaths {
  bin: string;
  companion: string;
  manifest: string;
}

function bundledPuiPaths(env: NodeJS.ProcessEnv): BundledPuiPaths | null {
  const sidecarBin = env.PAPERCUSP_SIDECAR_BIN?.trim();
  if (!sidecarBin) return null;
  const root = dirname(sidecarBin);
  return {
    bin: join(sidecarBin, 'pui'),
    companion: join(root, 'pui-companion.wasm'),
    manifest: join(root, 'pui-install.json'),
  };
}

function resolvePuiBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const bundled = bundledPuiPaths(env);
  const candidates = [
    ...(bundled ? [bundled.bin] : []),
    join(homedir(), '.cargo', 'bin', 'pui'),
    join(homedir(), '.local', 'bin', 'pui'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return isOnPath('pui') ? 'pui' : null;
}

/**
 * Build the child environment for a pui launched by THIS operator.
 *
 * `PUI_OPERATOR` is deliberately re-derived from the launching host rather
 * than inherited. A staging operator can inherit a stale `PAPERCUSP_OPERATOR_URL`
 * from the live operator's `.env.local`, and an unscoped pui can select whichever
 * operator last rewrote the shared IPC discovery file. The pui's explicit URL
 * selection then makes every HUD pane use the same HTTP endpoint/database as the
 * `tui:dispatch` call that controls it.
 */
export function puiLaunchEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const operatorBase = resolveSpawnHostOperatorBaseUrl(env);
  const bundled = bundledPuiPaths(env);
  return {
    ...env,
    // Keep the conventional child callback identity correct for any helper
    // launched from a pui pane as well.
    PAPERCUSP_OPERATOR_URL: operatorBase,
    // apps/tui accepts a full http(s) URL here and uses it as an explicit
    // selection, bypassing ambiguous IPC discovery.
    PUI_OPERATOR: operatorBase,
    // A vm-release operator already carries the matched PUI generation in its
    // signed sidecar. Pin the child to that companion + manifest rather than a
    // stale user-home install inherited from the service environment.
    ...(bundled
      ? {
          PUI_COMPANION_WASM: bundled.companion,
          PUI_INSTALL_MANIFEST: bundled.manifest,
        }
      : {}),
  };
}

const launchPui = defineTool({
  method: 'POST',
  path: '/adv/sessions/launch-pui',
  auth: 'loopback',
  async handler() {
    if (process.platform !== 'linux') {
      return json({ status: 'error', error: 'server-side spawn only implemented for Linux' }, 501);
    }

    const puiBin = resolvePuiBin(process.env);
    if (!puiBin) {
      return json(
        {
          status: 'error',
          code: 'pui_not_installed',
          error: '`pui` not found — install the matched TUI + companion generation (./apps/tui/scripts/install-update.sh)',
        },
        200,
      );
    }

    // `pui workbench` materializes the zellij layout + connects to the
    // launching operator selected above. `bash -lc` (login shell, inside
    // spawnInTerminal) puts ~/.cargo/bin on PATH so pui's own `zellij` spawn
    // resolves. `puiBin` is a fixed resolved path — shellEscape guards it.
    const oneliner = `exec ${shellEscape(puiBin)} workbench`;
    const spawned = await spawnInTerminal({ oneliner, env: puiLaunchEnv() });
    if (!spawned.ok) {
      return json({ status: 'error', error: spawned.error }, 500);
    }
    // EI-18696184925888288: see launch-su.ts's identical check — the spawn
    // syscall not throwing doesn't confirm a window actually opened.
    const warning = spawned.likelyOpened
      ? undefined
      : 'the spawned terminal process exited almost immediately — it may not have opened a window ' +
        '(a headless/offscreen display, or the terminal emulator failed silently).';
    return json({
      status: 'ok',
      terminal: spawned.terminal,
      pid: spawned.pid,
      ...(warning ? { warning } : {}),
    });
  },
});

export default [launchPui];
