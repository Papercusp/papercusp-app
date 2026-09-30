/**
 * record-release-cli — write a cut into the release registry, and regenerate the
 * static beta release-history site from it. (WI-4446.)
 *
 *   tsx apps/operator/lib/release/record-release-cli.ts \
 *       --version 0.0.9 --channel alpha --git-sha <sha> \
 *       --changelog-file /path/to/changelog.md
 *
 *   ... --dry-run            # print what it WOULD record + write; touch nothing
 *   ... --no-changelog       # explicitly record without changelog text (audited escape hatch)
 *   ... --since 2026-07-05   # explicit window start (overrides the default lookback)
 *   ... --out <dir>          # where the generated site lands (default: <bundle>/release-history)
 *
 * Runs AFTER the cut (release-local.sh builds + signs + writes latest.json and
 * stops). Publishing the generated site is a separate step —
 * `papercusp-desktop/bin/publish-release-history.sh` — for the same reason the
 * artifact upload is separate: writing bytes and publishing them are different
 * decisions with different blast radii.
 *
 * ⛔ THE SECRET NEVER ENTERS POSTGRES. Artifact urls are stored RELATIVE
 * (`desktop-v0.0.9-alpha/Papercusp_GUI_0.0.9_amd64.AppImage`), never absolute.
 * The base is the secret path segment; putting it in a row would copy it into
 * every backup, replica, sync projection and pg_dump we own — and this table is
 * read by surfaces that render to a UI. Each consumer resolves the relative url
 * against the base it already holds: the static page does it with plain relative
 * links (it IS at the base), and /api/updates/history prefixes releaseHostBase().
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import postgres from 'postgres';
import {
  getOwnerDirective,
  type OwnerDirectiveRow,
} from '@papercusp/operator-core/lib/owner-directives';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { getHarnessAdminUrl } from '@papercusp/operator-core/lib/embedded-pg-discovery';
import { POSTHOG_PUBLIC_DEFAULTS } from '@papercusp/operator-core/lib/posthog-public-defaults';
import {
  hydrateRelease,
  listReleases,
  previousCutAt,
  recordRelease,
  snapshotWindow,
  type ReleaseArtifact,
  type ReleaseRow,
  type Scope,
} from './release-registry';
import {
  REQUIRED_DESKTOP_PLATFORMS,
  REQUIRED_DESKTOP_PRODUCTS,
  computeReleaseCompleteness,
  computeMobileRegression,
  type RequiredDesktopProduct,
  type RequiredDesktopPlatform,
  type MissingArtifactSlot,
} from './release-completeness';
// Re-exported for back-compat: callers (record-release-cli.test.ts, page renderer)
// import the completeness matrix from here. The definitions now live in the pure,
// dependency-free release-completeness.ts so preflight-build-set.ts can reuse the
// matrix without this CLI's fs/os/postgres surface.
export {
  REQUIRED_DESKTOP_PLATFORMS,
  REQUIRED_DESKTOP_PRODUCTS,
  computeReleaseCompleteness,
  computeMobileRegression,
  type RequiredDesktopProduct,
  type RequiredDesktopPlatform,
  type MissingArtifactSlot,
};
import { generateChangelog } from './changelog-generate';
import { OWNER_NAME_ENV, hasOwnerNameLiteral, identityLiterals } from './release-content-scrub';
import { describeOwnerIdentityLoad, loadOwnerIdentityEnv } from './owner-identity-env';
import { incompleteDesktopScopeRefusal } from './release-owner-approval';
export { incompleteDesktopScopeRefusal } from './release-owner-approval';
import { partialScopeApprovalNote } from './release-partial-scope';
import {
  assertReleaseHistoryIndexSizeBudget,
  planPagePath,
  renderHistoryJson,
  renderHoldingHtml,
  renderIndexHtml,
  renderPlanPageHtml,
  renderWorkItemPageHtml,
  renderProjectHistoryPage,
  workItemPagePath,
  type HydratedRelease,
} from './release-history-page';
import { buildReleaseHistoryAssets, releaseHistoryStem, releaseProjectHistory } from './release-project-history';
import { SiteWriteTally } from './release-site-delta';

/** Default maximum gap included in a newly recorded release snapshot. `--since`
 * explicitly overrides this bound for a deliberate historical backfill. */
export const DEFAULT_RELEASE_LOOKBACK_DAYS = 14;

/** Choose the changelog snapshot's lower bound without applying a new default cap
 * to an existing-version re-record. Existing-version re-records add late platform
 * artifacts; `--since` remains the explicit override for either path. */
export function resolveChangelogWindowStart(
  cutAt: Date,
  previousCutAt: Date | null,
  explicitSince: Date | null,
  reRecordingExistingVersion = false,
): Date {
  if (explicitSince) return explicitSince;
  const defaultStart = new Date(cutAt.getTime() - DEFAULT_RELEASE_LOOKBACK_DAYS * 86_400_000);
  const naturalStart = previousCutAt ?? defaultStart;
  if (reRecordingExistingVersion) return naturalStart;
  return naturalStart.getTime() < defaultStart.getTime() ? defaultStart : naturalStart;
}

/** This recorder writes Papercusp's workspace-level registry and public bucket/page. */
export const PAPERCUSP_RELEASE_PRODUCT_NAME = 'Papercusp';

export interface RecordOpts {
  version: string;
  channel: string;
  gitSha: string | null;
  cutAt: Date;
  since: Date | null;
  changelogMd: string | null;
  /** Permit a changelog-less cut only when the caller makes that choice explicit. */
  allowNoChangelog?: boolean;
  ownerApprovedPartialScopeOrderId?: number | null;
  /** EVERY platform's bundle root — see `releaseBundleRoots`. Not just linux. */
  bundleDirs: string[];
  /** The papercup-rust-mobile repo root (Android/iOS artifacts); null to skip mobile. */
  mobileRoot: string | null;
  /** Brand stem used for synthesized mobile download names (defaults to Papercusp). */
  mobileProductName: string;
  /** Explicit desktop/iOS-only escape hatch. Raw Android outputs are otherwise rejected. */
  skipAndroid: boolean;
  outDir: string;
  scope: Scope;
  cutBy: string | null;
  dryRun: boolean;
  /** Generate a changelog DRAFT for the window and stop — do not record. The draft
   *  is reviewed, then recorded via `--changelog-file`. (owner ask #4.) */
  genChangelog: boolean;
  /** Re-roll the draft even if one already exists on disk. */
  forceChangelog: boolean;
}

/**
 * What platform/product is this artifact? Pure, so the mapping is tested rather
 * than discovered in production. Returns null for things that are not a
 * user-installable artifact (signatures, checksums, stray files).
 */
export function classifyArtifact(name: string): Pick<ReleaseArtifact, 'product' | 'platform'> | null {
  if (name.endsWith('.sig') || name.endsWith('.sha256')) return null;
  // Mobile products FIRST — a phone app is its own `product`, independent of the
  // gui/server split (it is neither a desktop GUI nor a headless server). Keeping
  // them a distinct product is what lets the page give them their own "Mobile
  // apps" section and keeps them out of the desktop auto-update manifest.
  if (/\.(apk|aab)$/i.test(name)) return { product: 'mobile', platform: 'android-universal' };
  if (/\.ipa$/i.test(name)) return { product: 'mobile', platform: 'ios-arm64' };
  const product: 'gui' | 'server' = /server/i.test(name) ? 'server' : 'gui';
  if (/\.(deb|AppImage)$/.test(name)) return { product, platform: 'linux-x86_64' };
  if (/\.(dmg)$/.test(name) || /\.app\.tar\.gz$/.test(name)) return { product, platform: 'darwin-universal' };
  if (/\.(exe|msi)$/.test(name)) return { product, platform: 'windows-x86_64' };
  // WI-5600: the Windows Server DiskSpans — it bundles the dogfood source tree
  // (source.tar.zst, staged by default), pushing the payload past Inno's ~4GB
  // single-exe ceiling, so Inno emits a `…-setup.exe` stub + `…-setup-N.bin`
  // disks (isSpannedInstaller). A bare spanned stub is unpublishable — it would
  // offer a download that can't install — so release-local.sh normalizes the span
  // into ONE `…-setup.zip` the release page offers and the tester unzips + runs.
  // Recognize that zip as the Windows installer it is. Scoped to the `-setup.zip`
  // suffix that step produces, so an unrelated `.zip` is NOT misclassified.
  if (/-setup\.zip$/i.test(name)) return { product, platform: 'windows-x86_64' };
  return null;
}

const PLATFORM_LABEL: Record<string, string> = {
  'linux-x86_64': 'Linux (x86_64)',
  'darwin-universal': 'macOS (universal)',
  'windows-x86_64': 'Windows (x64)',
  'android-universal': 'Android',
  'ios-arm64': 'iOS (arm64)',
};

/**
 * A prominent, unmissable alert naming every expected-but-absent desktop artifact
 * for a version. Returns the block as a string so the record path and the regenerate
 * path render it identically. Empty string when the release is complete.
 */
export function formatCompletenessAlert(
  version: string,
  channel: string,
  missing: MissingArtifactSlot[],
): string {
  if (missing.length === 0) return '';
  const rule = '  ══════════════════════════════════════════════════════════════════';
  const lines: string[] = ['', rule, `  ⚠  INCOMPLETE RELEASE: ${version} (${channel})`, rule];
  lines.push('  Expected installers NOT yet uploaded for this version:');
  for (const m of missing) {
    lines.push(`    ✗ ${m.product.toUpperCase().padEnd(6)} · ${PLATFORM_LABEL[m.platform] ?? m.platform}`);
  }
  lines.push('');
  lines.push('  This incomplete scope is NOT an owner approval. Recording it requires');
  lines.push('  an explicit owner directive via --owner-approved-partial-scope <owner-directive-id>.');
  lines.push('  Otherwise upload the missing artifact(s) and re-record / regenerate.');
  lines.push(rule);
  lines.push('');
  return lines.join('\n');
}

/**
 * Record-time changelog policy. A release cut must carry reviewed changelog text
 * by default; the only way to intentionally omit it is the explicit
 * `--no-changelog` escape hatch. Registry rows and page rendering still accept
 * historical NULL values — this guard protects only new recording operations.
 */
export function validateRecordChangelog(
  changelogMd: string | null,
  allowNoChangelog = false,
): string | null {
  if (allowNoChangelog || (changelogMd != null && changelogMd.trim().length > 0)) return null;
  return [
    '[record-release] 🔴 REFUSING TO RECORD — no changelog text was supplied.',
    '  Generate and review a draft first with --generate-changelog, then re-run with --changelog-file <path>.',
    '  If this release intentionally has no changelog, pass --no-changelog explicitly.',
  ].join('\n');
}

/**
 * Print the completeness alert for EVERY recorded release that is incomplete.
 * Runs on --regenerate so an agent who just uploaded a missing artifact and
 * re-rendered the page still SEES what remains absent per version — a partial
 * release is never silently normalized. NON-BLOCKING.
 */
export async function warnIncompleteReleases(sql: postgres.Sql, scope: Scope): Promise<number> {
  const rows = await listReleases(sql, scope.workspaceId);
  const incomplete = rows
    .map((r) => ({ r, c: computeReleaseCompleteness(r.artifacts) }))
    .filter((x) => !x.c.complete);
  if (incomplete.length === 0) return 0;
  console.warn(
    `\n[record-release] ${incomplete.length} recorded release(s) are INCOMPLETE ` +
      `(missing expected installers — confirm each is intentional):`,
  );
  for (const { r, c } of incomplete) console.warn(formatCompletenessAlert(r.version, r.channel, c.missing));
  return incomplete.length;
}

/**
 * A prominent, unmissable alert when a cut LOSES a mobile platform its predecessor
 * carried (WI-5583). Mobile is never REQUIRED (a desktop-only cut is complete), so
 * absolute absence prints nothing — but a REGRESSION (0.0.11 shipped Android+iOS,
 * 0.0.12 shipped neither) is a concrete drop worth a conscious confirmation, and
 * `computeReleaseCompleteness` deliberately ignores mobile, so it never surfaced.
 * NON-BLOCKING by design — same as the desktop alert: make the omission a CHOICE,
 * not a stop. Empty string when nothing regressed.
 */
export function formatMobileRegressionAlert(
  version: string,
  channel: string,
  previousVersion: string | null,
  dropped: string[],
): string {
  if (dropped.length === 0) return '';
  const rule = '  ══════════════════════════════════════════════════════════════════';
  const prevLabel = previousVersion ? ` ${previousVersion}` : ' the previous release';
  const lines: string[] = ['', rule, `  ⚠  MOBILE REGRESSION: ${version} (${channel})`, rule];
  lines.push(`  ${prevLabel.trim()} shipped mobile apps this cut does NOT carry:`);
  for (const p of dropped) lines.push(`    ✗ MOBILE  · ${PLATFORM_LABEL[p] ?? p}`);
  lines.push('');
  lines.push('  This is NOT a rejection. But CONFIRM the drop is intentional (e.g. the');
  lines.push('  mobile leg was skipped this cut) — or the mobile artifacts were built but');
  lines.push('  not recorded: re-run with --mobile-root pointing at the phone build, or');
  lines.push('  confirm they exist on disk. (Mobile filenames carry no version, so a');
  lines.push('  backfill records whatever bytes are present AS this version — make sure');
  lines.push('  they are THIS cut, not a stale prior build.)');
  lines.push(rule);
  lines.push('');
  return lines.join('\n');
}

/**
 * Print a mobile-regression alert for EVERY recorded release that dropped a mobile
 * platform its immediate same-channel predecessor carried. Sibling of
 * warnIncompleteReleases — runs on --regenerate so a silent mobile drop stays
 * surfaced until it is confirmed or the artifacts are recorded. NON-BLOCKING.
 */
export async function warnMobileRegressions(sql: postgres.Sql, scope: Scope): Promise<number> {
  const rows = await listReleases(sql, scope.workspaceId); // newest cut first, all channels
  // Group by channel, then walk newest→older so each release's predecessor is the
  // next element — the same "immediately-previous same-channel release" the record
  // path compares against.
  const byChannel = new Map<string, ReleaseRow[]>();
  for (const r of rows) {
    const list = byChannel.get(r.channel) ?? [];
    list.push(r);
    byChannel.set(r.channel, list);
  }
  let count = 0;
  for (const channelRows of byChannel.values()) {
    for (let i = 0; i < channelRows.length - 1; i++) {
      const cur = channelRows[i];
      const prev = channelRows[i + 1];
      const { dropped } = computeMobileRegression(cur.artifacts, prev.artifacts);
      if (dropped.length === 0) continue;
      if (count === 0) console.warn(`\n[record-release] mobile regression(s) — a cut lost a phone build its predecessor had:`);
      console.warn(formatMobileRegressionAlert(cur.version, cur.channel, prev.version, dropped));
      count++;
    }
  }
  return count;
}

/** `desktop-v0.0.9-alpha` — the object-key directory a cut's artifacts live under. */
export function releaseTag(version: string, channel: string): string {
  return channel === 'stable' ? `desktop-v${version}` : `desktop-v${version}-${channel}`;
}

/**
 * Persistent SHA-256 cache keyed by (absolute path, size, mtimeMs).
 *
 * A tri-platform cut is ~18 GB of artifacts (two ~4 GB debs, a 4 GB AppImage,
 * plus ~2 GB each for the dmg / app.tar.gz / setup.exe), and record-release-cli
 * re-hashed ALL of it on EVERY run. So a re-publish that only ADDED one platform
 * (e.g. dropping mac onto an already-published linux+windows cut) still spent
 * tens of seconds re-SHA-256-ing the UNCHANGED linux+windows bytes — which is why
 * "regenerating the simple index.html" was never actually fast. Caching the
 * digest by content-identity (size+mtime) means an unchanged artifact is hashed
 * exactly ONCE, ever: an incremental re-publish hashes only the genuinely-new
 * files, and a no-op re-run is instant. The cache is advisory — a miss (or an
 * absent/corrupt cache file) simply re-hashes, so it can never ship a wrong sum.
 */
const SHA_CACHE_PATH = path.join(os.homedir(), '.papercusp', 'release-sha256-cache.json');
type ShaCacheEntry = { size: number; mtimeMs: number; sha256: string };
let shaCache: Record<string, ShaCacheEntry> | null = null;
function loadShaCache(): Record<string, ShaCacheEntry> {
  if (!shaCache) {
    try {
      shaCache = JSON.parse(fs.readFileSync(SHA_CACHE_PATH, 'utf8')) as Record<string, ShaCacheEntry>;
    } catch {
      shaCache = {};
    }
  }
  return shaCache;
}
function saveShaCache(): void {
  if (!shaCache) return;
  try {
    fs.mkdirSync(path.dirname(SHA_CACHE_PATH), { recursive: true });
    const tmp = `${SHA_CACHE_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(shaCache));
    fs.renameSync(tmp, SHA_CACHE_PATH); // atomic swap — safe under concurrent cuts
  } catch {
    /* advisory cache: a write failure just means the next run re-hashes */
  }
}

/**
 * Hash the file in CHUNKS, never with readFileSync — cached by (path,size,mtime).
 *
 * Node's readFileSync throws ERR_FS_FILE_TOO_LARGE above 2 GiB — and EVERY real
 * artifact here is 3-4 GB, so the naive version worked on test fixtures and blew
 * up on the first genuine release. Hash the stream instead: constant memory,
 * no size ceiling. The cache (above) skips the multi-GB read entirely when the
 * artifact is unchanged since a prior run.
 */
function sha256File(file: string): string {
  const st = fs.statSync(file);
  const key = path.resolve(file);
  const cache = loadShaCache();
  const hit = cache[key];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha256;
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20); // 1 MiB
    let read: number;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  const digest = hash.digest('hex');
  cache[key] = { size: st.size, mtimeMs: st.mtimeMs, sha256: digest };
  saveShaCache();
  return digest;
}

/**
 * The bundle ROOTS a tri-platform cut writes to — ONE PER LEG, in three different
 * trees. This is the whole reason 0.0.8 shipped a Linux-only release page.
 *
 * Each leg of release-local.sh drops its bundle somewhere different:
 *   - linux   → $CARGO_TARGET_DIR/release/bundle          (deb/, appimage/)
 *   - mac     → src-tauri/target/universal-apple-darwin/… (dmg/, macos/)   [rsync'd back from the mac VM]
 *   - windows → src-tauri/target/windows-vm/bundle        (inno/)          [rsync'd back from the win VM]
 *
 * scanArtifacts used to take a SINGLE dir defaulting to the linux one, so the mac
 * and windows bytes — which were built, signed, and sitting on disk the whole time
 * — were never even looked at. `classifyArtifact` already knew how to label a .dmg
 * and a .exe; nothing ever handed it one. The page then advertised "0.0.8" to every
 * beta tester while offering a Mac or Windows user nothing to download, and the
 * same history.json drives the in-app Update Center, so those platforms had no
 * update path either. A recorder that silently records a THIRD of a release is
 * worse than one that fails: the output looks complete.
 */
/**
 * Locate `papercusp-desktop/` — the tree the mac + windows legs bundle into.
 *
 * Walks up from cwd rather than assuming the repo root, so the CLI still finds the
 * mac/windows artifacts when it is invoked from a subdirectory. `--desktop-root` /
 * PAPERCUSP_DESKTOP_ROOT override it. Returning a path that does not exist is fine:
 * scanArtifacts skips absent roots, and the missing-platform warning then fires —
 * which is the loud failure we want, not a silent linux-only record.
 */
export function resolveDesktopRoot(startDir: string = process.cwd()): string {
  const env = process.env.PAPERCUSP_DESKTOP_ROOT;
  if (env) return env;
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'papercusp-desktop');
    if (fs.existsSync(path.join(cand, 'src-tauri'))) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(path.resolve(startDir), 'papercusp-desktop');
}

/**
 * Locate `papercup-rust-mobile` — the SEPARATE repo (a sibling of the papercup
 * checkout, NOT a submodule) that holds the Android/iOS sources + build outputs.
 *
 * Returns null when it can't be found: mobile is OPTIONAL, and a null root makes
 * scanMobileArtifacts a no-op, so a desktop-only cut stays legal and silent.
 * `--mobile-root` / PAPERCUSP_MOBILE_ROOT override.
 */
export function resolveMobileRoot(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    for (const cand of [
      path.join(dir, 'papercup-rust-mobile'),
      path.join(path.dirname(dir), 'papercup-rust-mobile'),
    ]) {
      if (fs.existsSync(path.join(cand, 'crates')) || fs.existsSync(path.join(cand, 'Makefile'))) {
        return cand;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Is this `.exe` an Inno SPANNED installer — a small bootstrap whose real payload
 * lives in sibling `-1.bin`, `-2.bin`, … disks?
 *
 * Detected structurally (do the companion disks exist?) rather than by a size
 * threshold, because "how big is too small for an installer" is a guess that goes
 * stale, while the `-N.bin` siblings are exactly what Inno writes when it spans.
 * Exported so the rule is unit-testable rather than discovered by a beta tester
 * whose install failed.
 */
export function isSpannedInstaller(dir: string, name: string): boolean {
  if (!/\.exe$/i.test(name)) return false;
  const base = name.replace(/\.exe$/i, '');
  return fs
    .readdirSync(dir)
    .some((f) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.bin$`, 'i').test(f));
}

/**
 * Minimum plausible size for ANY installer/app artifact this recorder ships, in
 * bytes. Below this floor, a file cannot possibly BE what its name claims no
 * matter how well the name/extension match — every real product here (deb,
 * AppImage, dmg, exe, msi, the normalized spanned-installer zip, apk, aab, ipa) is,
 * in practice, multiple megabytes.
 *
 * This is the RESIDUAL half of the EI-18103803991060000 / EI-18673480587329034
 * AppleDouble finding: the `._` skip above catches ONE known-implausible shape (a
 * resource-fork sidecar, by NAME); this catches EVERY implausible shape by SIZE
 * alone — a truncated copy from an interrupted rsync, a 0-byte placeholder, a
 * partially-written file — none of which carry a `._` prefix or any other
 * name-based tell. Structural (a real size check), not a name heuristic — same
 * spirit as `isSpannedInstaller` being a structural (companion-file) check rather
 * than a size guess.
 */
export const MIN_PLAUSIBLE_ARTIFACT_BYTES = 1024 * 1024; // 1 MiB

export const ANDROID_RELEASE_PROVENANCE_PATH =
  'android/app/build/outputs/papercusp-release-provenance.json';
const ANDROID_RELEASE_APK_PATH = 'android/app/build/outputs/apk/release/app-release.apk';
const ANDROID_RELEASE_AAB_PATH = 'android/app/build/outputs/bundle/release/app-release.aab';

interface AndroidProvenanceArtifact {
  kind: 'apk' | 'aab';
  path: string;
  size: number;
  sha256: string;
}

interface AndroidReleaseProvenance {
  schemaVersion: 1;
  releaseVersion: string;
  sourceCommit: string;
  sourceDirty: false;
  builtAt: string;
  artifacts: {
    apk: AndroidProvenanceArtifact;
    aab: AndroidProvenanceArtifact;
  };
}

/**
 * Is this file too small to plausibly BE the installer/app its name claims?
 * Exported so the floor is unit-testable on its own, and so callers other than
 * `scanArtifacts`/`scanMobileArtifacts` (any future artifact source) can reuse the
 * exact same rule rather than re-guessing a threshold.
 */
export function isImplausiblyTiny(size: number): boolean {
  return size < MIN_PLAUSIBLE_ARTIFACT_BYTES;
}

/**
 * Where cargo BUILDS the linux bundle — honoring the box-global `[build] target-dir`
 * (this dev box: `~/.cargo-target`) exactly the way the old default did.
 *
 * This is where the linux artifacts are BORN, and — since 2026-07-09 — no longer
 * where they LIVE: see `collectedLinuxBundleRoot`. Kept as a scan root so a raw
 * `tauri build` that never went through bin/build-linux-local.sh is still found.
 */
export function cargoTargetBundleRoot(): string {
  return path.join(
    process.env.CARGO_TARGET_DIR ?? `${process.env.HOME}/.cargo-target`,
    'release/bundle',
  );
}

/**
 * Where the linux artifacts actually END UP: `bin/build-linux-local.sh` COLLECTS
 * (mv, same-filesystem rename) the finished .deb/.AppImage/.sig out of cargo's real
 * target dir and into `src-tauri/target/release/bundle`, so all three legs share one
 * tree. Must stay equal to that script's `DEST_BUNDLE` — asserted by the
 * producer/consumer guard in record-release-cli.test.ts.
 */
export function collectedLinuxBundleRoot(desktopRoot: string): string {
  return path.join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle');
}

/**
 * EI-18103803991060000 — the linux root moved and the recorder never followed.
 *
 * `build-linux-local.sh` MOVES the finished linux artifacts out of
 * `$CARGO_TARGET_DIR/release/bundle` into `src-tauri/target/release/bundle`, leaving
 * behind only tauri's INTERMEDIATE staging dirs (`deb/Papercusp GUI_0.0.12_amd64/`
 * with no .deb) and an EMPTY `appimage/`. The recorder still scanned only the dir the
 * bytes were moved OUT of, so it found zero linux artifacts — and, because a missing
 * root is deliberately not an error and the completeness alert is deliberately
 * NON-FATAL (a partial cut is legal), it recorded a linux-less release and exited 0.
 * Scanning a wrong directory was indistinguishable from a deliberate partial cut.
 *
 * Both roots are scanned now, so it is correct whichever way the leg was built.
 * `scanArtifacts` dedups by filename, so an overlap (a checkout where cargo already
 * targets the source tree) records each artifact once.
 */
export function releaseBundleRoots(linuxBundleDir: string, desktopRoot: string): string[] {
  return [
    ...new Set([
      linuxBundleDir,
      collectedLinuxBundleRoot(desktopRoot),
      cargoTargetBundleRoot(),
      path.join(desktopRoot, 'src-tauri', 'target', 'universal-apple-darwin', 'release', 'bundle'),
      path.join(desktopRoot, 'src-tauri', 'target', 'windows-vm', 'bundle'),
    ]),
  ];
}

/**
 * Find this version's artifacts on disk and describe them. The URL is RELATIVE —
 * see the module header.
 *
 * Scans EVERY bundle root (see `releaseBundleRoots`). A missing root is not an
 * error — a linux-only cut simply has no mac/windows tree — but it IS the caller's
 * job to notice a leg went missing; see the per-platform report in `run()`.
 */
export function scanArtifacts(
  bundleDirs: string[],
  version: string,
  tag: string,
): ReleaseArtifact[] {
  // `inno` is the Windows one, and its absence here is precisely why no Windows
  // installer has ever been recorded: tauri builds the Windows setup with Inno
  // Setup, which writes to inno/ — never to the nsis/ or msi/ dirs this list used
  // to stop at.
  const subdirs = ['deb', 'appimage', 'dmg', 'macos', 'nsis', 'msi', 'inno'];
  const found: ReleaseArtifact[] = [];
  const seen = new Set<string>();
  for (const bundleDir of bundleDirs) {
    for (const sub of subdirs) {
      const dir = path.join(bundleDir, sub);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.includes(version)) continue;
        // AppleDouble sidecars. Copying a mac bundle over a non-HFS transport (the
        // rsync back from the mac VM, an SMB/exFAT hop) leaves a 245-byte
        // `._Papercusp GUI_0.0.12_universal-apple-darwin.dmg` beside the real one —
        // same name but for the `._`, so classifyArtifact happily calls it a
        // universal DMG. Found live on 2026-07-26: the real 0.0.12 dmgs had since
        // been cleaned off the box and ONLY the sidecars remained, so the next
        // re-record (the runbook says to re-run this after each leg uploads, and it
        // is idempotent per version) would have REPLACED two correct 1.3 GB mac
        // entries with 245-byte ones — a Mac tester downloading resource-fork
        // metadata. Same rule as isSpannedInstaller: a download that cannot install
        // is worse than an absent one, because the page looks complete.
        if (name.startsWith('._')) continue;
        const kind = classifyArtifact(name);
        if (!kind) continue;
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        // NEVER record an installer we KNOW is incomplete. Inno Setup emits a
        // SPANNED installer when the payload is large: `foo-setup.exe` becomes a
        // ~3 MB bootstrap that reads `foo-setup-1.bin`, `-2.bin`, … from beside it.
        // Recorded alone, that stub downloads perfectly and then fails at install —
        // and the release page would show it with a confident size and sha256. An
        // artifact that cannot install is worse than an absent one: the absent one
        // is honest. Skip it (loudly) until the companions are published too.
        if (isSpannedInstaller(dir, name)) {
          console.warn(
            `  ⚠ SKIPPING ${name} — spanned Inno installer (payload is in its *-N.bin disks, which are not published). ` +
              `Recording the stub alone would offer a download that cannot install.`,
          );
          continue;
        }
        // EI-18673480587329034 — the recorder had no plausibility floor at all: it
        // would record ANY version-matching, extension-classified file at whatever
        // size it happened to be. A truncated .deb from an interrupted copy, a
        // 0-byte placeholder, or a partially-rsynced .dmg all look identical to a
        // real installer to the checks above (name + extension), and would be
        // published with a confident size + sha256. Same principle as the spanned
        // check above: a download that cannot install is worse than an absent one.
        if (isImplausiblyTiny(stat.size)) {
          console.warn(
            `  ⚠ SKIPPING ${name} — only ${stat.size} byte(s), far below any real installer ` +
              `(floor: ${MIN_PLAUSIBLE_ARTIFACT_BYTES.toLocaleString()} bytes). Likely a truncated ` +
              `copy, an empty placeholder, or a partial transfer — recording it would publish a ` +
              `download that cannot install.`,
          );
          continue;
        }
        // The same artifact can be reachable from two roots (a salvage/reuse path
        // rsyncs bytes into a second tree). Record it once — a duplicated row would
        // show the tester the same download twice.
        if (seen.has(name)) continue;
        seen.add(name);
        found.push({
          ...kind,
          name,
          // Relative to the release base. Never absolute — the base is the secret.
          url: `${tag}/${name}`,
          size: stat.size,
          sha256: sha256File(full),
        });
      }
    }
  }
  return found.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
}

/**
 * A desktop release may be deliberately partial (one platform can land later),
 * but it must never be a zero-artifact record. A missing or wrong bundle root
 * otherwise looks exactly like an intentional partial cut: the completeness
 * warning is non-blocking and the CLI exits 0. Keep this check after all
 * resolved roots have been scanned so a valid artifact in a secondary leg is
 * still accepted.
 */
export function assertRequestedDesktopArtifacts(
  version: string,
  artifacts: readonly ReleaseArtifact[],
  bundleDirs: readonly string[],
): void {
  if (artifacts.length > 0) return;
  const roots = bundleDirs.length > 0 ? bundleDirs.map((dir) => `    ${dir}`).join('\n') : '    (none)';
  throw new Error(
    `[record-release] REFUSING TO RECORD ${version}: no desktop artifact matching the requested ` +
      `version was found across the resolved bundle roots.\n` +
      `  Resolved roots:\n${roots}\n` +
      '  Build the requested desktop version before recording; a zero-artifact release is not a valid partial cut.',
  );
}

/** Bounded recursive file walk (depth-limited so a deep build tree can't wedge the scan). */
function walkFiles(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, maxDepth, depth + 1));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Find publishable mobile artifacts and describe them.
 *
 * Mobile is DIFFERENT from the desktop tauri artifacts in two ways that this
 * function exists to bridge:
 *
 *   1. They live in the SEPARATE `papercup-rust-mobile` repo, not in any tauri
 *      bundle root — so they take their own root (`mobileRoot`), not a
 *      `releaseBundleRoots` entry.
 *   2. Their built filenames carry NO version (`app-debug.apk`, not
 *      `Papercusp_0.0.9_…`). So — unlike `scanArtifacts`, which filters by a
 *      version substring — we record each under a SYNTHESIZED version+platform
 *      name (`Papercusp_${version}_android.apk`), url relative to the release tag
 *      like every other artifact. The publisher copies the real bytes to that
 *      name under the tag dir.
 *
 * iOS is DORMANT until its release builder emits the same requested-version,
 * source, path, size, and hash provenance contract. A raw unversioned IPA is not a
 * candidate: the 0.1.0 Android dry run found a July IPA and would otherwise have
 * relabeled it as 0.1.0 (D-005).
 */
export function scanMobileArtifacts(
  mobileRoot: string | null,
  version: string,
  tag: string,
  options: { skipAndroid?: boolean; productName?: string } = {},
): ReleaseArtifact[] {
  const found: ReleaseArtifact[] = [];
  for (const { src, outName } of scanMobileArtifactSources(mobileRoot, version, options)) {
    const kind = classifyArtifact(outName);
    if (!kind) continue;
    const size = fs.statSync(src).size;
    // Same residual-plausibility floor as scanArtifacts (EI-18673480587329034): a
    // truncated/partial APK or IPA build is exactly as publishable-looking, and
    // exactly as broken, as a truncated desktop installer.
    if (isImplausiblyTiny(size)) {
      console.warn(
        `  ⚠ SKIPPING ${outName} (${src}) — only ${size} byte(s), far below any real mobile build ` +
          `(floor: ${MIN_PLAUSIBLE_ARTIFACT_BYTES.toLocaleString()} bytes). Likely a truncated or ` +
          `partial build artifact — recording it would publish a download that cannot install.`,
      );
      continue;
    }
    found.push({
      ...kind,
      name: outName,
      url: `${tag}/${outName}`,
      size,
      sha256: sha256File(src),
    });
  }
  return found.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
}

function mobileGitState(mobileRoot: string): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['-C', mobileRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const status = execFileSync(
      'git',
      ['-C', mobileRoot, 'status', '--porcelain', '--untracked-files=normal'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return { commit, dirty: status.length > 0 };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot resolve Android source identity in ${mobileRoot}: ${detail}`);
  }
}

function parseAndroidReleaseProvenance(file: string): AndroidReleaseProvenance {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Android release provenance ${file}: ${detail}`);
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid Android release provenance ${file}: expected an object`);
  }
  return value as AndroidReleaseProvenance;
}

/**
 * Resolve Android only through the build-produced provenance manifest. The
 * synthesized public version is therefore a verified property of these exact
 * bytes, not a label applied to whichever unversioned Gradle output is newest.
 */
export function scanProvenancedAndroidArtifactSources(
  mobileRoot: string,
  version: string,
  productName = 'Papercusp',
): Array<{ src: string; outName: string }> {
  const artifactStem = assertPapercuspMobileProductName(productName);
  const manifestFile = path.join(mobileRoot, ANDROID_RELEASE_PROVENANCE_PATH);
  const rawAndroidPaths = [
    ANDROID_RELEASE_APK_PATH,
    ANDROID_RELEASE_AAB_PATH,
    'android/app/build/outputs/apk/debug/app-debug.apk',
  ].map((relative) => path.join(mobileRoot, relative));
  if (!fs.existsSync(manifestFile)) {
    if (rawAndroidPaths.some((file) => fs.existsSync(file))) {
      throw new Error(
        `Android build output exists without ${ANDROID_RELEASE_PROVENANCE_PATH}; ` +
          `rebuild with PAPERCUP_RELEASE_VERSION=${version} or pass --skip-android explicitly.`,
      );
    }
    return [];
  }

  const manifest = parseAndroidReleaseProvenance(manifestFile);
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported Android provenance schemaVersion ${String(manifest.schemaVersion)}`);
  }
  if (manifest.releaseVersion !== version) {
    throw new Error(
      `Android provenance releaseVersion ${String(manifest.releaseVersion)} does not match requested ${version}`,
    );
  }
  if (manifest.sourceDirty !== false) {
    throw new Error('Android provenance sourceDirty must be false');
  }
  if (!/^[0-9a-f]{40,64}$/.test(manifest.sourceCommit ?? '')) {
    throw new Error('Android provenance sourceCommit is missing or malformed');
  }
  if (!manifest.builtAt || Number.isNaN(Date.parse(manifest.builtAt))) {
    throw new Error('Android provenance builtAt is missing or malformed');
  }

  const source = mobileGitState(mobileRoot);
  if (source.dirty) {
    throw new Error(`Android source tree ${mobileRoot} is dirty; provenance is no longer publishable`);
  }
  if (source.commit !== manifest.sourceCommit) {
    throw new Error(
      `Android provenance sourceCommit ${manifest.sourceCommit} does not match current HEAD ${source.commit}`,
    );
  }

  const expected: Array<{
    key: 'apk' | 'aab';
    relativePath: string;
    outName: string;
  }> = [
    { key: 'apk', relativePath: ANDROID_RELEASE_APK_PATH, outName: `${artifactStem}_${version}_android.apk` },
    { key: 'aab', relativePath: ANDROID_RELEASE_AAB_PATH, outName: `${artifactStem}_${version}_android.aab` },
  ];
  return expected.map(({ key, relativePath, outName }) => {
    const entry = manifest.artifacts?.[key];
    if (!entry || entry.kind !== key || entry.path !== relativePath) {
      throw new Error(`Android provenance ${key} must name canonical path ${relativePath}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < MIN_PLAUSIBLE_ARTIFACT_BYTES) {
      throw new Error(`Android provenance ${key} has implausible size ${String(entry.size)}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
      throw new Error(`Android provenance ${key} sha256 is missing or malformed`);
    }
    const src = path.join(mobileRoot, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(src);
    } catch {
      throw new Error(`Android provenance ${key} artifact is missing: ${src}`);
    }
    if (!stat.isFile() || stat.size !== entry.size) {
      throw new Error(
        `Android provenance ${key} size ${entry.size} does not match ${src} (${stat.size} bytes)`,
      );
    }
    const actualHash = sha256File(src);
    if (actualHash !== entry.sha256) {
      throw new Error(
        `Android provenance ${key} sha256 ${entry.sha256} does not match ${src} (${actualHash})`,
      );
    }
    return { src, outName };
  });
}

/**
 * The source-path ↔ published-name pairs behind `scanMobileArtifacts` — exported
 * separately because the UPLOADER needs it too: mobile artifacts are recorded
 * under synthesized versioned names (`Papercusp_0.0.9_android.apk`) that do NOT
 * exist on disk, so whoever pushes bytes must know which real file maps to which
 * object key. `bin/upload-mobile-release.sh` consumes this via `--scan-mobile`
 * (TSV: src TAB outName) so the candidate list lives in exactly one place.
 */
export function scanMobileArtifactSources(
  mobileRoot: string | null,
  version: string,
  options: { skipAndroid?: boolean; productName?: string } = {},
): Array<{ src: string; outName: string }> {
  if (!mobileRoot || !fs.existsSync(mobileRoot)) return [];
  return options.skipAndroid
    ? []
    : scanProvenancedAndroidArtifactSources(mobileRoot, version, options.productName);
}

/**
 * Product identity becomes part of an R2 object key, so accept a human-readable
 * filename stem but reject separators/control characters that could escape the
 * version directory or corrupt the scanner's TSV contract.
 */
export function validateMobileProductName(productName: string): string {
  const value = productName.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(value)) {
    throw new Error(
      `Invalid mobile product name ${JSON.stringify(productName)}; expected 1-64 letters, numbers, spaces, underscores, or hyphens`,
    );
  }
  return value;
}

/**
 * The release registry and public release bucket/page are Papercusp-owned. A
 * product name is allowed to reach the mobile scanner only when it names this
 * product; otherwise a foreign app can be recorded as a Papercusp release.
 * Keep the generic syntax validator separate so callers can still validate a
 * product stem before handing it to a product-specific release pipeline.
 */
export function assertPapercuspMobileProductName(productName: string): string {
  const value = validateMobileProductName(productName);
  if (value !== PAPERCUSP_RELEASE_PRODUCT_NAME) {
    throw new Error(
      `[record-release] REFUSING NON-PAPERCUSP MOBILE PRODUCT ${JSON.stringify(value)}: ` +
        `the Papercusp release registry and public bucket/page accept only ` +
        `"${PAPERCUSP_RELEASE_PRODUCT_NAME}". Use a product-specific release pipeline for other apps.`,
    );
  }
  return value;
}

/**
 * Where the "the releases page is currently held back" bit lives.
 *
 * It is STATE, not an argument, on purpose. If holding were only a flag on the
 * regenerate command, then the ordinary act of cutting a release — regenerate,
 * publish — would silently restore the full page while the owner believed it was
 * still held. The whole point of a hold is that it survives until it is lifted
 * explicitly, so `--regenerate` READS this and re-renders the holding page.
 *
 * It sits in ~/.papercusp/ because that is already where this rail keeps its
 * operator-local config (release-host.env, r2.env) — this is deployment state
 * for one box's publish rail, not application data, and putting it in Postgres
 * would mean a schema migration for a single boolean that only the publish
 * scripts ever read.
 */
export function holdMarkerPath(): string {
  return path.join(os.homedir(), '.papercusp', 'release-page-held');
}

/** True when the releases page is currently held back behind the holding page. */
export function isPageHeld(): boolean {
  return fs.existsSync(holdMarkerPath());
}

/** Set/clear the hold. Returns the new state. */
export function setPageHeld(held: boolean): boolean {
  const p = holdMarkerPath();
  if (held) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `held since ${new Date().toISOString()}\n`, 'utf8');
  } else if (fs.existsSync(p)) {
    fs.rmSync(p);
  }
  return held;
}

/**
 * The independently renderable parts of the releases site (WI-10003694).
 *   index      → index.html + history.json (the page testers open, and the app's feed)
 *   changes    → changes/<release>.{html,json} (per-release Project History)
 *   assets     → assets/ (the shared Project History renderer bundle)
 *   plans      → plans/<slug>.html
 *   work-items → work-items/<id>.html (~28k pages — the expensive surface)
 */
export const SITE_SURFACES = ['index', 'changes', 'assets', 'plans', 'work-items'] as const;
export type SiteSurface = (typeof SITE_SURFACES)[number];

export interface SiteScope {
  surfaces: ReadonlySet<SiteSurface>;
  /** True when the caller narrowed the render with --only: a judged, audited FORCE. */
  forced: boolean;
  reason: string | null;
}

export const FULL_SITE_SCOPE: SiteScope = {
  surfaces: new Set(SITE_SURFACES),
  forced: false,
  reason: null,
};

/**
 * `--only <surface,…> --reason "<why>"` — the generic force (owner #821, 2026-09-28: "there
 * should be a generic force feature that agents can use when they judge appropriate").
 *
 * The default regenerate renders everything, and that stays the safe default: a caller that
 * guesses the blast radius wrong leaves stale pages live. But an agent that KNOWS what changed
 * (an Instructions edit touches index.html only) may skip the ~28k-page render. It must say why,
 * and every such run is written to the audit log — so the judgement is the agent's, and it is
 * visible afterwards. The publish side needs no force: it already uploads only changed files.
 */
export function parseSiteScope(argv: string[]): SiteScope | { error: string } {
  const onlyAt = argv.indexOf('--only');
  if (onlyAt < 0) return FULL_SITE_SCOPE;
  const raw = argv[onlyAt + 1];
  if (!raw || raw.startsWith('--')) {
    return { error: `--only needs a comma-separated list of: ${SITE_SURFACES.join(', ')}` };
  }
  const requested = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const unknown = requested.filter((part) => !(SITE_SURFACES as readonly string[]).includes(part));
  if (unknown.length > 0 || requested.length === 0) {
    return {
      error: `--only: unknown surface(s) ${unknown.join(', ') || '<none>'} — choose from ${SITE_SURFACES.join(', ')}`,
    };
  }
  const reason = arg(argv, '--reason')?.trim() ?? '';
  if (reason.length < 8 || reason.startsWith('--')) {
    return {
      error:
        '--only is a FORCE: it skips re-rendering the rest of the site, so it needs --reason "<why only ' +
        'these surfaces changed>" (it is written to the audit log).',
    };
  }
  return { surfaces: new Set(requested as SiteSurface[]), forced: true, reason };
}

/** Regenerate the static site from the registry (every release, newest first). */
export async function generateSite(
  sql: postgres.Sql,
  scope: Scope,
  outDir: string,
  siteScope: SiteScope = FULL_SITE_SCOPE,
): Promise<{ pages: number; written: number; unchanged: number }> {
  const want = (surface: SiteSurface) => siteScope.surfaces.has(surface);
  // WI-10003694: write a page only when its bytes changed, so an unchanged page keeps its
  // mtime and the publisher (and `aws s3 sync`) skips it.
  const tally = new SiteWriteTally();
  // All pages in this publication use one identity snapshot. Resolving it per
  // work-item page spawns thousands of redundant git-config subprocesses.
  const redact = identityLiterals();

  /**
   * FAIL CLOSED HERE — in the SHARED renderer, not in one caller.
   *
   * EI-20594446930640654 added this rail to `regenerateOnly()`, which is one of TWO
   * callers of this function. The FULL RECORD path (`run()`) reaches these same
   * `fs.writeFileSync` calls with the same empty redaction set and had NO such check,
   * so it rendered the entire site unscrubbed, exited 0, and printed "recorded".
   *
   * Measured 2026-09-22: a full record run without the owner env produced 28,304 pages
   * carrying 375 raw owner-name occurrences, with no warning of any kind. The leak
   * surfaced only at the publish gate afterwards — and only because the env happened to
   * be exported for THAT step and not this one. That is precisely the failure the
   * original fix describes, reproduced verbatim on the sibling code path, because the
   * guard was attached to a CALLER instead of to the thing that actually renders.
   *
   * So the check belongs where the literals are resolved and the bytes are written: one
   * rail, covering every present and future caller. It runs before the first mkdir, so
   * no unscrubbed byte reaches disk. `regenerateOnly()` keeps its own earlier check for
   * its cleaner exit code (1, not a throw); this is the authoritative backstop.
   */
  if (!hasOwnerNameLiteral(redact)) {
    throw new Error(
      "REFUSING TO RENDER — no owner-name literal resolved, so the owner's name cannot be " +
        'redacted from these pages and the site would ship unscrubbed.\n' +
        '  Cause: `git config user.name` is unset or belongs to an automation (a bot/CI identity).\n' +
        `  Fix:   set ${OWNER_NAME_ENV}='<the owner's name>' for this run — it is read at run\n` +
        '         time and never stored, because writing the name into a source file to search\n' +
        '         for it would itself be the leak, committed to git forever.',
    );
  }

  // Every surface but `assets` renders registry content; an assets-only force skips the reads.
  const needsRegistry = [...siteScope.surfaces].some((surface) => surface !== 'assets');
  const rows = needsRegistry ? await listReleases(sql, scope.workspaceId) : [];
  const hydratedAll: HydratedRelease[] = [];
  for (const row of rows) {
    const { items, plans, internalCount } = await hydrateRelease(sql, scope, row);
    hydratedAll.push({ row, items, plans, internalCount });
  }

  const opts = { generatedAt: new Date(), analytics: POSTHOG_PUBLIC_DEFAULTS, redact };
  let pages = 0;
  if (want('assets')) await buildReleaseHistoryAssets(outDir);
  if (want('changes')) {
    fs.mkdirSync(path.join(outDir, 'changes'), { recursive: true });
    for (const release of hydratedAll) {
      const stem = releaseHistoryStem(release.row.version, release.row.channel);
      tally.write(path.join(outDir, 'changes', `${stem}.json`), JSON.stringify(releaseProjectHistory(release, scope, opts.redact)));
      tally.write(path.join(outDir, 'changes', `${stem}.html`), renderProjectHistoryPage(release, opts));
      pages++;
    }
  }
  if (want('index')) {
    const held = isPageHeld();
    const indexHtml = held ? renderHoldingHtml(opts) : renderIndexHtml(hydratedAll, opts);
    assertReleaseHistoryIndexSizeBudget(indexHtml);
    fs.mkdirSync(outDir, { recursive: true });
    // ── The hold swaps ONLY index.html. ──────────────────────────────────────
    // history.json and the plan pages are still written, and the installers on the
    // host are untouched, so: the in-app Update Center keeps working (it reads
    // history.json — blanking it would empty every installed app's update
    // history), direct installer links keep resolving, and restoring the page is
    // just re-rendering this one file. A hold hides the page; it does not unship a
    // release.
    tally.write(path.join(outDir, 'index.html'), indexHtml);
    if (held) {
      console.log(
        '[record-release] ⚠ HOLDING PAGE is active — index.html says "NEXT UPDATE COMING SOON".\n' +
          '                 history.json, the plan pages and every installer are unchanged.\n' +
          '                 Restore the real page with: bin/restore-release-page.sh',
      );
    }
    // The machine-readable twin of the page — what the in-app Update Center reads.
    // Same registry, same scrub, published to the same host as latest.json.
    tally.write(path.join(outDir, 'history.json'), renderHistoryJson(hydratedAll, opts));
    pages++;
  }

  // One page per plan, newest release wins when a plan spans several (it carries
  // the most recent status).
  if (want('plans')) {
    fs.mkdirSync(path.join(outDir, 'plans'), { recursive: true });
    const seen = new Set<string>();
    for (const rel of hydratedAll) {
      for (const plan of rel.plans) {
        if (seen.has(plan.slug)) continue;
        seen.add(plan.slug);
        const html = renderPlanPageHtml(plan, { ...opts, version: rel.row.version });
        tally.write(path.join(outDir, planPagePath(plan.slug)), html);
        pages++;
      }
    }
  }

  // One page per work item. A frozen item id can appear in more than one release;
  // listReleases() is newest-first, so the first occurrence carries the freshest
  // canonical metadata and identifies the most recent release that shipped it.
  if (want('work-items')) {
    fs.mkdirSync(path.join(outDir, 'work-items'), { recursive: true });
    const seenItems = new Set<string>();
    for (const rel of hydratedAll) {
      for (const item of rel.items) {
        if (seenItems.has(item.id)) continue;
        seenItems.add(item.id);
        const plan = item.planSlug
          ? rel.plans.find((candidate) => candidate.slug === item.planSlug) ?? null
          : null;
        const html = renderWorkItemPageHtml(item, {
          ...opts,
          version: rel.row.version,
          channel: rel.row.channel,
          plan,
        });
        tally.write(path.join(outDir, workItemPagePath(item.id)), html);
        pages++;
      }
    }
  }
  return { pages, written: tally.written, unchanged: tally.unchanged };
}

/**
 * Durable record of a scoped (--only) regenerate, written BEFORE anything renders. Fail-closed:
 * a force that cannot be recorded does not run. The registry connection is required to render
 * at all, so this costs no availability.
 */
export async function auditScopedRegenerate(
  sql: postgres.Sql,
  scope: Scope,
  siteScope: SiteScope,
  actor: string = process.env.PAPERCUSP_SID || process.env.PAPERCUSP_OWNER_ID || 'record-release-cli',
): Promise<void> {
  const surfaces = [...siteScope.surfaces];
  const skipped = SITE_SURFACES.filter((surface) => !siteScope.surfaces.has(surface));
  await sql.unsafe(
    `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      `release-site-scoped-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      Date.now(),
      actor,
      'release:site-regenerate-scoped',
      'release-history-site',
      JSON.stringify({ surfaces, skipped, reason: siteScope.reason, workItem: 'WI-10003694' }),
      scope.workspaceId,
    ],
  );
}

export async function run(opts: RecordOpts): Promise<number> {
  // Check before opening Postgres or scanning multi-gigabyte artifact roots. A
  // missing changelog is a request-shape error, so the default path must fail
  // immediately instead of doing almost all the work and then looking successful.
  if (!opts.genChangelog) {
    const changelogError = validateRecordChangelog(opts.changelogMd, opts.allowNoChangelog);
    if (changelogError) {
      console.error(changelogError);
      return 1;
    }
  }
  // Keep direct callers subject to the same product boundary as the CLI and
  // --scan-mobile path. The registry is workspace-level, so harness filtering
  // cannot isolate a foreign product once this function records the row.
  assertPapercuspMobileProductName(opts.mobileProductName);
  const sql = postgres(getHarnessAdminUrl(), { max: 1 });
  try {
    const tag = releaseTag(opts.version, opts.channel);
    const priorReleases = await listReleases(sql, opts.scope.workspaceId, opts.channel);
    const reRecordingExistingVersion = priorReleases.some((release) => release.version === opts.version);

    const prev = await previousCutAt(
      sql,
      opts.scope.workspaceId,
      opts.channel,
      opts.cutAt,
      opts.version,
    );
    const from = resolveChangelogWindowStart(
      opts.cutAt,
      prev,
      opts.since,
      reRecordingExistingVersion,
    );
    if (!opts.since && !prev) {
      console.log(
        `[record-release] no previous ${opts.channel} release on record — bounding the window at ` +
          `${DEFAULT_RELEASE_LOOKBACK_DAYS}d before the cut (${from.toISOString()}). Pass --since to override.`,
      );
    } else if (
      !opts.since &&
      !reRecordingExistingVersion &&
      prev &&
      from.getTime() > prev.getTime()
    ) {
      console.log(
        `[record-release] previous ${opts.channel} release on record is older than the ` +
          `${DEFAULT_RELEASE_LOOKBACK_DAYS}d default window; bounding at ${from.toISOString()}. ` +
          `Pass --since ${prev.toISOString()} to include the full gap.`,
      );
    }

    const snap = await snapshotWindow(sql, opts.scope, from.getTime(), opts.cutAt.getTime());

    // ── Changelog draft (owner ask #4) — generate, then STOP. ────────────────
    // Generation and recording are separate decisions on purpose: the draft is a
    // model's paraphrase of work-item titles, and a model handed "the work is done"
    // will happily write "it works now" for something that was never verified on the
    // user's platform (exactly the lie 0.0.9 nearly shipped for Windows auto-update).
    // So we write a DRAFT a human/agent reviews, then record THAT file via
    // --changelog-file. See changelog-generate.ts's header.
    if (opts.genChangelog) {
      const prevRows = await listReleases(sql, opts.scope.workspaceId, opts.channel);
      const previousVersion =
        prevRows.find((r) => r.cutAt < opts.cutAt)?.version ?? null;
      const draftPath = path.join(
        path.dirname(opts.outDir),
        `changelog-draft-${opts.version}-${opts.channel}.md`,
      );
      const res = await generateChangelog(
        {
          version: opts.version,
          channel: opts.channel,
          previousVersion,
          items: snap.items,
          plans: snap.plans,
          internalCount: snap.internalIds.length,
        },
        draftPath,
        { force: opts.forceChangelog },
      );
      console.log(`[record-release] changelog draft (${res.source}) → ${res.draftPath}`);
      if (res.warnings.length > 0) {
        console.log(`\n⚠ ${res.warnings.length} thing(s) to review before recording — fix these in the draft:`);
        for (const w of res.warnings) console.log(w);
      }
      console.log('\n  Review + edit the claims it cannot stand behind, then record with:');
      console.log(
        `    tsx apps/operator/lib/release/record-release-cli.ts --version ${opts.version} ` +
          `--channel ${opts.channel} --git-sha <sha> --changelog-file ${res.draftPath}`,
      );
      console.log('\n──────── draft ────────');
      console.log(res.md);
      console.log('───────────────────────');
      return 0;
    }

    const desktopArtifacts = scanArtifacts(opts.bundleDirs, opts.version, tag);
    try {
      assertRequestedDesktopArtifacts(opts.version, desktopArtifacts, opts.bundleDirs);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    // Mobile artifacts live in a separate repo + are not version-named — see
    // scanMobileArtifacts. Merged into the same record; the page + history.json
    // give `product:'mobile'` its own section, and the desktop auto-update
    // manifest (latest.json) never sees them (it is desktop-platform-only).
    const mobileArtifacts = scanMobileArtifacts(opts.mobileRoot, opts.version, tag, {
      skipAndroid: opts.skipAndroid,
      productName: opts.mobileProductName,
    });
    const artifacts = [...desktopArtifacts, ...mobileArtifacts];

    // A release that records only SOME product×platform slots must never look like
    // a complete one. 0.0.8 went out advertising itself to every beta tester while
    // carrying linux artifacts alone — a Mac or Windows tester had nothing to
    // download, and nothing anywhere said so. The old check here covered ONLY the
    // gui product, so a version with a linux Server but no mac/windows Server passed
    // silently too. computeReleaseCompleteness covers BOTH products across all three
    // desktop platforms. A partial cut is refused unless a captured owner directive
    // approves this version, channel, and each omitted platform; the directive id is
    // recorded with the row for the publication preflight to re-check. Mobile is
    // reported separately below and is never part of the required desktop set.
    const completeness = computeReleaseCompleteness(artifacts);
    let partialScopeApproval: OwnerDirectiveRow | null = null;
    if (!completeness.complete) {
      partialScopeApproval =
        opts.ownerApprovedPartialScopeOrderId == null
          ? null
          : await getOwnerDirective(opts.ownerApprovedPartialScopeOrderId, sql);
      const refusal = incompleteDesktopScopeRefusal(
        opts.version,
        opts.channel,
        completeness.missing,
        partialScopeApproval,
        opts.scope.workspaceId,
      );
      if (refusal) {
        console.error(refusal);
        console.error(formatCompletenessAlert(opts.version, opts.channel, completeness.missing));
        console.error(`  Scanned roots:\n${opts.bundleDirs.map((d) => `    ${d}`).join('\n')}`);
        return 1;
      }
      console.warn(formatCompletenessAlert(opts.version, opts.channel, completeness.missing));
      console.warn(`  owner approval directive: #${partialScopeApproval?.id}`);
      console.warn(`  Scanned roots:\n${opts.bundleDirs.map((d) => `    ${d}`).join('\n')}`);
    }

    // Mobile is never part of the required desktop set (a desktop-only cut is
    // "complete"), so computeReleaseCompleteness can't see a mobile drop — 0.0.12
    // silently shipped without the Android/iOS 0.0.11 carried (WI-5583). Compare
    // against the immediately-previous same-channel release (the exact predicate
    // previousCutAt uses: a different version, cut before this one) and warn loudly
    // on a REGRESSION. NON-BLOCKING — a deliberate mobile skip is legal.
    const previousRelease = priorReleases.find(
      (r) => r.version !== opts.version && r.cutAt < opts.cutAt,
    );
    const mobileReg = computeMobileRegression(artifacts, previousRelease?.artifacts ?? []);
    if (mobileReg.dropped.length > 0) {
      console.warn(
        formatMobileRegressionAlert(
          opts.version,
          opts.channel,
          previousRelease?.version ?? null,
          mobileReg.dropped,
        ),
      );
    }

    const row: ReleaseRow = {
      version: opts.version,
      channel: opts.channel,
      cutAt: opts.cutAt,
      publishedAt: null,
      changelogMd: opts.changelogMd,
      // The record states the fact — everything that went terminal in the window.
      // The PAGE decides what to show (it counts EI-* rather than listing them).
      workItemIds: [...snap.items.map((i) => i.id), ...snap.internalIds],
      planSlugs: snap.plans.map((p) => p.slug),
      artifacts,
      gitSha: opts.gitSha,
      cutBy: opts.cutBy,
      notes: partialScopeApproval ? partialScopeApprovalNote(partialScopeApproval.id) : null,
    };

    console.log(`[record-release] ${opts.version} (${opts.channel})`);
    console.log(`  window     : ${from.toISOString()} → ${opts.cutAt.toISOString()}`);
    console.log(`  work items : ${snap.items.length} user-facing, ${snap.internalIds.length} internal`);
    console.log(`  plans      : ${snap.plans.length}`);
    console.log(`  artifacts  : ${artifacts.length}${artifacts.length === 0 ? '  ⚠ none found on disk' : ''}`);
    for (const a of artifacts) {
      const sz = a.size >= 1e9 ? `${(a.size / 1e9).toFixed(2)} GB` : `${(a.size / 1e6).toFixed(1)} MB`;
      console.log(`      ${a.platform.padEnd(18)} ${a.name}  (${sz})`);
    }
    const mobilePlatforms = new Set(
      artifacts.filter((a) => a.product === 'mobile').map((a) => a.platform),
    );
    console.log(
      `  mobile     : android ${mobilePlatforms.has('android-universal') ? '✓' : '—'}  ·  ios ${
        mobilePlatforms.has('ios-arm64')
          ? '✓'
          : '— (dormant: needs Apple Developer enrollment for a signed .ipa)'
      }`,
    );
    console.log(`  changelog  : ${opts.changelogMd ? `${opts.changelogMd.length} chars` : '⚠ NONE'}`);

    if (opts.dryRun) {
      console.log('[record-release] --dry-run — nothing written.');
      return 0;
    }

    await recordRelease(sql, opts.scope.workspaceId, row);
    console.log('[record-release] recorded.');

    const { pages } = await generateSite(sql, opts.scope, opts.outDir);
    console.log(`[record-release] generated ${pages} page(s) → ${opts.outDir}`);
    console.log('[record-release] publish with: papercusp-desktop/bin/publish-release-history.sh');
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function arg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * Rebuild every page from the registry WITHOUT recording anything.
 *
 * The pages are a projection, so a fix to the RENDERER (a leak in the markup, a
 * wording change) must be re-publishable on its own. Without this, the only way to
 * regenerate is to re-record a release — which would silently re-snapshot the work
 * window against a NEW `now`, quietly rewriting which items a past release shipped.
 * A rendering fix must never be able to change history.
 */
export async function regenerateOnly(
  scope: Scope,
  outDir: string,
  siteScope: SiteScope = FULL_SITE_SCOPE,
): Promise<number> {
  /**
   * FAIL CLOSED BEFORE RENDERING — the generator must refuse on the same input its
   * gate refuses on (EI-20594446930640654).
   *
   * Both this renderer and gate-release-site depend on OWNER_NAME_ENV, and they used
   * to handle its ABSENCE in OPPOSITE directions: the gate exited 2 with "REFUSING TO
   * CERTIFY", while this path exited 0, printed "regenerated N page(s)", and wrote HTML
   * with the owner's name embedded in it. So the component that CREATES the leak was
   * silent and only the component that CHECKS for it failed closed — even though this
   * one has strictly MORE information (it knows it is about to render owner-tagged
   * work-item descriptions with an empty redaction set) and did strictly less with it.
   *
   * Measured: a regenerate with no owner env exited 0 after 235s and looked completely
   * successful; the leak surfaced only at a publish gate three steps later, and only
   * because the env happened to be set for THAT step and not this one. Pass it to both
   * and you never learn the trap exists.
   *
   * The check is here rather than inside generateSite so it costs nothing and, more
   * importantly, so no unscrubbed byte reaches the disk: an unscrubbed site is
   * indistinguishable from a good one on inspection.
   *
   * This covers --hold-page and --restore-page too, which route through here and
   * re-render every page (main() folds them into `regenerate`). That is deliberate:
   * they render the same owner-tagged corpus, so they need the same literal. It does
   * mean a caller of hold-release-page.sh must now export OWNER_NAME_ENV — the same
   * requirement publish-release-history.sh already documents.
   */
  if (!hasOwnerNameLiteral(identityLiterals())) {
    console.error(
      "[record-release] 🔴 REFUSING TO RENDER — no owner-name literal resolved, so the owner's " +
        'name cannot be redacted from these pages and the site would ship unscrubbed.\n' +
        '  Cause: `git config user.name` is unset or belongs to an automation (a bot/CI identity).\n' +
        `  Fix:   set ${OWNER_NAME_ENV}='<the owner's name>' for this run — it is read at run\n` +
        '         time and never stored, because writing the name into a source file to search\n' +
        '         for it would itself be the leak, committed to git forever.',
    );
    return 1;
  }

  const sql = postgres(getHarnessAdminUrl(), { max: 1 });
  try {
    if (siteScope.forced) {
      const surfaces = [...siteScope.surfaces].join(', ');
      console.error(
        `[record-release] ⚡ SCOPED REGENERATE (force) — rendering only: ${surfaces}.\n` +
          `                 reason: ${siteScope.reason}\n` +
          '                 Every other surface keeps its last-rendered bytes. Recorded in the audit log.',
      );
      await auditScopedRegenerate(sql, scope, siteScope);
    }
    const { pages, written, unchanged } = await generateSite(sql, scope, outDir, siteScope);
    console.log(
      `[record-release] regenerated ${pages} page(s) → ${outDir}  (registry untouched; ` +
        `${written} file(s) changed, ${unchanged} unchanged)`,
    );
    // Fire the completeness alert on regenerate too (WI-5515): re-rendering the
    // page after an incremental upload must still SURFACE what remains absent per
    // version, so a partial release is never silently normalized. NON-BLOCKING.
    await warnIncompleteReleases(sql, scope);
    // Same for a mobile regression (WI-5583) — a cut that lost a phone build its
    // predecessor had stays surfaced on every regenerate until it is confirmed or
    // the artifacts are recorded. NON-BLOCKING.
    await warnMobileRegressions(sql, scope);
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const version = arg(argv, '--version');
  // --hold-page / --restore-page flip the hold and then regenerate, so one
  // command leaves the output dir ready to publish in the requested state.
  const holdPage = argv.includes('--hold-page');
  const restorePage = argv.includes('--restore-page');
  if (holdPage && restorePage) {
    console.error('record-release-cli: --hold-page and --restore-page are mutually exclusive.');
    return 2;
  }
  const regenerate = argv.includes('--regenerate') || holdPage || restorePage;
  const siteScope = parseSiteScope(argv);
  if ('error' in siteScope) {
    console.error(`record-release-cli: ${siteScope.error}`);
    return 2;
  }
  if (siteScope.forced && !regenerate) {
    console.error('record-release-cli: --only applies to --regenerate/--hold-page/--restore-page; recording a release renders the full site.');
    return 2;
  }
  if (!version && !regenerate) {
    console.error('usage: record-release-cli --version <x.y.z> [--channel alpha] [--git-sha <sha>]');
    console.error('       [--changelog-file <path>] [--no-changelog] [--cut-at <iso>] [--since <iso>]');
    console.error('       [--bundle <dir>] [--out <dir>] [--dry-run]');
    console.error('       [--owner-approved-partial-scope <owner-directive-id>]');
    console.error('   changelog: record-release-cli --version <x.y.z> --generate-changelog [--force-changelog]');
    console.error('              # writes a reviewable draft from the window and STOPS (records nothing)');
    console.error('   or: record-release-cli --regenerate [--out <dir>]   # re-render pages only');
    console.error('       [--only index,changes,assets,plans,work-items --reason "<why>"]  # force: render just these (audited)');
    console.error('   or: record-release-cli --hold-page                  # swap index.html for "NEXT UPDATE COMING SOON"');
    console.error('   or: record-release-cli --restore-page               # put the real releases page back');
    console.error('       (both re-render; publish with papercusp-desktop/bin/publish-release-history.sh)');
    console.error('   or: record-release-cli --scan-mobile --version <x.y.z> [--mobile-product-name <name>] [--skip-android]');
    console.error('       # print provenanced mobile src↔name TSV for the uploader');
    return 2;
  }
  const opts = buildRunOpts(argv);
  // --scan-mobile: print the mobile source-path ↔ published-name pairs (TSV) and
  // stop. The uploader's door into the ONE candidate list (scanMobileArtifactSources).
  if (argv.includes('--scan-mobile')) {
    if (!opts.version) {
      console.error('usage: record-release-cli --scan-mobile --version <x.y.z> [--mobile-root <dir>]');
      return 2;
    }
    for (const { src, outName } of scanMobileArtifactSources(opts.mobileRoot, opts.version, {
      skipAndroid: opts.skipAndroid,
      productName: opts.mobileProductName,
    })) {
      console.log(`${src}\t${outName}`);
    }
    return 0;
  }
  if (holdPage || restorePage) {
    setPageHeld(holdPage);
    console.log(
      holdPage
        ? '[record-release] releases page HELD — regenerating index.html as the holding page.'
        : '[record-release] hold LIFTED — regenerating the real releases page.',
    );
  }
  if (regenerate) return regenerateOnly(opts.scope, opts.outDir, siteScope);
  return run(opts);
}

/**
 * Assemble the full RecordOpts from argv/env. PURE (no DB) so it is unit-testable
 * — and extracted from main() specifically to GUARD the opts wiring. main() used
 * to compute `mobileRoot` locally and then forget to include it in the run({...})
 * object, so `scanMobileArtifacts` was handed `undefined` and silently recorded
 * NO mobile artifact on every real cut. Every unit test passed; only an
 * end-to-end dry-run caught it. Building one object here (and asserting its fields
 * in the buildRunOpts test) makes that class of drop impossible to reintroduce
 * without a red test.
 */
export function buildRunOpts(argv: string[]): RecordOpts {
  const changelogFile = arg(argv, '--changelog-file');
  const changelogMd = changelogFile ? fs.readFileSync(changelogFile, 'utf8') : null;
  const cutAtRaw = arg(argv, '--cut-at');
  const sinceRaw = arg(argv, '--since');
  // The mac + windows legs land in the desktop app's own target tree, NOT in
  // CARGO_TARGET_DIR — so they need their own roots (see `releaseBundleRoots`).
  const desktopRoot = arg(argv, '--desktop-root') ?? resolveDesktopRoot();
  // The PRIMARY linux root is where build-linux-local.sh collects the artifacts to,
  // NOT where cargo built them (EI-18103803991060000). This also decides the default
  // `--out`, so the generated site lands beside the real artifacts — and matches
  // bin/publish-release-history.sh's default SITE_DIR, which uploads it.
  const bundleDir =
    arg(argv, '--bundle') ??
    process.env.PAPERCUSP_BUNDLE_DIR ??
    collectedLinuxBundleRoot(desktopRoot);
  const bundleDirs = releaseBundleRoots(bundleDir, desktopRoot);
  // Mobile (Android/iOS) artifacts live in the separate papercup-rust-mobile repo.
  // Ordinary recording opts into mobile through --mobile-root or the environment.
  // The uploader's --scan-mobile command still discovers the sibling by default.
  // Otherwise unrelated Android build residue can block a desktop-only cut.
  const mobileRoot =
    arg(argv, '--mobile-root') ?? process.env.PAPERCUSP_MOBILE_ROOT ??
    (argv.includes('--scan-mobile') ? resolveMobileRoot() : null);
  const mobileProductName = assertPapercuspMobileProductName(
    arg(argv, '--mobile-product-name') ?? process.env.PAPERCUSP_MOBILE_PRODUCT_NAME ?? 'Papercusp',
  );
  const ownerApprovalRaw = arg(argv, '--owner-approved-partial-scope');
  if (
    ownerApprovalRaw !== null &&
    (!Number.isSafeInteger(Number(ownerApprovalRaw)) || Number(ownerApprovalRaw) < 1)
  ) {
    throw new Error('--owner-approved-partial-scope must be a positive owner directive id.');
  }
  const ownerApprovedPartialScopeOrderId = ownerApprovalRaw === null ? null : Number(ownerApprovalRaw);
  const skipAndroid =
    argv.includes('--skip-android') || process.env.PAPERCUSP_SKIP_ANDROID === '1';
  const outDir = arg(argv, '--out') ?? path.join(bundleDir, 'release-history');
  const scope: Scope = {
    workspaceId: arg(argv, '--workspace') ?? 'papercusp-workspace',
    harnessSlug: arg(argv, '--harness') ?? 'papercusp',
  };
  return {
    version: (arg(argv, '--version') ?? '') as string,
    channel: arg(argv, '--channel') ?? 'alpha',
    gitSha: arg(argv, '--git-sha'),
    cutAt: cutAtRaw ? new Date(cutAtRaw) : new Date(),
    since: sinceRaw ? new Date(sinceRaw) : null,
    changelogMd,
    allowNoChangelog: argv.includes('--no-changelog'),
    ownerApprovedPartialScopeOrderId,
    bundleDirs,
    mobileRoot,
    mobileProductName,
    skipAndroid,
    outDir,
    scope,
    cutBy: arg(argv, '--cut-by') ?? process.env.PAPERCUSP_SESSION_ID ?? null,
    dryRun: argv.includes('--dry-run'),
    genChangelog: argv.includes('--generate-changelog'),
    forceChangelog: argv.includes('--force-changelog'),
  };
}

if (isCliEntry(import.meta.url)) {
  /**
   * Resolve the owner identity at the process boundary, before anything reaches
   * `identityLiterals()`. Same placement and same reasoning as gate-release-site.
   *
   * The stake here is the SCRUB rather than the gate, and it is the quieter of the two
   * failures: with no owner-name literal the scrub redacts NOTHING while still emitting a
   * complete-looking site. That is why the generator fails closed on `hasOwnerNameLiteral`
   * — this loader is what keeps that rail from firing on a correctly-configured box
   * merely because nobody remembered to source the config file first.
   */
  console.error(describeOwnerIdentityLoad(loadOwnerIdentityEnv()));
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[record-release] FATAL:', e instanceof Error ? e.stack : e);
      process.exit(1);
    });
}
