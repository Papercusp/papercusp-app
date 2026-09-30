/**
 * validate-app-manifest.ts — publish-time gate that a STANDALONE app listing's
 * `latest.json` updater manifest actually RESOLVES and parses
 * (cupboard-app-distribution-2026-07-14 P-003 / D-001 [owner 2026-07-14]).
 *
 * A standalone app (e.g. Oddsmith) is a separate downloadable product: the
 * Cupboard never re-hosts the binary — it stores the URL of the app's signed
 * `latest.json` (@papercusp/tauri-release-kit `buildLatestManifest` output) and
 * the download flow (P-005) reads THAT to resolve the platform-specific
 * installer URL. So if the manifest is unreachable or malformed at publish time,
 * the listing is born dead: every "download" would dead-end. Worse, an updater
 * cannot tell a failed manifest fetch from "no update" — a broken url surfaces to
 * users as "up to date"/"nothing to download" forever rather than as an error
 * (the exact silent-failure `buildLatestManifest` guards its url whitespace for).
 *
 * This gate closes that gap the same way `assertPluginManifestPublishable` gates
 * a plugin's `papercusp.json`: at publish time it FETCHES the manifest, shape-
 * checks it parses as a tauri latest.json, and refuses (422) a publish that would
 * list an app nobody can download. It also DERIVES the platform keys present so
 * the storefront card can show availability without re-fetching (the `platforms`
 * denormalized column).
 *
 * DI-pure — the network fetch is injected — so it is unit-testable without the
 * network. The tool wires a real `fetch`-backed `fetchText`.
 */

export class AppManifestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'AppManifestError';
  }
}

export interface AppManifestCheckDeps {
  /**
   * Fetch a url's raw text. Returns { ok, status, text }; `ok=false` on any
   * non-2xx. Should NOT throw for an HTTP error — only for a hard network
   * failure (which the caller maps to `latest_json_unreachable`).
   */
  fetchText: (url: string) => Promise<{ ok: boolean; status: number; text: string }>;
}

export interface ResolvedAppManifest {
  /** The manifest `version` (informational — surfaced back to the publisher). */
  version: string;
  /**
   * The OS keys present in `latest.json` `platforms` (e.g.
   * ["darwin-aarch64","linux-x86_64","windows-x86_64"]) — the denormalized
   * `platforms` column so the card shows availability without a re-fetch.
   */
  platforms: string[];
}

/** Only an https manifest url is accepted — an installer handoff over http is a
 *  downgrade a MITM can rewrite; the release kit always emits https. */
const HTTPS_RE = /^https:\/\//;

/**
 * Assert `latestJsonUrl` resolves to a parseable tauri `latest.json` and return
 * its version + the platform keys present. Throws `AppManifestError(422 | 400)`
 * when the url is not https (400), unreachable, unparseable, or shaped wrong
 * (422) — so a standalone-app publish is refused rather than listing a dead
 * download.
 *
 * Never STRICTER than the download flow needs: it requires each platform entry
 * to carry a non-empty `url` (what the download resolves) and `signature` (what
 * the updater verifies) — exactly the two fields `buildLatestManifest` always
 * emits — and rejects a manifest with zero usable platforms.
 */
export async function assertAppManifestResolves(
  latestJsonUrl: string,
  deps: AppManifestCheckDeps,
): Promise<ResolvedAppManifest> {
  if (typeof latestJsonUrl !== 'string' || !HTTPS_RE.test(latestJsonUrl)) {
    throw new AppManifestError(
      `latest_json_url must be an https URL (got ${JSON.stringify(latestJsonUrl)})`,
      400,
      'latest_json_url_not_https',
    );
  }

  let res: { ok: boolean; status: number; text: string };
  try {
    res = await deps.fetchText(latestJsonUrl);
  } catch (e) {
    throw new AppManifestError(
      `latest.json at ${latestJsonUrl} is unreachable (${(e as Error).message.slice(0, 120)})`,
      422,
      'latest_json_unreachable',
    );
  }
  if (!res.ok) {
    throw new AppManifestError(
      `latest.json at ${latestJsonUrl} returned HTTP ${res.status}`,
      422,
      'latest_json_unreachable',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new AppManifestError(
      `latest.json at ${latestJsonUrl} is not valid JSON`,
      422,
      'latest_json_malformed',
    );
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppManifestError(
      `latest.json at ${latestJsonUrl} is not a manifest object`,
      422,
      'latest_json_malformed',
    );
  }

  const { version, platforms } = parsed as { version?: unknown; platforms?: unknown };
  const versionStr = typeof version === 'string' ? version.trim() : '';
  if (!versionStr) {
    throw new AppManifestError(
      `latest.json at ${latestJsonUrl} has no version string`,
      422,
      'latest_json_no_version',
    );
  }
  if (platforms == null || typeof platforms !== 'object' || Array.isArray(platforms)) {
    throw new AppManifestError(
      `latest.json at ${latestJsonUrl} has no platforms map`,
      422,
      'latest_json_no_platforms',
    );
  }

  const keys: string[] = [];
  for (const [key, entryRaw] of Object.entries(platforms as Record<string, unknown>)) {
    if (entryRaw == null || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) continue;
    const { url, signature } = entryRaw as { url?: unknown; signature?: unknown };
    // The download flow needs the url; the updater needs the signature. An entry
    // missing either can't complete a download, so it doesn't count as an
    // available platform (mirrors the installer skipping an unusable candidate).
    if (typeof url === 'string' && url.trim() && typeof signature === 'string' && signature.trim()) {
      keys.push(key);
    }
  }
  if (keys.length === 0) {
    throw new AppManifestError(
      `latest.json at ${latestJsonUrl} lists no usable platform (each needs a url + signature)`,
      422,
      'latest_json_no_usable_platform',
    );
  }

  return { version: versionStr, platforms: keys };
}
