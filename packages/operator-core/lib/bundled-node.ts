/**
 * Locate the BUNDLED node runtime as an absolute path.
 *
 * ## Why an absolute path is required, not a bare `node`
 *
 * A packaged install is not guaranteed to have node on PATH *at all*. The app
 * ships its own runtime — on macOS at
 * `/Applications/Papercusp GUI.app/Contents/Resources/sidecar/bin/node` — and
 * `main.rs` exports that directory as `PAPERCUSP_SIDECAR_BIN` for every
 * packaged/dev-sidecar boot. Any code that hands a bare `node` to a
 * *grandchild* process (a spawn whose PATH we do not control — notably git's
 * `ext::` transport command) therefore works on the dev box and fails on a real
 * install. Resolve the binary here and pass the absolute path instead.
 *
 * ## Why `process.execPath` is gated behind a basename check (EI-2114)
 *
 * In a PACKAGED Tauri build `process.execPath` is the Tauri/sidecar binary, not
 * node — handing it to something that expects a node interpreter breaks exactly
 * the installs this resolver exists to serve. It is only a valid candidate when
 * it really is a node binary, which the basename check establishes.
 *
 * The returned binary is always a plain node (never a tsx/loader wrapper), so a
 * caller whose stdout is a binary protocol can rely on it booting quietly —
 * provided the caller also strips `NODE_OPTIONS` from the child env.
 */
import { access } from 'node:fs/promises';
import * as path from 'node:path';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The BUNDLED node, resolved cwd-independently. `null` when this process can't
 * see it (an extracted dev-source operator whose env lacks
 * PAPERCUSP_SIDECAR_BIN and whose execPath is a tsx wrapper, not plain `node`).
 */
export async function resolveBundledNode(): Promise<string | null> {
  const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
  const execBase = path.basename(process.execPath).toLowerCase();
  const execIsNode = execBase === 'node' || execBase === 'node.exe';
  const candidates = [
    sidecarBin ? path.join(sidecarBin, 'node') : '',
    execIsNode ? process.execPath : '',
  ].filter(Boolean);
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return null;
}
