/**
 * Per-OS runtime directory for a power-user OMP session.
 *
 * Papercusp's desktop app ships on Linux, macOS, and Windows (Tauri),
 * so the session-scratch dir cannot assume `$XDG_RUNTIME_DIR` — that is
 * Linux/systemd-only. See
 * docs/plans/omp-power-user-bundle-2026-05-20.md §4.3, D-010.
 *
 * Cleanup-on-exit (profile-writer.ts:cleanup) is the primary mechanism
 * on every platform. The Linux tmpfs auto-clear on logout is only a
 * safety net.
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Root directory under which every session's scratch dir is created. */
export function runtimeRoot(): string {
  if (process.platform === 'linux' && process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, 'papercusp-omp');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Papercusp', 'runtime');
  }
  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'Papercusp', 'runtime');
  }
  // Linux without XDG_RUNTIME_DIR, BSD, and any other platform.
  return join(tmpdir(), 'papercusp-omp');
}

/** The scratch dir for one session, keyed by its auth_session_id. */
export function sessionScratchDir(authSessionId: string): string {
  // auth_session_id is `pus-<uuid>` — filesystem-safe already, but
  // strip anything that isn't to be defensive against a malformed id.
  const safe = authSessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(runtimeRoot(), safe);
}
