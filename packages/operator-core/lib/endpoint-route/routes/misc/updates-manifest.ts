/**
 * GET /api/updates/manifest — channel-aware release manifest for the
 * Tauri updater (alpha/beta/stable; 204 = no update).
 *
 * `auth: 'public'` — the Tauri updater polls this unauthenticated on loopback.
 *
 * TWO discovery sources, in priority order:
 *
 *  1. STATIC RELEASE HOST (PAPERCUSP_RELEASE_HOST) — AUTHORITATIVE when the host
 *     publishes a `<host>/latest.json`, and the supported path since releases
 *     went LOCAL-only (owner directive 2026-07-08: artifacts are built locally
 *     and uploaded by hand, never published to GitHub). Serves that manifest's
 *     inline signature + absolute artifact URL directly; GitHub is not consulted.
 *     ⚠ The uploaded manifest MUST be reachable at `<host>/latest.json`, and must
 *     be cut WITH PAPERCUSP_UPDATE_BASE_URL set — otherwise its urls are
 *     placeholders and this route refuses them (WI-4364).
 *
 *  2. GITHUB RELEASES (legacy) — when no release host is set, or the host
 *     publishes no latest.json (the HYBRID deployment: GitHub discovers the
 *     release, the host only serves bytes for assets over GitHub's 2 GiB cap).
 *     The release repo is PRIVATE, so this resolves a GitHub token server-side
 *     (gh CLI → credentials store → env; see updates-github.ts) and rewrites
 *     every artifact URL to the local `/api/updates/download` proxy, which
 *     streams the token-gated asset. Finds nothing under the local-only rail.
 *
 * Contract with tauri-plugin-updater (verified against 2.10.1 source,
 * desktop-auto-update-operational-2026-07-09 P-001/P-002):
 *   - `version` MUST parse as semver after trimming ONE leading "v" —
 *     tags here are `desktop-vX.Y.Z[-chan[.N]]`, so we normalize.
 *   - `signature` MUST be the minisign .sig CONTENT inline, not a URL.
 *   - Both the GUI and Server products poll this route; assets are
 *     product-named (`Papercusp GUI_…` / `Papercusp Server_…`, GitHub
 *     dot-renames spaces), so the `product` query param scopes matching.
 *   - Artifacts over GitHub's 2 GiB cap (Linux) are absent from the
 *     release; their filenames + inline sigs come from the release's
 *     `papercusp-latest-<tag>.json` and are served via the proxy's
 *     PAPERCUSP_RELEASE_HOST fallback.
 */
import { readOperatorState } from '../../../operator-state-pg';
import { defineTool } from '@papercusp/agent-mcp';
import {
  GITHUB_DESKTOP_REPO,
  fetchAssetText,
  githubApiHeaders,
  releaseHostBase,
  resolveGithubToken,
} from './updates-github';

export type Channel = 'alpha' | 'beta' | 'stable' | 'nightly';

/**
 * Every channel this route can RECOGNISE. Wider than the set a client may
 * select (see `UPDATE_LANES`) — recognising a channel is what lets it be
 * correctly EXCLUDED, and a channel we cannot name is a channel we mis-file.
 */
const CHANNELS = new Set<Channel>(['alpha', 'beta', 'stable', 'nightly']);

/**
 * The channels a client may ASK FOR — the update lanes of this application.
 *
 * Deliberately narrower than `CHANNELS`. `nightly` is a side-by-side build with
 * its own bundle id, name and data home (see @papercusp/tauri-release-kit's
 * channel model): it installs ALONGSIDE this app rather than updating it, so
 * "switch my install to nightly" is not a coherent request and must not be
 * honoured from a query param or a persisted preference.
 */
const UPDATE_LANES = new Set<Channel>(['alpha', 'beta', 'stable']);

type Product = 'gui' | 'server';

export interface GhAsset {
  id: number;
  name: string;
  browser_download_url: string;
}
export interface GhRelease {
  tag_name: string;
  name?: string;
  body?: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets: GhAsset[];
}
interface TauriManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}
/** Shape of the pipeline-generated `papercusp-latest-<tag>.json` asset. */
interface LatestJson {
  version?: string;
  channel?: string;
  notes?: string;
  pub_date?: string;
  platforms?: Record<string, { signature: string; url: string }>;
}

/**
 * The placeholder release-local.sh writes into latest.json when
 * PAPERCUSP_UPDATE_BASE_URL is unset (WI-4364). It must NEVER reach the
 * updater: handing a client a bogus URL turns a clean "no update" into a
 * failed download. Detect and refuse.
 */
const UPDATE_URL_PLACEHOLDER = 'papercusp-update-base-unset://';

/**
 * LOCAL-only release discovery (WI-4389). Fetches `<host>/latest.json` from the
 * static release host — no GitHub API, no token. This is the whole point: since
 * 2026-07-08 releases are NOT published to GitHub, so there is no release for
 * the GitHub path below to discover.
 *
 * WI-4404: `latest.json` is (and must stay) the GUI product's manifest ONLY —
 * a Server-role artifact colliding into the same `platforms` key under a
 * different product is exactly the WI-3696 clobber. The Server product gets
 * its OWN sibling manifest, `latest-server.json`, built by release-local.sh's
 * `build_platforms(..., want_token="Server", ...)` — pass `product` here to
 * fetch the right file. A missing `latest-server.json` (a cut that produced
 * no Server artifacts, or an older host that predates this fix) is the same
 * "no candidate" outcome as today: 404 → null → falls through / 204.
 */
export async function fetchStaticLatest(
  host: string,
  product: Product = 'gui',
): Promise<LatestJson | null> {
  const file = product === 'server' ? 'latest-server.json' : 'latest.json';
  const res = await fetch(`${host}/${file}`, { next: { revalidate: 60 } } as RequestInit);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`release host ${file}: ${res.status}`);
  return (await res.json()) as LatestJson;
}

/**
 * `desktop-v0.0.4-alpha` → `0.0.4-alpha` (valid semver). The Tauri
 * plugin only trims a single leading `v`, so serving the raw tag makes
 * every check fail with a version-parse error.
 */
export function normalizeTagVersion(tag: string): string {
  return tag.replace(/^desktop-v/i, '').replace(/^v/i, '');
}

/**
 * Recover a release's channel from its tag.
 *
 * ⚠ THE FALL-THROUGH IS `stable`, WHICH IS THE MOST DANGEROUS BUCKET. Every
 * channel that can be CUT must be recognised here explicitly: an unrecognised
 * suffix is not rejected, it is silently classified `stable` and offered to
 * every stable install. `-nightly` is matched for exactly that reason — a
 * nightly build is a different application, and reaching a stable user's
 * updater is the one outcome it must never have.
 */
export function classifyChannel(release: GhRelease): Channel {
  const tag = release.tag_name.toLowerCase();
  if (tag.includes('-nightly')) return 'nightly';
  if (tag.includes('-alpha')) return 'alpha';
  if (tag.includes('-beta') || tag.includes('-rc')) return 'beta';
  if (release.prerelease) return 'beta';
  return 'stable';
}

/**
 * Which channels' releases a client on `target` may be offered.
 *
 * The update lanes nest (alpha sees everything shipping, stable sees only
 * stable). `nightly` is NOT in any lane's visible set and no lane is in
 * nightly's: it is a separate installed application, so its releases and the
 * main app's must never cross.
 */
export function visibleChannels(target: Channel): ReadonlySet<Channel> {
  if (target === 'nightly') return new Set(['nightly']);
  if (target === 'alpha') return new Set(['alpha', 'beta', 'stable']);
  if (target === 'beta') return new Set(['beta', 'stable']);
  return new Set(['stable']);
}

export function platformKeyFor(target: string, arch: string): string | null {
  const t = target.toLowerCase();
  const a = arch.toLowerCase().replace(/-/g, '_');
  if (!['darwin', 'linux', 'windows'].includes(t)) return null;
  if (!['x86_64', 'aarch64', 'i686'].includes(a)) return null;
  return `${t}-${a}`;
}

/**
 * Which product an asset belongs to. Names look like
 * `Papercusp GUI_0.0.3_x64-setup.exe` / `Papercusp.Server.app.tar.gz`
 * (GitHub renames spaces to dots). Assets with neither token (the
 * pre-split era, e.g. `Papercusp_universal.app.tar.gz`) match either
 * product.
 */
function assetProduct(name: string): Product | 'any' {
  const n = name.toLowerCase();
  if (/(^|[\s._-])server([\s._-]|$)/.test(n)) return 'server';
  if (/(^|[\s._-])gui([\s._-]|$)/.test(n)) return 'gui';
  return 'any';
}

export function pickAsset(
  release: GhRelease,
  target: string,
  arch: string,
  product: Product = 'gui',
): GhAsset | null {
  const platform = platformKeyFor(target, arch);
  if (!platform) return null;
  const candidates = release.assets.filter((a) => {
    const name = a.name.toLowerCase();
    const p = assetProduct(a.name);
    if (p !== 'any' && p !== product) return false;
    // Tauri v2's Windows updater artifact is the bare NSIS `-setup.exe`
    // (or `.msi`) — v1's `.msi.zip`/`.exe.tar.gz` wrappers no longer
    // exist. Without this the endpoint 404'd on every real Windows
    // release (windows-desktop-release-readiness-2026-06-11 P-013).
    const winV2 = name.endsWith('-setup.exe') || name.endsWith('.msi');
    // Same v1→v2 shape on Linux (EI-333): the updater artifact is the bare
    // `.AppImage` (+ .sig) — the `.appimage.tar.gz` wrapper no longer exists.
    const linuxV2 = name.endsWith('.appimage');
    if (
      !name.endsWith('.tar.gz') &&
      !name.endsWith('.zip') &&
      !(target === 'windows' && winV2) &&
      !(target === 'linux' && linuxV2)
    )
      return false;
    if (target === 'darwin' && !name.includes('darwin') && !name.endsWith('.app.tar.gz')) return false;
    if (target === 'linux' && !name.includes('linux') && !name.endsWith('.appimage.tar.gz') && !linuxV2)
      return false;
    if (
      target === 'windows' &&
      !name.includes('windows') &&
      !name.endsWith('.msi.zip') &&
      !name.endsWith('.exe.tar.gz') &&
      !winV2
    )
      return false;
    // A macOS universal bundle (Papercusp_universal.app.tar.gz) serves every
    // darwin arch — without this the updater 404s on universal-only releases.
    if (target === 'darwin' && name.includes('universal')) return true;
    return (
      (arch === 'x86_64' && (name.includes('x86_64') || name.includes('x64') || name.includes('amd64'))) ||
      (arch === 'aarch64' && (name.includes('aarch64') || name.includes('arm64'))) ||
      (arch === 'i686' && (name.includes('i686') || name.includes('x86')))
    );
  });
  return candidates[0] ?? null;
}

/** Back-compat helper (tests + older callers). */
export function pickAssetUrl(
  release: GhRelease,
  target: string,
  arch: string,
  product: Product = 'gui',
): string | null {
  return pickAsset(release, target, arch, product)?.browser_download_url ?? null;
}

/**
 * Asset-name equality across GitHub's space→dot rename
 * ("Papercusp GUI.app.tar.gz" is stored as "Papercusp.GUI.app.tar.gz").
 */
function sameAssetName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[ .]/g, '.');
  return norm(a) === norm(b);
}

export function findSigAsset(release: GhRelease, assetName: string): GhAsset | null {
  return release.assets.find((a) => sameAssetName(a.name, `${assetName}.sig`)) ?? null;
}

export function findLatestJsonAsset(release: GhRelease): GhAsset | null {
  return (
    release.assets.find((a) => /^papercusp-latest-.*\.json$/i.test(a.name)) ??
    release.assets.find((a) => a.name.toLowerCase() === 'latest.json') ??
    null
  );
}

export async function fetchReleases(token: string | null): Promise<GhRelease[] | null> {
  const url = `https://api.github.com/repos/${GITHUB_DESKTOP_REPO}/releases?per_page=30`;
  const res = await fetch(url, {
    headers: githubApiHeaders(token),
    next: { revalidate: 60 },
  } as RequestInit);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github releases: ${res.status}`);
  return (await res.json()) as GhRelease[];
}

/**
 * The fallback channel for a client that expressed NO preference — no `?channel=`
 * query param AND no persisted `setup_wizard_state.update_channel`.
 *
 * 'alpha' during the alpha phase (WI-4389): alpha IS the public shipping channel
 * (release-local.sh treats it so — every cut ships on alpha), and there is no stable
 * release yet. A 'stable' default made `visibleChannels('stable')` = {stable} exclude
 * the ONLY releases that exist → 204 no_candidate → the updater was silently DOA for
 * every install that skipped the onboarding channel step (the manifest is polled with
 * no channel param, and a fresh install persists none). Flip to 'stable' at GA, when a
 * stable channel actually ships.
 */
export const DEFAULT_CHANNEL: Channel = 'alpha';

export function resolveChannel(params: URLSearchParams, override?: string): Channel {
  // UPDATE_LANES, not CHANNELS: a client may only ask for a lane of THIS app.
  // A `?channel=nightly` is a request to be updated into a different
  // application; it is ignored rather than honoured.
  const fromQuery = params.get('channel');
  if (fromQuery && UPDATE_LANES.has(fromQuery as Channel)) return fromQuery as Channel;
  if (override && UPDATE_LANES.has(override as Channel)) return override as Channel;
  return DEFAULT_CHANNEL;
}

/**
 * WI-3697: the tauri-plugin-updater protocol only distinguishes "update
 * available" (200 + manifest JSON) from "no update" (204) — it has no slot
 * for WHY there's no update, so this route historically returned a bare 204
 * for four genuinely different conditions: no GitHub token resolvable, the
 * GitHub fetch failing, no release matching the channel, and a genuine
 * version-equal match. A caller reading only the HTTP status (a preflight
 * script, an ops dashboard, or a future UI affordance) cannot tell "up to
 * date" from "couldn't check" — which cost a full diagnostic detour when a
 * no-token 204 was misread as "VM is up to date" (P-006/P-007).
 *
 * Fix: keep the WIRE PROTOCOL unchanged (204, empty body — the real Tauri
 * updater plugin parses neither headers nor a body on a 204, so this is
 * 100% back-compat) but stamp two extra response headers a caller CAN read
 * via a plain `fetch()`:
 *   - `X-Update-Check: up_to_date` for the genuine no-update case, or
 *     `X-Update-Check: cannot_check` for the four degrade-to-204 paths.
 *   - `X-Update-Reason: no_token|fetch_failed|no_candidate` on the
 *     cannot_check paths only (omitted on a genuine up_to_date 204).
 */
type UpdateCannotCheckReason =
  | 'no_token'
  | 'fetch_failed'
  | 'no_candidate'
  // WI-4364: the release host served a latest.json whose urls are still the
  // release-local.sh placeholder (PAPERCUSP_UPDATE_BASE_URL was never set at
  // cut time). Refusing is the honest answer — the manifest names a download
  // location that does not exist.
  | 'manifest_unconfigured'
  // WI-2144851: the artifact exists but carries no verifiable minisign
  // signature. Same principle as manifest_unconfigured one line up — an update
  // we cannot VERIFY is no more offerable than one we cannot DOWNLOAD.
  | 'no_signature';

function upToDateResponse(): Response {
  return new Response(null, { status: 204, headers: { 'X-Update-Check': 'up_to_date' } });
}

/**
 * Decide the response from an AUTHORITATIVE static-host latest.json (WI-4389).
 * Once the release host publishes a usable manifest it settles the question —
 * GitHub is never consulted, so every outcome (offer / up-to-date / refuse) is
 * returned from here.
 */
function staticManifestResponse(
  latest: LatestJson & { version: string; platforms: NonNullable<LatestJson['platforms']> },
  ctx: {
    host: string;
    channel: Channel;
    target: string;
    arch: string;
    product: Product;
    currentVersion: string;
  },
): Response {
  const { host, channel, target, arch, product, currentVersion } = ctx;

  // Honour the channel gate exactly as the GitHub path does.
  //
  // CHANNELS (every known channel), not UPDATE_LANES: a manifest's declared
  // channel must be PRESERVED so the gate below can exclude it. Narrowing here
  // would coerce `nightly` into the `stable` fall-through and hand a nightly
  // build to every stable install — the same mis-bucketing `classifyChannel`
  // guards against on the GitHub path. The fall-through itself stays for a
  // manifest that declares no channel at all (older manifests predate the
  // field); that case is genuinely unknown, not a channel we can name.
  const latestChannel = CHANNELS.has(latest.channel as Channel)
    ? (latest.channel as Channel)
    : 'stable';
  if (!visibleChannels(channel).has(latestChannel)) return cannotCheckResponse('no_candidate');

  if (currentVersion && latest.version === currentVersion) return upToDateResponse();

  const platformKey = platformKeyFor(target, arch);
  if (!platformKey) {
    return Response.json({ error: `unknown platform ${target}/${arch}` }, { status: 404 });
  }

  const entry = latest.platforms[platformKey];
  // The host answered with a usable manifest that carries NO build for this
  // platform: a platform-only release (e.g. Windows 0.0.23 on top of 0.0.22,
  // WI-10003699) or a platform whose build is not published yet. Either way no
  // newer build exists for THIS install, so it is up to date. Reporting
  // `no_candidate` here told Linux/macOS users "No releases are published for
  // the alpha channel yet", which was false.
  if (entry === undefined) return upToDateResponse();
  if (!entry?.url || !entry.signature) return cannotCheckResponse('no_candidate');

  // WI-4404/WI-3696 defense in depth: `fetchStaticLatest` already selected the
  // product-scoped file (latest.json vs latest-server.json), so this entry
  // SHOULD already be the right product — but never trust a filename
  // convention alone to keep a GUI artifact from reaching a Server poll (or
  // vice versa) on a hand-edited or stale manifest. Every artifact name is
  // stamped with its product token (WI-3696's own cut-time assertion
  // guarantees this at generation time), so cross-check here too.
  const entryLower = entry.url.toLowerCase();
  const looksLikeServer = entryLower.includes('server');
  if ((product === 'server') !== looksLikeServer) return cannotCheckResponse('no_candidate');

  if (entry.url.startsWith(UPDATE_URL_PLACEHOLDER)) {
    console.error(
      `[updates/manifest] release host ${host} is serving a latest.json with PLACEHOLDER urls ` +
        `(${entry.url}) — the cut ran without PAPERCUSP_UPDATE_BASE_URL. Refusing to offer an ` +
        `update that cannot be downloaded (WI-4364). Regenerate latest.json with the real base URL.`,
    );
    return cannotCheckResponse('manifest_unconfigured');
  }

  // The static host is public, so the artifact URL is served as-is — no
  // token-gated /api/updates/download proxy rewrite (that exists only for the
  // PRIVATE GitHub repo).
  return Response.json({
    version: latest.version,
    notes: latest.notes ?? '',
    pub_date: latest.pub_date ?? new Date().toISOString(),
    platforms: { [platformKey]: { signature: entry.signature, url: entry.url } },
  } satisfies TauriManifest);
}

function cannotCheckResponse(reason: UpdateCannotCheckReason): Response {
  return new Response(null, {
    status: 204,
    headers: { 'X-Update-Check': 'cannot_check', 'X-Update-Reason': reason },
  });
}

export default defineTool({
  method: 'GET',
  path: '/updates/manifest',
  auth: 'public',
  async handler(req) {
    const reqUrl = new URL(req.url);
    const params = reqUrl.searchParams;
    const target = params.get('target') ?? 'linux';
    const arch = params.get('arch') ?? 'x86_64';
    const currentVersion = params.get('current_version') ?? '';
    const product: Product = params.get('product') === 'server' ? 'server' : 'gui';

    const stored = await readOperatorState<{ update_channel?: string }>('setup_wizard_state');
    const channel = resolveChannel(params, stored?.update_channel);

    // ── LOCAL-only releases: the static release host is AUTHORITATIVE (WI-4389).
    //
    // [owner 2026-07-08, restated 07-12] "We are no longer using github for
    // our releases so just build the installer locally and I will upload it to
    // the right spot." Releases are therefore never published to GitHub — which
    // silently KILLED auto-update: the GitHub path below discovers candidates
    // from the releases API, finds nothing, and returns a 204 that the updater
    // reads as "you are up to date". Forever. An app installed from a
    // hand-uploaded 0.0.8 would never see 0.0.9.
    //
    // PAPERCUSP_RELEASE_HOST already existed, but ONLY as a DOWNLOAD fallback
    // reached AFTER a GitHub release was found (for assets over GitHub's 2 GiB
    // cap — which every Linux artifact now is). It was never a DISCOVERY path.
    // Now: if the host publishes a latest.json, it is the source of truth and
    // GitHub is not consulted (no token, no API call, no dependency on a repo we
    // don't publish to). If it doesn't, we fall through to the legacy GitHub
    // path — that's the HYBRID deployment, where the host only serves bytes.
    const host = releaseHostBase();
    if (host) {
      let latest: LatestJson | null = null;
      try {
        // WI-4404: a Server poll fetches its OWN sibling manifest
        // (latest-server.json), never latest.json — see fetchStaticLatest.
        latest = await fetchStaticLatest(host, product);
      } catch (e: unknown) {
        // A configured host that is unreachable is a TRANSIENT failure, not a
        // reason to silently consult GitHub — falling through there could offer
        // a stale GitHub release as a DOWNGRADE. Stay quiet; warn server-side.
        console.warn(
          `[updates/manifest] release host ${host} latest.json fetch failed — serving 204: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return cannotCheckResponse('fetch_failed');
      }

      // A host that publishes no usable manifest is NOT an error: that is the
      // HYBRID deployment (GitHub discovers the release; the host only serves
      // the bytes of artifacts over GitHub's 2 GiB cap). Fall through to the
      // GitHub path below. Only a host that DOES publish latest.json is
      // authoritative — and then every outcome is decided here.
      if (latest?.version && latest.platforms) {
        return staticManifestResponse(
          { ...latest, version: latest.version, platforms: latest.platforms },
          { host, channel, target, arch, product, currentVersion },
        );
      }
    }

    const token = await resolveGithubToken();
    if (!token) {
      // The repo is private: without a token the listing 404s and every
      // asset is unreachable. Stay quiet toward the updater (204 = up to
      // date) but keep the failure visible to ops.
      console.warn(
        '[updates/manifest] no GitHub token available (gh auth / github_pat / GITHUB_TOKEN) — serving 204 (no update offered)',
      );
      return cannotCheckResponse('no_token');
    }

    let releases: GhRelease[] | null;
    try {
      releases = await fetchReleases(token);
    } catch (e: unknown) {
      // A TRANSIENT inability to reach GitHub — rate-limit, 5xx, or a
      // network error — is NOT a client error. Returning 502 here made the
      // Tauri updater log a hard error on every poll. Degrade to 204 like
      // the 404 / no-candidate cases — the updater treats 204 as "up to
      // date" and stays quiet — while warning server-side.
      console.warn(
        `[updates/manifest] releases fetch failed — serving 204 (no update offered): ${e instanceof Error ? e.message : String(e)}`,
      );
      return cannotCheckResponse('fetch_failed');
    }
    if (!releases) return cannotCheckResponse('fetch_failed');

    const visible = visibleChannels(channel);
    const candidate = releases
      .filter((r) => !r.draft)
      .filter((r) => visible.has(classifyChannel(r)))
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];

    if (!candidate) return cannotCheckResponse('no_candidate');
    const candidateVersion = normalizeTagVersion(candidate.tag_name);
    if (currentVersion && candidateVersion === currentVersion) {
      return upToDateResponse();
    }

    const platformKey = platformKeyFor(target, arch);
    if (!platformKey) {
      return Response.json({ error: `unknown platform ${target}/${arch}` }, { status: 404 });
    }
    const proxyBase = `${reqUrl.origin}/api/updates/download`;

    const asset = pickAsset(candidate, target, arch, product);
    if (asset) {
      const sigAsset = findSigAsset(candidate, asset.name);
      const signature = sigAsset ? ((await fetchAssetText(sigAsset.id, token)) ?? '').trim() : '';
      if (!signature) {
        // WI-2144851. This used to warn and serve the manifest with an empty
        // signature — the warning below literally said "install will fail
        // verification", and it was right: the updater rejects it, but only
        // AFTER pulling down a multi-GB artifact. Every fact needed to refuse
        // is already in hand here, so refuse.
        //
        // Deliberately a return, not a fall-through to the latest.json branch
        // below: that branch resolves a possibly DIFFERENT artifact, and
        // quietly substituting one for the one pickAsset chose is a bigger
        // behaviour change than this fix is entitled to make.
        console.warn(
          `[updates/manifest] no signature for ${asset.name} in ${candidate.tag_name} — refusing to offer an unverifiable update`,
        );
        return cannotCheckResponse('no_signature');
      }
      const manifest: TauriManifest = {
        version: candidateVersion,
        notes: candidate.body ?? '',
        pub_date: candidate.published_at,
        platforms: {
          [platformKey]: {
            signature,
            url: `${proxyBase}?asset_id=${asset.id}&name=${encodeURIComponent(asset.name)}`,
          },
        },
      };
      return Response.json(manifest);
    }

    // No GitHub asset for this platform/product — the artifact may be over
    // GitHub's 2 GiB cap (Linux). The pipeline's latest.json still lists it
    // (filename + INLINE minisign signature); serve it via the proxy's
    // static release-host fallback when one is configured.
    const latestAsset = findLatestJsonAsset(candidate);
    if (latestAsset && releaseHostBase()) {
      try {
        const latest = JSON.parse(
          (await fetchAssetText(latestAsset.id, token)) ?? 'null',
        ) as LatestJson | null;
        const entry = latest?.platforms?.[platformKey];
        // latest.json is currently generated for the GUI product only.
        if (entry?.signature && entry.url && product === 'gui') {
          const file = entry.url.split('/').pop() ?? '';
          return Response.json({
            version: latest?.version ?? candidateVersion,
            notes: latest?.notes ?? candidate.body ?? '',
            pub_date: latest?.pub_date ?? candidate.published_at,
            platforms: {
              [platformKey]: {
                signature: entry.signature,
                url: `${proxyBase}?tag=${encodeURIComponent(candidate.tag_name)}&name=${encodeURIComponent(file)}`,
              },
            },
          } satisfies TauriManifest);
        }
      } catch (e: unknown) {
        console.warn(
          `[updates/manifest] latest.json fallback failed for ${candidate.tag_name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // A release can legitimately omit a platform/product artifact (for
    // example, the current release may publish desktop installers but no
    // Linux asset). This is an expected no-update result for the updater, not
    // a malformed request: returning 404 makes tauri-plugin-updater log a
    // failed check on every poll. Keep the wire contract at 204 and preserve
    // the diagnostic reason for plain fetch callers.
    return cannotCheckResponse('no_candidate');
  },
});
