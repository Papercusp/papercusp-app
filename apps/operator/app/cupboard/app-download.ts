/**
 * app-download.ts — the client-side helpers for a STANDALONE app's download flow
 * (cupboard-app-distribution-2026-07-14 P-004/P-005 [owner 2026-07-14]).
 *
 * A standalone app (e.g. the Oddsmith Tauri desktop app) is a separate
 * downloadable product: the Cupboard never re-hosts the binary. It stores the
 * app's signed `latest.json` URL (the publish gate `assertAppManifestResolves`
 * proved it resolves), and this module reads THAT manifest to resolve the
 * platform-specific installer URL and hand off the download link. v1 is a
 * download-link handoff only — no in-shell install / auto-update registration.
 *
 * Split out of CupboardClient so both the storefront card (platform chips + a
 * platform-aware CTA label) and the detail page (the actual fetch + resolve +
 * download handoff) share ONE definition of "which OS is this key / this viewer".
 *
 * The manifest shape mirrors @papercusp/tauri-release-kit `buildLatestManifest`
 * and the publish gate in operator-core/lib/cupboard/validate-app-manifest.ts:
 *   { version, notes?, pub_date?, platforms: { <os-key>: { url, signature } } }
 */

/** One platform entry in a tauri `latest.json` — the download `url` + the
 *  updater `signature`. Both are what the publish gate requires per entry. */
export interface LatestPlatformEntry {
  url: string;
  signature: string;
}

/** A fetched-and-parsed tauri `latest.json` updater manifest. */
export interface LatestManifest {
  version: string;
  notes: string | null;
  pub_date: string | null;
  /** Keyed by updater platform key: linux-x86_64, darwin-aarch64, windows-x86_64… */
  platforms: Record<string, LatestPlatformEntry>;
}

/** A resolved installer for one platform — what a download button hands off. */
export interface ResolvedInstaller {
  /** The manifest platform key (e.g. `darwin-aarch64`). */
  platformKey: string;
  /** The friendly OS family (macOS / Windows / Linux / passthrough). */
  osFamily: string;
  /** The direct installer download URL (a third-party release asset — no re-host). */
  url: string;
  /** The updater signature (surfaced for transparency; null when absent). */
  signature: string | null;
}

/** Map an updater platform key (linux-x86_64, darwin-aarch64, windows-x86_64) to
 *  a friendly OS family. Unknown keys pass through unchanged. */
export function platformOsFamily(key: string): string {
  if (key.startsWith('darwin') || key.startsWith('macos')) return 'macOS';
  if (key.startsWith('windows')) return 'Windows';
  if (key.startsWith('linux')) return 'Linux';
  return key;
}

/** The distinct OS families a standalone app advertises, parsed from the
 *  denormalized `platforms` JSON string[] on the listing (P-003). Returns [] when
 *  absent/unparseable — e.g. a legacy row, or an app whose manifest never
 *  resolved. */
export function appPlatformFamilies(platformsJson: string | null | undefined): string[] {
  if (!platformsJson) return [];
  let keys: unknown;
  try {
    keys = JSON.parse(platformsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(keys)) return [];
  const families: string[] = [];
  for (const k of keys) {
    if (typeof k !== 'string') continue;
    const fam = platformOsFamily(k);
    if (!families.includes(fam)) families.push(fam);
  }
  return families;
}

/** Best-effort viewer OS family, to make a standalone app's download CTA
 *  platform-aware ("Get for macOS"). null when undetectable (SSR / unknown) — the
 *  caller falls back to the plain "Download" label / lists every platform. */
export function viewerOsFamily(): string | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const s = `${nav.userAgentData?.platform ?? ''} ${nav.userAgent} ${nav.platform}`.toLowerCase();
  if (s.includes('mac')) return 'macOS';
  if (s.includes('win')) return 'Windows';
  if (s.includes('linux') || s.includes('x11')) return 'Linux';
  return null;
}

/**
 * Parse a fetched `latest.json` body FAIL-SOFT into a {@link LatestManifest}, or
 * null when it isn't a usable manifest. Mirrors `assertAppManifestResolves`'s
 * shape rules (object, non-empty version, a platforms map with ≥1 entry carrying
 * a non-empty url), but is TOLERANT: a per-entry signature is optional here (the
 * download only needs the url — the publish gate already enforced signatures), so
 * a still-downloadable manifest never blanks the page. Returns null only when
 * nothing is downloadable.
 */
export function parseLatestManifest(text: string): LatestManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { version, platforms, notes, pub_date } = parsed as {
    version?: unknown;
    platforms?: unknown;
    notes?: unknown;
    pub_date?: unknown;
  };
  const versionStr = typeof version === 'string' ? version.trim() : '';
  if (!versionStr) return null;
  if (platforms == null || typeof platforms !== 'object' || Array.isArray(platforms)) return null;

  const out: Record<string, LatestPlatformEntry> = {};
  for (const [key, entryRaw] of Object.entries(platforms as Record<string, unknown>)) {
    if (entryRaw == null || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) continue;
    const { url, signature } = entryRaw as { url?: unknown; signature?: unknown };
    // The download flow needs the url; an entry without one can't be downloaded.
    if (typeof url === 'string' && url.trim()) {
      out[key] = { url: url.trim(), signature: typeof signature === 'string' ? signature : '' };
    }
  }
  if (Object.keys(out).length === 0) return null;

  return {
    version: versionStr,
    notes: typeof notes === 'string' && notes.trim() ? notes : null,
    pub_date: typeof pub_date === 'string' && pub_date.trim() ? pub_date : null,
    platforms: out,
  };
}

/** Every usable installer in a parsed manifest, one per platform key. */
export function installersFromManifest(manifest: LatestManifest): ResolvedInstaller[] {
  return Object.entries(manifest.platforms).map(([platformKey, entry]) => ({
    platformKey,
    osFamily: platformOsFamily(platformKey),
    url: entry.url,
    signature: entry.signature ? entry.signature : null,
  }));
}

/**
 * The installer matching the viewer's OS family, or null when the viewer OS is
 * undetectable or the app has no build for it. The caller falls back to listing
 * every platform (so a Linux viewer of a mac-only app still sees the mac build).
 */
export function resolveInstallerForViewer(
  manifest: LatestManifest,
  viewerFamily: string | null,
): ResolvedInstaller | null {
  if (!viewerFamily) return null;
  return installersFromManifest(manifest).find((i) => i.osFamily === viewerFamily) ?? null;
}
