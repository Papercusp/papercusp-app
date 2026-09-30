/**
 * GET /api/updates/rollback — resolve a SPECIFIC release tag into a Tauri-updater
 * install manifest, so the desktop app's `revert_to(tag)` command (desktop-update-
 * center-and-release-tooling P-4) can download, minisign-verify, and swap to an
 * OLDER release exactly the way `install_update` installs the newest one.
 *
 * Where /updates/manifest answers the Tauri updater's "is there a NEWER release for
 * my channel?" (and 204s when you're already up to date), this answers the Update
 * Center "Revert" button's question: "give me the install manifest for THIS exact
 * tag." It reuses the manifest route's SAME asset / signature / channel resolution
 * (imported, not re-derived) so a rollback and a forward update can never disagree
 * about what a release's installable artifact — or its trusted signature — is.
 *
 * `auth: 'public'` — same loopback posture as the manifest / history / download
 * routes; the private release repo is reached with a server-resolved GitHub token.
 *
 * SOURCE PRECEDENCE (WI-5008) — the static release host FIRST, GitHub as fallback,
 * mirroring the manifest + history routes exactly. Releases stopped going to GitHub
 * on 2026-07-08 (local-only rail), so a GitHub-only rollback could not resolve ANY
 * release the Update Center's history list (static-first since WI-4446) was offering
 * Revert buttons for — every revert onto 0.0.8+ died with unknown_tag. The static
 * path resolves the tag from `<host>/history.json`, picks the updater-installable
 * artifact for this platform/product, and inlines the minisign signature fetched
 * from `<host>/<artifact>.sig` (uploaded next to every artifact by the cut).
 * GitHub remains the fallback for pre-rail tags (≤ 0.0.7).
 *
 * Query:
 *   - `tag` (required) — the release to roll back to, either the full git tag
 *     (`desktop-v0.0.6-alpha`) or its normalized version (`0.0.6-alpha`).
 *   - `target?` / `arch?` — default `linux` / `x86_64`; the GUI passes the running
 *     platform so the resolved asset matches THIS machine.
 *   - `product?` — `gui` | `server` (default `gui`).
 *   - `channel?` — else the saved `update_channel`, else `stable`. Bounds the
 *     rollback to the channel window (a stable user cannot silently revert onto an
 *     alpha build) — the same visibility the history list already applies.
 *
 * Response (200): the newer-update manifest shape plus flat convenience fields, so a
 * client can either reuse its `install_update` manifest parser or read `url` +
 * `signature` directly:
 *   { ok, tag, version, channel, target, arch, product, platform, url, signature,
 *     notes, pub_date, manifest: { version, notes, pub_date, platforms } }
 * Refusals carry a machine-readable `reason`:
 *   400 missing_tag · 404 unknown_tag | channel_hidden | unknown_platform | no_asset
 *   · 409 no_signature (asset found but no verifiable .sig — surfaced, never served,
 *   because revert_to's minisign check would fail) · 503 no_token | fetch_failed.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { readOperatorState } from '../../../operator-state-pg';
import { fetchAssetText, resolveGithubToken, releaseHostBase } from './updates-github';
import {
  classifyChannel,
  fetchReleases,
  findLatestJsonAsset,
  findSigAsset,
  normalizeTagVersion,
  pickAsset,
  platformKeyFor,
  resolveChannel,
  visibleChannels,
  type Channel,
  type GhRelease,
} from './updates-manifest';
import {
  artifactMatches,
  fetchStaticHistory,
  updaterInstallableStaticArtifact,
  type StaticHistoryArtifact,
  type StaticHistoryRelease,
} from './updates-history';

type Product = 'gui' | 'server';

/** Why a requested tag is not a serviceable rollback target for this caller. */
export type RollbackRefusal = 'unknown_tag' | 'channel_hidden';

export type RollbackSelection =
  | { ok: true; release: GhRelease }
  | { ok: false; reason: RollbackRefusal };

/**
 * Select the release a rollback request targets — the pure, network-free core:
 * match the tag (full `desktop-vX` tag OR the normalized version), exclude drafts,
 * and enforce the channel-visibility window (an `alpha` caller may revert to any
 * channel; a `stable` caller only to `stable`). The asset / signature assembly is
 * the caller's concern (it needs the network) — this is what's directly unit-tested.
 */
export function selectRollbackRelease(
  releases: GhRelease[],
  opts: { tag: string; channel: Channel },
): RollbackSelection {
  const wanted = opts.tag.trim();
  const wantedVersion = normalizeTagVersion(wanted);
  const release = releases
    .filter((r) => !r.draft)
    .find(
      (r) =>
        r.tag_name === wanted ||
        r.tag_name.toLowerCase() === wanted.toLowerCase() ||
        normalizeTagVersion(r.tag_name) === wantedVersion,
    );
  if (!release) return { ok: false, reason: 'unknown_tag' };
  if (!visibleChannels(opts.channel).has(classifyChannel(release))) {
    return { ok: false, reason: 'channel_hidden' };
  }
  return { ok: true, release };
}

export type StaticRollbackSelection =
  | { ok: true; release: StaticHistoryRelease }
  | { ok: false; reason: RollbackRefusal };

/**
 * The static-host sibling of `selectRollbackRelease` (WI-5008): match the tag
 * against `<host>/history.json` rows — full tag, case-insensitive tag,
 * normalized tag-version, or the feed's own stamped version (`0.0.9`, the form
 * the app actually reports) — and enforce the SAME channel-visibility window.
 * Pure; the network is the caller's concern.
 */
export function selectStaticRollbackRelease(
  releases: StaticHistoryRelease[],
  opts: { tag: string; channel: Channel },
): StaticRollbackSelection {
  const wanted = opts.tag.trim();
  const wantedVersion = normalizeTagVersion(wanted);
  const release = releases.find(
    (r) =>
      r.tag === wanted ||
      r.tag.toLowerCase() === wanted.toLowerCase() ||
      normalizeTagVersion(r.tag) === wantedVersion ||
      r.version === wanted,
  );
  if (!release) return { ok: false, reason: 'unknown_tag' };
  if (!visibleChannels(opts.channel).has(release.channel as Channel)) {
    return { ok: false, reason: 'channel_hidden' };
  }
  return { ok: true, release };
}

/**
 * Pick the artifact `revert_to` can actually hand to tauri-plugin-updater:
 * matches this platform/product AND is an updater-installable format (AppImage /
 * .app.tar.gz / -setup.exe|.msi — a .deb or .dmg would download and then fail
 * the swap). Returns null when the release has nothing swappable for this
 * machine, e.g. the real 0.0.9 cut (.deb-only on Linux).
 */
export function pickStaticRollbackArtifact(
  release: StaticHistoryRelease,
  platformKey: string,
  product: Product,
): StaticHistoryArtifact | null {
  return (
    (release.artifacts ?? []).find(
      (a) => artifactMatches(a, platformKey, product) && updaterInstallableStaticArtifact(a),
    ) ?? null
  );
}

const REFUSAL_STATUS: Record<RollbackRefusal | 'unknown_platform' | 'no_asset', number> = {
  unknown_tag: 404,
  channel_hidden: 404,
  unknown_platform: 404,
  no_asset: 404,
};

function refusal(reason: RollbackRefusal | 'unknown_platform' | 'no_asset', extra?: Record<string, unknown>): Response {
  return Response.json({ ok: false, reason, ...extra }, { status: REFUSAL_STATUS[reason] });
}

export default defineTool({
  method: 'GET',
  path: '/updates/rollback',
  auth: 'public',
  async handler(req) {
    const reqUrl = new URL(req.url);
    const params = reqUrl.searchParams;

    const tag = (params.get('tag') ?? '').trim();
    if (!tag) {
      return Response.json({ ok: false, reason: 'missing_tag', error: 'tag query param is required' }, { status: 400 });
    }
    const target = params.get('target') ?? 'linux';
    const arch = params.get('arch') ?? 'x86_64';
    const product: Product = params.get('product') === 'server' ? 'server' : 'gui';

    const stored = await readOperatorState<{ update_channel?: string }>('setup_wizard_state');
    const channel = resolveChannel(params, stored?.update_channel);

    const platformKey = platformKeyFor(target, arch);
    if (!platformKey) return refusal('unknown_platform', { error: `unknown platform ${target}/${arch}` });

    /** One response shape for BOTH sources — flat fields + the Tauri-updater
     *  manifest, so `revert_to`'s plugin parses either. */
    const respondWith = (r: {
      tag: string;
      version: string;
      channel: Channel;
      notes: string;
      pub_date: string;
      signature: string;
      url: string;
    }) =>
      Response.json({
        ok: true,
        tag: r.tag,
        version: r.version,
        channel: r.channel,
        target,
        arch,
        product,
        platform: platformKey,
        url: r.url,
        signature: r.signature,
        notes: r.notes,
        pub_date: r.pub_date,
        // Tauri-updater manifest shape — a client may reuse its install_update parser.
        manifest: {
          version: r.version,
          notes: r.notes,
          pub_date: r.pub_date,
          platforms: { [platformKey]: { signature: r.signature, url: r.url } },
        },
      });

    // ── 1. The static release host — AUTHORITATIVE (WI-5008). ────────────────
    // The history list is static-first (WI-4446); resolving the revert from the
    // SAME feed keeps "which Revert buttons appear" and "which reverts succeed"
    // from ever disagreeing. GitHub has no release newer than 0.0.7.
    const host = releaseHostBase();
    let staticRefusal: RollbackRefusal | 'no_asset' | null = null;
    if (host) {
      try {
        const stat = await fetchStaticHistory(host);
        if (stat && stat.releases.length > 0) {
          const sel = selectStaticRollbackRelease(stat.releases, { tag, channel });
          if (!sel.ok) {
            // channel_hidden is FINAL: the static feed knows this tag and the
            // caller's channel window excludes it — GitHub would classify it
            // identically, so falling through could only weaken the gate.
            if (sel.reason === 'channel_hidden') return refusal('channel_hidden');
            staticRefusal = sel.reason; // unknown_tag → maybe a pre-rail tag; try GitHub
          } else {
            const art = pickStaticRollbackArtifact(sel.release, platformKey, product);
            if (art) {
              const artUrl = `${host}/${encodeURI(art.url)}`;
              let signature = '';
              try {
                const sigRes = await fetch(`${artUrl}.sig`);
                signature = sigRes.ok ? (await sigRes.text()).trim() : '';
              } catch {
                /* treated as missing below */
              }
              if (!signature) {
                // Surfaced, never served: revert_to's minisign verify would fail.
                console.warn(`[updates/rollback] no signature at ${artUrl}.sig`);
                return Response.json(
                  {
                    ok: false,
                    reason: 'no_signature',
                    tag: sel.release.tag,
                    version: sel.release.version || normalizeTagVersion(sel.release.tag),
                    asset: art.name,
                  },
                  { status: 409 },
                );
              }
              return respondWith({
                tag: sel.release.tag,
                version: sel.release.version || normalizeTagVersion(sel.release.tag),
                channel: sel.release.channel as Channel,
                notes: sel.release.notes ?? '',
                pub_date: sel.release.pub_date,
                signature,
                url: artUrl,
              });
            }
            // Tag known on the host but nothing updater-installable for this
            // machine (e.g. the .deb-only 0.0.9 Linux cut). A pre-rail tag may
            // still resolve via GitHub, so remember and fall through.
            staticRefusal = 'no_asset';
          }
        }
      } catch (e: unknown) {
        console.warn(
          `[updates/rollback] release host history fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // ── 2. GitHub — the legacy/hybrid fallback (pre-rail tags ≤ 0.0.7). ─────
    const token = await resolveGithubToken();
    if (!token) {
      console.warn('[updates/rollback] no GitHub token — cannot resolve rollback target');
      // A definite static verdict beats a credentials complaint: the host was
      // reachable and authoritative, so report what IT said about the tag.
      if (staticRefusal) return refusal(staticRefusal, { tag });
      return Response.json({ ok: false, reason: 'no_token' }, { status: 503 });
    }

    let releases: GhRelease[] | null;
    try {
      releases = await fetchReleases(token);
    } catch (e: unknown) {
      console.warn(`[updates/rollback] releases fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      if (staticRefusal) return refusal(staticRefusal, { tag });
      return Response.json({ ok: false, reason: 'fetch_failed' }, { status: 503 });
    }
    if (!releases) {
      if (staticRefusal) return refusal(staticRefusal, { tag });
      return Response.json({ ok: false, reason: 'fetch_failed' }, { status: 503 });
    }

    const selected = selectRollbackRelease(releases, { tag, channel });
    if (!selected.ok) return refusal(staticRefusal ?? selected.reason, { tag });
    const { release } = selected;

    const version = normalizeTagVersion(release.tag_name);

    const proxyBase = `${reqUrl.origin}/api/updates/download`;

    const respond = (signature: string, url: string) =>
      respondWith({
        tag: release.tag_name,
        version,
        channel: classifyChannel(release),
        notes: release.body ?? '',
        pub_date: release.published_at,
        signature,
        url,
      });

    // Primary path: a GitHub asset for this platform/product, signed with its .sig.
    const asset = pickAsset(release, target, arch, product);
    if (asset) {
      const sigAsset = findSigAsset(release, asset.name);
      const signature = sigAsset ? ((await fetchAssetText(sigAsset.id, token)) ?? '').trim() : '';
      if (!signature) {
        console.warn(`[updates/rollback] no signature for ${asset.name} in ${release.tag_name}`);
        return Response.json(
          { ok: false, reason: 'no_signature', tag: release.tag_name, version, asset: asset.name },
          { status: 409 },
        );
      }
      return respond(signature, `${proxyBase}?asset_id=${asset.id}&name=${encodeURIComponent(asset.name)}`);
    }

    // Fallback: the artifact is over GitHub's 2 GiB cap (Linux) — its filename +
    // inline minisign signature live in the release's papercusp-latest-<tag>.json,
    // served via the proxy's static release-host base (mirrors the manifest route).
    const latestAsset = findLatestJsonAsset(release);
    if (latestAsset && releaseHostBase() && product === 'gui') {
      try {
        const latest = JSON.parse((await fetchAssetText(latestAsset.id, token)) ?? 'null') as {
          platforms?: Record<string, { signature?: string; url?: string }>;
        } | null;
        const entry = latest?.platforms?.[platformKey];
        if (entry?.signature && entry.url) {
          const file = entry.url.split('/').pop() ?? '';
          return respond(
            entry.signature,
            `${proxyBase}?tag=${encodeURIComponent(release.tag_name)}&name=${encodeURIComponent(file)}`,
          );
        }
      } catch (e: unknown) {
        console.warn(
          `[updates/rollback] latest.json fallback failed for ${release.tag_name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return refusal('no_asset', { tag: release.tag_name, version, target, arch, product });
  },
});
