/** Artifact classification + sig-path convention. Pure (path strings only). */
import type { Artifact, PlatformKey } from './types.js';

/** Tauri writes a detached minisign as `<artifact>.sig`. */
export function defaultSigPath(path: string): string {
  return `${path}.sig`;
}

/**
 * Map a built bundle path to its updater PlatformKey, or null if it is not an
 * updater target (e.g. a `.deb`/`.rpm` is shipped but not the updater format).
 * Mirrors the selection in bin/release-local.sh's latest.json generator:
 *   AppImage → linux; -amd64.msi → windows; aarch64 AppImage → linux-aarch64.
 * Adds the macOS universal `.dmg` the build-system docs describe.
 *
 * ⚠ WI-3696 latent gap: this kit's `TauriReleaseConfig` (types.ts) has no
 * multi-role concept yet (one `appName`/`appId` per config), so it doesn't
 * currently reproduce papercusp-desktop's GUI+Server two-bundle split. If a
 * caller ever DOES feed it two roles' artifacts side by side (e.g. porting
 * that split into this kit), this classifier — and buildLatestManifest's
 * last-one-wins `platforms[a.platformKey] = …` — will reproduce the EXACT
 * bug fixed in release-local.sh: "Papercusp GUI_…_x64-setup.exe" and
 * "Papercusp Server_…_x64-setup.exe" both classify as the SAME
 * 'windows-x86_64' key, and whichever is processed last silently wins with a
 * genuinely-valid signature (a real wrong-product-install risk, not just a
 * cosmetic bug). Before wiring multi-role support into this kit, add the same
 * "exclude/only-GUI" filter release-local.sh now applies.
 */
export function defaultClassifyArtifact(path: string): PlatformKey | null {
  const lower = path.toLowerCase();
  const isAarch64 = lower.includes('aarch64') || lower.includes('arm64');

  if (lower.endsWith('.appimage')) {
    return isAarch64 ? 'linux-aarch64' : 'linux-x86_64';
  }
  if (lower.endsWith('-amd64.msi') || lower.endsWith('_x64-setup.exe')) {
    return 'windows-x86_64';
  }
  if (lower.endsWith('.dmg')) {
    if (lower.includes('universal')) return 'darwin-universal';
    return isAarch64 ? 'darwin-aarch64' : 'darwin-x86_64';
  }
  return null;
}

/** Basename of a path (no dir). */
export function basename(path: string): string {
  const norm = path.replace(/[\\]+/g, '/');
  const i = norm.lastIndexOf('/');
  return i === -1 ? norm : norm.slice(i + 1);
}

/** Build an Artifact record from a path, with classification + sig path. */
export function toArtifact(
  path: string,
  classify: (p: string) => PlatformKey | null = defaultClassifyArtifact,
  sigOf: (p: string) => string = defaultSigPath,
): Artifact {
  const platformKey = classify(path) ?? undefined;
  return {
    path,
    name: basename(path),
    platformKey,
    sigPath: sigOf(path),
  };
}
