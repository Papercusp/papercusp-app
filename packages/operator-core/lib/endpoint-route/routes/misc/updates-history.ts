/**
 * GET /api/updates/history — the release HISTORY for a channel (the Update
 * Center, desktop-update-center-and-release-tooling-2026-07-10 P-3).
 *
 * Where /updates/manifest answers the Tauri updater's ONE question ("is there a
 * newer release for my channel?"), this answers the GUI's: "show me every
 * release I could be on for this channel, which one I'm on, and which I can move
 * to." It reuses the SAME channel-visibility + classification + version
 * normalization as the manifest route (imported, not re-derived) so the list and
 * the updater can never disagree about what "on the beta channel" means.
 *
 * SOURCE PRECEDENCE (WI-4446) — the static release host FIRST, GitHub as fallback,
 * mirroring the manifest route exactly:
 *
 *   1. `<host>/history.json` — AUTHORITATIVE. Generated from the release registry
 *      (`harness_shared.releases`) at cut time and uploaded next to `latest.json`.
 *   2. GitHub Releases — the legacy/hybrid path, kept for a host that publishes no
 *      history.json. It discovers NOTHING on our current rail: releases stopped
 *      going to GitHub on 2026-07-08.
 *
 * ⚠ It reads the registry over HTTP, not out of Postgres, and that is deliberate.
 * `harness_shared.releases` lives in OUR database; an installed app has its own,
 * empty one. Querying it directly would make this route work perfectly on the
 * machine that cuts releases and return an empty history to every real user —
 * a bug with no failing branch, on the box least likely to notice.
 *
 * `auth: 'public'` — same loopback posture as the manifest/download routes.
 *
 * Query: channel? (else the saved update_channel, else stable) · product? (gui|
 * server, default gui) · target?/arch? (default linux/x86_64 — the GUI passes the
 * running platform so `installable` reflects THIS machine) · current_version? (to
 * mark the installed release) · limit? (1..50, default 20).
 *
 * Response: { channel, product, current_version, releases: UpdateHistoryEntry[],
 * reason? } — `reason` ('no_token'|'fetch_failed') accompanies an empty list when
 * the listing couldn't be fetched, mirroring the manifest route's X-Update-Reason
 * so the GUI can say "couldn't reach releases" instead of "no history".
 */
import { defineTool } from '@papercusp/agent-mcp';
import { readOperatorState } from '../../../operator-state-pg';
import { releaseHostBase, resolveGithubToken } from './updates-github';
import {
  classifyChannel,
  fetchReleases,
  normalizeTagVersion,
  pickAsset,
  platformKeyFor,
  resolveChannel,
  visibleChannels,
  type Channel,
  type GhRelease,
} from './updates-manifest';

type Product = 'gui' | 'server';

/**
 * `<host>/history.json` — the AUTHORITATIVE history since releases went local-only
 * (WI-4446, and the same reasoning as WI-4389 for the manifest).
 *
 * Written by `apps/operator/lib/release/record-release-cli.ts --regenerate` from
 * the release registry and uploaded by `bin/publish-release-history.sh`.
 */
export interface StaticHistoryArtifact {
  product: Product;
  platform: string;
  name: string;
  /** Relative to the release host base — the base path is the shared secret. */
  url: string;
  size: number;
  sha256: string;
}

export interface StaticHistoryRelease {
  tag: string;
  version: string;
  channel: string;
  notes: string;
  pub_date: string;
  prerelease: boolean;
  artifacts: StaticHistoryArtifact[];
}

export interface StaticHistory {
  generated_at: string;
  releases: StaticHistoryRelease[];
}

export async function fetchStaticHistory(host: string): Promise<StaticHistory | null> {
  const res = await fetch(`${host}/history.json`, { next: { revalidate: 60 } } as RequestInit);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`release host history.json: ${res.status}`);
  return (await res.json()) as StaticHistory;
}

/**
 * Does this release have something THIS machine can install?
 *
 * A macOS build is `darwin-universal` — one artifact that runs on both Apple
 * Silicon and Intel. `platformKeyFor` (shared with the updater, so the two can
 * never disagree about what a platform is) yields `darwin-aarch64` /
 * `darwin-x86_64`, neither of which equals `darwin-universal`. Comparing the two
 * naively marks every mac release un-installable ON A MAC, which is the one
 * machine it definitely runs on.
 */
export function artifactMatches(
  a: StaticHistoryArtifact,
  platformKey: string,
  product: Product,
): boolean {
  if (a.product !== product) return false;
  if (a.platform === platformKey) return true;
  return a.platform === 'darwin-universal' && platformKey.startsWith('darwin-');
}

/**
 * Can the Tauri updater actually INSTALL this artifact? (WI-5008)
 *
 * `installable` gates the Update Center's "Revert" button, and a revert goes
 * through tauri-plugin-updater — which can only swap its own updater formats:
 * an AppImage on Linux, an .app.tar.gz on macOS, a -setup.exe/.msi on Windows.
 * A .deb / .rpm / .dmg / mobile package IS a real artifact for this platform
 * (a human can download and install it by hand), but offering "Revert" for it
 * hands the user a button that can only ever fail — the real 0.0.9 cut shipped
 * .deb-only on Linux, so every Revert onto it would resolve to nothing.
 */
export function updaterInstallableStaticArtifact(a: StaticHistoryArtifact): boolean {
  const n = a.name.toLowerCase();
  if (n.endsWith('.sig')) return false;
  if (a.platform.startsWith('linux-')) return n.endsWith('.appimage') || n.endsWith('.appimage.tar.gz');
  // macOS updater bundles are `.app.tar.gz` (a plain `.tar.gz` app bundle also
  // qualifies); a `.dmg` is human-installable but not updater-installable.
  if (a.platform.startsWith('darwin-')) return n.endsWith('.tar.gz');
  if (a.platform.startsWith('windows-')) {
    return n.endsWith('-setup.exe') || n.endsWith('.msi') || n.endsWith('.msi.zip') || n.endsWith('.exe.tar.gz');
  }
  return false; // mobile / unknown platforms are never updater-installable
}

/**
 * Mark which entry is the RUNNING release (WI-5007). The app reports its bare
 * package version (`0.0.10` — CARGO_PKG_VERSION / tauri.conf.json), while tags
 * carry the channel (`desktop-v0.0.10-alpha` → normalized `0.0.10-alpha`), so
 * a strict equality against the normalized tag-version can NEVER match on a
 * suffixed rail — the Update Center then never shows "● Current" and happily
 * offers a Revert button for the release the user is on. Exact matches
 * (against the entry version AND the normalized tag) win; failing that, the
 * NEWEST entry whose base version (prerelease suffix stripped) equals the
 * caller's base version is marked — newest-only, so the 0.0.2-alpha.1..4 era
 * cannot produce four "current" rows. Entries are built newest-first.
 * Mutates and returns `entries`.
 */
export function markCurrentEntry(
  entries: UpdateHistoryEntry[],
  currentVersion: string,
): UpdateHistoryEntry[] {
  if (!currentVersion) return entries;
  const exact = entries.filter(
    (e) => e.version === currentVersion || normalizeTagVersion(e.tag) === currentVersion,
  );
  if (exact.length > 0) {
    for (const e of exact) e.is_current = true;
    return entries;
  }
  const base = (v: string) => v.split('-')[0];
  const hit = entries.find((e) => base(e.version) === base(currentVersion));
  if (hit) hit.is_current = true;
  return entries;
}

/** Build the history list from the STATIC feed. Pure — the network is the caller's. */
export function buildHistoryFromStatic(
  history: StaticHistory,
  opts: {
    channel: Channel;
    target: string;
    arch: string;
    product: Product;
    currentVersion: string;
    limit: number;
  },
): UpdateHistoryEntry[] {
  const visible = visibleChannels(opts.channel);
  const platformKey = platformKeyFor(opts.target, opts.arch);
  const entries = history.releases
    .filter((r) => visible.has(r.channel as Channel))
    .sort((a, b) => Date.parse(b.pub_date) - Date.parse(a.pub_date))
    .slice(0, opts.limit)
    .map((r) => ({
      tag: r.tag,
      // The feed's own `version` is what the cut stamped into the app binary
      // (CARGO_PKG_VERSION / tauri.conf.json), so it is the string the running
      // app will report back as current_version AND what the footer chip
      // displays — prefer it over the tag-derived form (WI-5007). Fall back to
      // the normalized tag for an older generator that wrote no version.
      version: r.version || normalizeTagVersion(r.tag),
      channel: r.channel as Channel,
      notes: r.notes ?? '',
      pub_date: r.pub_date,
      prerelease: r.prerelease,
      is_current: false,
      installable:
        platformKey != null &&
        (r.artifacts ?? []).some(
          (a) => artifactMatches(a, platformKey, opts.product) && updaterInstallableStaticArtifact(a),
        ),
    }));
  return markCurrentEntry(entries, opts.currentVersion);
}

export interface UpdateHistoryEntry {
  /** The full git tag, e.g. `desktop-v0.0.7-alpha` (what a rollback targets). */
  tag: string;
  /** Semver-normalized version, e.g. `0.0.7-alpha` (what the updater compares). */
  version: string;
  /** The channel this release classifies into. */
  channel: Channel;
  /** Release notes (GitHub release body). */
  notes: string;
  /** ISO publish date. */
  pub_date: string;
  prerelease: boolean;
  /** True when this is the running version (per `current_version`). */
  is_current: boolean;
  /** True when a matching asset exists for the requested target/arch/product —
   *  i.e. the GUI can offer "Install"/"Revert to" for THIS machine. */
  installable: boolean;
}

/**
 * Build the history list from raw GitHub releases (pure — the network is the
 * caller's concern, so this is directly unit-tested). Applies the same
 * channel-visibility window as the manifest (a `beta` user sees beta+stable; an
 * `alpha` user sees everything), newest-first, capped at `limit`.
 */
export function buildHistory(
  releases: GhRelease[],
  opts: {
    channel: Channel;
    target: string;
    arch: string;
    product: Product;
    currentVersion: string;
    limit: number;
  },
): UpdateHistoryEntry[] {
  const visible = visibleChannels(opts.channel);
  const entries = releases
    .filter((r) => !r.draft)
    .filter((r) => visible.has(classifyChannel(r)))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, opts.limit)
    .map((r) => {
      const version = normalizeTagVersion(r.tag_name);
      return {
        tag: r.tag_name,
        version,
        channel: classifyChannel(r),
        notes: r.body ?? '',
        pub_date: r.published_at,
        prerelease: r.prerelease,
        is_current: false,
        installable: pickAsset(r, opts.target, opts.arch, opts.product) != null,
      } satisfies UpdateHistoryEntry;
    });
  return markCurrentEntry(entries, opts.currentVersion);
}

export default defineTool({
  method: 'GET',
  path: '/updates/history',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const params = url.searchParams;
    const target = params.get('target') ?? 'linux';
    const arch = params.get('arch') ?? 'x86_64';
    const product: Product = params.get('product') === 'server' ? 'server' : 'gui';
    const currentVersion = params.get('current_version') ?? '';
    const limit = Math.min(Math.max(Number(params.get('limit')) || 20, 1), 50);

    const stored = await readOperatorState<{ update_channel?: string }>('setup_wizard_state');
    const channel = resolveChannel(params, stored?.update_channel);

    const base = { channel, product, current_version: currentVersion };
    const opts = { channel, target, arch, product, currentVersion, limit };

    // ── 1. The static release host — AUTHORITATIVE. ──────────────────────────
    // Releases have not been published to GitHub since 2026-07-08 (owner directive:
    // artifacts are built locally and uploaded to our own host), so the GitHub path
    // below discovers nothing and this route returned an empty list to every user,
    // forever, while reporting `no_token` as though a credential were the problem.
    const host = releaseHostBase();
    if (host) {
      try {
        const stat = await fetchStaticHistory(host);
        if (stat && stat.releases.length > 0) {
          return Response.json({ ...base, releases: buildHistoryFromStatic(stat, opts) });
        }
      } catch (e: unknown) {
        // Fall through to GitHub — but say so. Silently returning an empty list here
        // is the "you're on the latest" lie in a different costume (WI-4477): a
        // failed fetch and a genuinely empty history must not look the same.
        console.warn(
          `[updates/history] release host fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // ── 2. GitHub — the legacy/hybrid path. ─────────────────────────────────
    const token = await resolveGithubToken();
    if (!token) {
      console.warn('[updates/history] no release host history and no GitHub token');
      return Response.json({ ...base, releases: [], reason: 'no_token' });
    }

    let releases: GhRelease[] | null;
    try {
      releases = await fetchReleases(token);
    } catch (e: unknown) {
      console.warn(
        `[updates/history] releases fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return Response.json({ ...base, releases: [], reason: 'fetch_failed' });
    }
    if (!releases) return Response.json({ ...base, releases: [], reason: 'fetch_failed' });

    return Response.json({ ...base, releases: buildHistory(releases, opts) });
  },
});
