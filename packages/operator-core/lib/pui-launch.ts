/**
 * pui-launch — client helper for opening the `pui` ratatui workbench
 * (apps/tui) in an OS-native terminal from the desktop header.
 *
 * POSTs /api/adv/sessions/launch-pui, which server-spawns the terminal
 * running `pui workbench` (see endpoint-route/routes/adv/launch-pui.ts).
 * Throws on failure so the caller can surface a toast. The
 * `pui_not_installed` case comes back as HTTP 200 + `status:'error'`
 * (mirrors launch-su's psu_not_installed), so we check `status` too.
 *
 * Plan: desktop-pui-launch-button-2026-06-05 (Brief 26).
 */

export interface LaunchPuiResult {
  /** The terminal emulator that was spawned (e.g. "gnome-terminal"). */
  terminal: string;
  /** The spawned terminal's PID, if known. */
  pid: number | null;
}

interface LaunchPuiResponse {
  status?: string;
  error?: string;
  terminal?: string;
  pid?: number | null;
}

export async function launchPuiWorkbench(): Promise<LaunchPuiResult> {
  const res = await fetch('/api/adv/sessions/launch-pui', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  let data: LaunchPuiResponse | null = null;
  try {
    data = (await res.json()) as LaunchPuiResponse;
  } catch {
    /* non-JSON / empty body — fall through to the status checks */
  }
  if (!res.ok) {
    throw new Error(data?.error ?? `launch-pui HTTP ${res.status}`);
  }
  if (data?.status !== 'ok') {
    throw new Error(data?.error ?? 'pui workbench launch failed');
  }
  return { terminal: data.terminal ?? 'terminal', pid: data.pid ?? null };
}
