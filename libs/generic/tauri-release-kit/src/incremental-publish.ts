/**
 * runIncrementalPublish — ADD one freshly-built platform's artifacts onto an
 * ALREADY-PUBLISHED manifest, without touching (re-uploading, re-signing, or
 * re-dating) any OTHER platform's entry.
 *
 * DURABLE FIX for EI-18683062996592825 (revising EI-18111560213741904): this
 * was hand-work every time a platform became ready later than the others
 * (papercusp's mac-0.0.12 cut hit a signature double-encode trap doing it by
 * hand) — codified here in the shared core so both papercusp's R2/curl publish
 * path and oddsmith's `gh release upload --clobber` path can build on the SAME
 * tested merge semantics instead of two hand-runbooks. Mirrors
 * papercusp-desktop/bin/publish-platform-incremental.sh's shape, generified.
 *
 * Scope boundary (deliberate): this function owns exactly the hard, error-
 * prone part — building the one platform + merging its manifest fragment onto
 * the live one with the other platforms left byte-for-byte untouched. It does
 * NOT upload the result anywhere (R2 vs `gh release` are host-specific — see
 * each app's own publish step) and does NOT touch git tag/push (the tag is
 * presumed already cut by whichever platform published first). A host wires
 * this in, then runs its own upload step exactly like a fresh `runRelease`
 * cut would.
 */
import type {
  Artifact,
  LatestManifest,
  ReleasePorts,
  TargetKey,
  TauriReleaseConfig,
} from './types.js';
import { assertValidChannel, assertValidVersion, defaultTagFor } from './tag.js';
import { buildLatestManifest, mergeLatestManifest } from './latest-json.js';
import { buildAndSignTargets } from './release.js';
import { joinPath } from './path.js';

/** The one side effect this module needs beyond `ReleasePorts`: fetching the
 *  currently-live manifest to merge onto. Kept as its own tiny port (rather
 *  than growing `ReleasePorts`) so every OTHER caller of this kit is
 *  unaffected — only incremental publish needs network reads. */
export interface HttpGetPort {
  /**
   * GET `url` and return its body text, or `null` if unreachable / non-2xx.
   * MUST NOT throw — a missing/unreachable live manifest is the ordinary
   * "first publish of this release" case, not an error.
   */
  getText(url: string): Promise<string | null>;
}

export interface RunIncrementalPublishOptions {
  /**
   * Absolute URL of the currently-LIVE `latest.json` (or `latest-server.json`,
   * for a Server-role publish) to merge this platform onto — e.g.
   * `https://dl.example.com/<secret>/latest.json`. Fetched fresh every call;
   * never trust a locally-cached copy (the whole point is merging onto what
   * is genuinely live).
   */
  liveManifestUrl: string;
  http: HttpGetPort;
  /** Where to write the merged manifest (default `<cfg.root>/latest.json`). */
  latestJsonPath?: string;
}

export interface RunIncrementalPublishResult {
  tag: string;
  platform: TargetKey;
  /** Artifacts built for JUST this platform (not the other, already-live ones). */
  artifacts: Artifact[];
  manifest: LatestManifest;
  latestJsonPath: string;
  /** Whether a live manifest was actually found to merge onto. */
  mergedFrom: 'live' | 'none';
}

export async function runIncrementalPublish(
  cfg: TauriReleaseConfig,
  platform: TargetKey,
  ports: ReleasePorts,
  opts: RunIncrementalPublishOptions,
): Promise<RunIncrementalPublishResult> {
  assertValidVersion(cfg.version);
  assertValidChannel(cfg.channel);
  const tagFor = cfg.tagFor ?? defaultTagFor;
  const tag = tagFor(cfg.version, cfg.channel);
  ports.log.info(
    `incremental publish ${cfg.appName} ${cfg.version} (${cfg.channel}) platform=${platform} — tag ${tag}`,
  );

  // 1. build + sign ONLY the requested platform — the exact same path
  // runRelease uses for a full cut, just scoped to one target.
  const { artifacts, signed } = await buildAndSignTargets(cfg, ports, [platform]);
  if (signed.length === 0) {
    throw new Error(
      `incremental publish produced no updater-eligible artifact for platform "${platform}" — nothing to merge (built ${artifacts.length} non-updater artifact(s))`,
    );
  }

  // 2. fetch the currently-LIVE manifest as the merge base. Absent/unreachable
  // is the ordinary "first publish" case — never an error.
  const liveText = await opts.http.getText(opts.liveManifestUrl);
  let base: LatestManifest | null = null;
  let mergedFrom: 'live' | 'none' = 'none';
  if (liveText != null) {
    try {
      base = JSON.parse(liveText) as LatestManifest;
      mergedFrom = 'live';
      ports.log.info(`fetched the live manifest (${opts.liveManifestUrl}) as the merge base`);
    } catch {
      ports.log.warn(
        `live manifest at ${opts.liveManifestUrl} did not parse as JSON — starting fresh instead of merging onto garbage`,
      );
    }
  } else {
    ports.log.warn(
      `no live manifest reachable at ${opts.liveManifestUrl} — starting fresh (first publish of this release?)`,
    );
  }

  // 3. build THIS platform's manifest fragment, then merge it onto the live
  // base — every other platform key already in `base` carries through
  // byte-for-byte untouched (mergeLatestManifest).
  const overlay = buildLatestManifest({
    version: cfg.version,
    channel: cfg.channel,
    tag,
    artifacts: signed,
    urlFor: cfg.latestJsonUrl,
    pubDate: ports.now(),
    appName: cfg.appName,
  });
  const manifest = mergeLatestManifest(base, overlay);

  const latestJsonPath = opts.latestJsonPath ?? joinPath(cfg.root, 'latest.json');
  await ports.fs.writeText(latestJsonPath, JSON.stringify(manifest, null, 2) + '\n');

  return { tag, platform, artifacts, manifest, latestJsonPath, mergedFrom };
}
