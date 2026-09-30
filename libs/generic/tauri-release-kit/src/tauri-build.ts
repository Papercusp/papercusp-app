/** `tauri build` invocation + bundle-dir artifact collection (over ports). */
import type { Artifact, PlatformKey, ReleasePorts, TauriReleaseConfig } from './types.js';
import { joinPath } from './path.js';
import { defaultClassifyArtifact, toArtifact } from './artifacts.js';

/** Env for a signed Tauri build (mirrors release-local.sh's two env vars). */
export function signingEnv(
  cfg: TauriReleaseConfig,
  ports: ReleasePorts,
): Record<string, string> {
  const password = cfg.signing.passwordEnv
    ? ports.env(cfg.signing.passwordEnv) ?? ''
    : '';
  return {
    // Tauri v2's updater-signing env var — it accepts EITHER the key file path
    // OR the key content; we pass the path. The pre-v2 name this used to emit,
    // `TAURI_SIGNING_PRIVATE_KEY_PATH`, is IGNORED by the v2 CLI, so a build with
    // `bundle.createUpdaterArtifacts` failed with "A public key has been found,
    // but no private key" (or, without that flag, silently produced an EMPTY
    // latest.json signature). EI-12203.
    TAURI_SIGNING_PRIVATE_KEY: cfg.signing.keyPath,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  };
}

/** Run `npx -p @tauri-apps/cli@latest tauri build [--target X]` in cfg.root. */
export async function runTauriBuild(
  ports: ReleasePorts,
  cfg: TauriReleaseConfig,
  target?: string,
): Promise<void> {
  const args = ['--yes', '-p', '@tauri-apps/cli@latest', 'tauri', 'build'];
  if (target) args.push('--target', target);
  const res = await ports.exec.run('npx', args, {
    cwd: cfg.root,
    env: signingEnv(cfg, ports),
  });
  if (res.code !== 0) {
    throw new Error(
      `tauri build${target ? ` --target ${target}` : ''} failed (exit ${res.code}): ${res.stderr || res.stdout}`,
    );
  }
}

/**
 * Resolve cargo's REAL target directory. Honors `CARGO_TARGET_DIR` and a
 * `[build] target-dir` in any .cargo/config.toml via `cargo metadata` — without
 * this, a box that redirects builds (e.g. ~/.cargo-target) leaves bundles where
 * a hardcoded `<root>/src-tauri/target` never finds them (only stale leftovers),
 * which is a latent bug in the old release-local.sh too.
 */
export async function resolveTargetDir(
  ports: ReleasePorts,
  cfg: TauriReleaseConfig,
): Promise<string> {
  if (cfg.cargoTargetDir) return cfg.cargoTargetDir;
  const res = await ports.exec.run(
    'cargo',
    ['metadata', '--no-deps', '--format-version', '1'],
    { cwd: joinPath(cfg.root, 'src-tauri') },
  );
  if (res.code === 0) {
    try {
      const meta = JSON.parse(res.stdout) as { target_directory?: unknown };
      if (typeof meta.target_directory === 'string' && meta.target_directory) {
        return meta.target_directory;
      }
    } catch {
      /* fall through to default */
    }
  }
  ports.log.warn(
    'cargo metadata gave no target_directory; defaulting to <root>/src-tauri/target',
  );
  return joinPath(cfg.root, 'src-tauri', 'target');
}

/** The bundle output root under a resolved cargo target dir (+ optional triple). */
export function bundleRootFor(targetDir: string, target?: string): string {
  return joinPath(targetDir, target ?? '', 'release', 'bundle');
}

/** Recognized installer/bundle artifact extensions (lowercase, no dot-sig). */
export const ARTIFACT_EXTS = ['.deb', '.rpm', '.appimage', '.msi', '.exe', '.dmg'] as const;

/** True for a real artifact FILE — excludes staging dirs (AppDir, *_amd64/) + .sig. */
export function isArtifactFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ARTIFACT_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * List artifacts under the given bundle subdirs (deb, appimage, msi, …),
 * classifying each and attaching its `.sig`. Skips:
 *  - directories (the deb/rpm staging dirs, `Papercusp.AppDir`) — a bundle dir
 *    holds both the artifact file AND its expanded tree;
 *  - `.sig` files (they ride along via sigPath);
 *  - stale cross-version artifacts when `version` is given — the shared cargo
 *    target-dir accumulates across cuts, and an unscoped sweep once shipped a
 *    stale older-version .deb (release-local.sh L178 learned the same lesson).
 */
export async function collectArtifacts(
  ports: ReleasePorts,
  bundleRoot: string,
  subdirs: string[],
  classify: (p: string) => PlatformKey | null = defaultClassifyArtifact,
  opts: { version?: string } = {},
): Promise<Artifact[]> {
  const out: Artifact[] = [];
  for (const sub of subdirs) {
    const dir = joinPath(bundleRoot, sub);
    const names = await ports.fs.readDir(dir);
    for (const name of names) {
      if (!isArtifactFile(name)) continue;
      if (opts.version && !name.includes(opts.version)) continue;
      out.push(toArtifact(joinPath(dir, name), classify));
    }
  }
  return out;
}
